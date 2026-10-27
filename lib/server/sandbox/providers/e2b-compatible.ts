import 'server-only';

import { randomUUID } from 'node:crypto';
import {
  CommandExitError,
  FileNotFoundError,
  Sandbox,
  SandboxNotFoundError,
  type SandboxInfo,
} from 'e2b';

import { SandboxError, sandboxConflict } from '@/lib/sandbox/errors';
import {
  MAX_TEXT_FILE_BYTES,
  type SandboxProvider,
  type SandboxResource,
  type SandboxCommandInput,
  type SandboxCommandResult,
  type SandboxProfile,
  type DesktopAction,
} from '@/lib/sandbox/types';

import type { SandboxConfig } from '../config';
import { COMMAND_RUNNER, shellQuote } from '../command-runner';
import {
  WORKSPACE_EXCLUDES,
  WORKSPACE_FILE_RUNNER,
  WORKSPACE_ROOT,
  workspacePath,
} from '../workspace-archive';
import { CHECKPOINT_RUNNER } from '../checkpoint-runner';
import {
  checkpointPolicy,
  checkpointArchiveLimit,
  CHECKPOINT_TIMEOUT_MS,
  CHECKPOINT_MIN_LIFETIME_MS,
} from '../checkpoint-policy';
import { checkpointIO } from '../checkpoint-errors';
import { Readable } from 'node:stream';
import { TERMINAL_CLEANUP } from '../terminal-cleanup';
import { openSdkPreviewConnection } from '../preview-connection';

const REQUEST_TIMEOUT_MS = 30_000;

/** Candidate adapter; account/template compatibility must be established before rollout. */
export class E2BCompatibleSandboxProvider implements SandboxProvider {
  readonly capabilities = { pause: false, desktopStream: false } as const;

  constructor(private readonly config: SandboxConfig) {}

  private get options() {
    return {
      apiKey: this.config.apiKey,
      validateApiKey: false,
      domain: this.config.domain,
      apiUrl: this.config.apiUrl,
      debug: false,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    };
  }

  private metadata(operationId: string) {
    return { openmaic_connection: this.config.connectionId, openmaic_operation: operationId };
  }

  private matches(info: SandboxInfo, operationId: string): boolean {
    return Object.entries(this.metadata(operationId)).every(
      ([key, value]) => info.metadata[key] === value,
    );
  }

  async create(operationId: string, profile: SandboxProfile): Promise<SandboxResource> {
    const template = profile === 'desktop' ? this.config.desktopTemplate : this.config.template;
    if (!template) throw sandboxConflict('Runtime template is not configured.');
    const options = {
      ...this.options,
      metadata: this.metadata(operationId),
      timeoutMs: this.config.lifetimeMs,
      secure: true,
      network: { allowPublicTraffic: false },
    };
    const sandbox =
      profile === 'desktop'
        ? await (await import('@e2b/desktop')).Sandbox.create(template, options)
        : await Sandbox.create(template, options);
    return { id: sandbox.sandboxId, state: 'running' };
  }

  async find(operationId: string): Promise<SandboxResource[]> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const paginator = Sandbox.list({
      ...this.options,
      query: { metadata: this.metadata(operationId), state: ['running', 'paused'] },
      limit: 100,
    });
    const matches: SandboxResource[] = [];
    // A broken metadata filter must not silently adopt an unrelated sandbox.
    for (let page = 0; paginator.hasNext; page++) {
      if (page >= 20) throw sandboxConflict('Sandbox discovery exceeded its bounded search.');
      for (const info of await paginator.nextItems({ ...this.options, signal })) {
        if (this.matches(info, operationId))
          matches.push({ id: info.sandboxId, state: info.state });
      }
    }
    return matches;
  }

  private async ownedInfo(
    resourceId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<SandboxInfo | null> {
    let info: SandboxInfo;
    try {
      info = await checkpointIO(
        () => Sandbox.getInfo(resourceId, { ...this.options, signal }),
        signal,
      );
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return null;
      throw error;
    }
    if (!this.matches(info, operationId)) {
      throw sandboxConflict('Provider resource metadata does not match this environment.');
    }
    return info;
  }

  async inspect(resourceId: string, operationId: string): Promise<SandboxResource | null> {
    const info = await this.ownedInfo(resourceId, operationId);
    return info ? { id: info.sandboxId, state: info.state } : null;
  }

  async destroy(resourceId: string, operationId: string): Promise<void> {
    if (await this.inspect(resourceId, operationId)) {
      await Sandbox.kill(resourceId, this.options);
    }
  }

  private async connectionOptions(resourceId: string, operationId: string, signal?: AbortSignal) {
    const info = await this.ownedInfo(resourceId, operationId, signal);
    if (!info || info.state !== 'running') {
      throw sandboxConflict('Sandbox is not running. Reconcile its state before using files.');
    }
    if (info.network?.allowPublicTraffic !== false) {
      throw sandboxConflict(
        'Private sandbox ingress could not be confirmed. File access is refused.',
      );
    }
    // Reconnect must not extend a billable environment past its current lease.
    const remainingMs = Math.floor(info.endAt.getTime() - Date.now() - 1000);
    if (remainingMs < 1000) throw sandboxConflict('Sandbox lease is expiring.');
    return { ...this.options, timeoutMs: remainingMs, signal };
  }

  private async connect(resourceId: string, operationId: string, signal?: AbortSignal) {
    const options = await this.connectionOptions(resourceId, operationId, signal);
    return checkpointIO(() => Sandbox.connect(resourceId, options), signal);
  }

  private async removeTransfer(sandbox: Sandbox, path: string, signal?: AbortSignal) {
    const cleanupSignal = AbortSignal.timeout(5_000);
    const cleanup = sandbox.files
      .remove(path, { requestTimeoutMs: 5_000, signal: cleanupSignal })
      .catch(() => {});
    // Cleanup may continue best effort after cancellation, without retaining the caller's lock.
    await checkpointIO(
      () => cleanup,
      signal ? AbortSignal.any([signal, cleanupSignal]) : cleanupSignal,
    ).catch(() => {});
  }

  private fileFailure(error: unknown): never {
    if (error instanceof CommandExitError) {
      if (error.exitCode === 44)
        throw new SandboxError('SANDBOX_FILE_NOT_FOUND', 404, 'Project file not found.');
      if (error.exitCode === 47)
        throw sandboxConflict(
          'The file changed or the destination already exists. Reload the workspace.',
          'WORKSPACE_FILE_CONFLICT',
        );
      if (error.exitCode === 45)
        throw new SandboxError(
          'SANDBOX_FILE_ENCODING',
          422,
          'This endpoint reads and writes UTF-8 files only.',
        );
      if (error.exitCode === 46)
        throw new SandboxError(
          'SANDBOX_FILE_REFUSED',
          422,
          'Project path is not a regular file, exceeds its size limit, or cannot be accessed.',
        );
    }
    throw error;
  }

  async readText(
    resourceId: string,
    operationId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const sandbox = await this.connect(resourceId, operationId, signal);
    const transfer = `/tmp/openmaic-file-${randomUUID()}`;
    try {
      await checkpointIO(
        () =>
          sandbox.commands.run(
            `python3 -c ${shellQuote(WORKSPACE_FILE_RUNNER)} read ${shellQuote(Buffer.from(workspacePath(path)).toString('base64'))} ${shellQuote(transfer)}`,
            { timeoutMs: 30_000, requestTimeoutMs: 35_000, signal },
          ),
        signal,
      );
      return await this.readUtf8(resourceId, operationId, transfer, MAX_TEXT_FILE_BYTES, signal);
    } catch (error) {
      return this.fileFailure(error);
    } finally {
      await this.removeTransfer(sandbox, transfer, signal);
      signal?.throwIfAborted();
    }
  }

  private async readUtf8(
    resourceId: string,
    operationId: string,
    path: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const sandbox = await this.connect(resourceId, operationId, signal);
    const local = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const readSignal = signal ? AbortSignal.any([signal, local]) : local;
    try {
      const stream = await checkpointIO(
        () =>
          sandbox.files.read(path, {
            format: 'stream',
            requestTimeoutMs: REQUEST_TIMEOUT_MS,
            signal: readSignal,
          }),
        readSignal,
      );
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await checkpointIO(() => reader.read(), readSignal);
          if (done) break;
          size += value.byteLength;
          if (size > limit) {
            throw new SandboxError(
              'SANDBOX_FILE_TOO_LARGE',
              413,
              'File exceeds the permitted read size.',
            );
          }
          chunks.push(value);
        }
      } finally {
        const closing = reader.cancel().catch(() => {});
        if (!readSignal.aborted) await checkpointIO(() => closing, readSignal).catch(() => {});
        reader.releaseLock();
      }
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        throw new SandboxError(
          'SANDBOX_FILE_ENCODING',
          422,
          'This endpoint reads UTF-8 text files only.',
        );
      }
    } catch (error) {
      if (error instanceof FileNotFoundError) {
        throw new SandboxError('SANDBOX_FILE_NOT_FOUND', 404, 'Sandbox file not found.');
      }
      throw error;
    }
  }

  async startCommand(resourceId: string, operationId: string, input: SandboxCommandInput) {
    const sandbox = await this.connect(resourceId, operationId);
    const spec = Buffer.from(JSON.stringify(input)).toString('base64');
    const handle = await sandbox.commands.run(
      `python3 -u -c ${shellQuote(COMMAND_RUNNER)} ${shellQuote(spec)}`,
      {
        background: true,
        timeoutMs: Math.min(input.timeoutMs + 15_000, 3_600_000),
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      },
    );
    // The remote supervisor, not this SDK stream, owns command timeout and output.
    await handle.disconnect();
  }

  async readCommand(
    resourceId: string,
    operationId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<SandboxCommandResult> {
    let value: unknown;
    try {
      value = JSON.parse(
        await this.readUtf8(
          resourceId,
          operationId,
          `/tmp/openmaic-commands/${id}/status.json`,
          2 * MAX_TEXT_FILE_BYTES,
          signal,
        ),
      );
    } catch (error) {
      if (error instanceof SandboxError && error.code === 'SANDBOX_FILE_NOT_FOUND') {
        return { id, state: 'unknown', stdout: '', stderr: '', exitCode: null, truncated: false };
      }
      throw error;
    }
    const r = value as Partial<SandboxCommandResult> | null;
    if (
      !r ||
      r.id !== id ||
      !['starting', 'running', 'exited', 'cancelled', 'timed_out', 'failed'].includes(
        r.state ?? '',
      ) ||
      typeof r.stdout !== 'string' ||
      typeof r.stderr !== 'string' ||
      typeof r.truncated !== 'boolean' ||
      !(r.exitCode === null || Number.isInteger(r.exitCode))
    ) {
      throw sandboxConflict('Command status is unavailable or invalid.');
    }
    return {
      id,
      state: r.state!,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode!,
      truncated: r.truncated,
    };
  }

  async cancelCommand(resourceId: string, operationId: string, id: string) {
    const sandbox = await this.connect(resourceId, operationId);
    // Creating the cancellation marker is idempotent. The supervisor consumes it.
    await sandbox.files.makeDir(`/tmp/openmaic-commands/${id}`);
    await sandbox.files.write(`/tmp/openmaic-commands/${id}/cancel`, 'cancel');
    // If a timed-out start never claimed its operation, commit a cancelled receipt.
    // A late original start then sees the same exclusive claim and cannot execute.
    const spec = Buffer.from(
      JSON.stringify({ id, command: ':', cwd: WORKSPACE_ROOT, timeoutMs: 100 }),
    ).toString('base64');
    await sandbox.commands.run(`python3 -c ${shellQuote(COMMAND_RUNNER)} ${shellQuote(spec)}`, {
      timeoutMs: 5000,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
  }

  async desktopScreenshot(resourceId: string, operationId: string): Promise<Uint8Array> {
    const { Sandbox: Desktop } = await import('@e2b/desktop');
    const desktop = await Desktop.connect(
      resourceId,
      await this.connectionOptions(resourceId, operationId),
    );
    // The SDK helper removes its temporary file without awaiting cleanup and
    // offers no per-read deadline. Use the same template tools with bounded I/O.
    const path = `/tmp/openmaic-screenshot-${randomUUID()}.png`;
    await desktop.commands.run(`scrot --pointer ${shellQuote(path)}`, {
      timeoutMs: REQUEST_TIMEOUT_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const stream = await desktop.files.read(path, {
        format: 'stream',
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) throw sandboxConflict('Desktop screenshot exceeded 4 MiB.');
        chunks.push(value);
      }
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      await desktop.files.remove(path, { requestTimeoutMs: REQUEST_TIMEOUT_MS }).catch(() => {});
    }
    return Buffer.concat(chunks);
  }

  async desktopAction(resourceId: string, operationId: string, action: DesktopAction) {
    const { Sandbox: Desktop } = await import('@e2b/desktop');
    const desktop = await Desktop.connect(
      resourceId,
      await this.connectionOptions(resourceId, operationId),
    );
    if (action.type === 'write') await desktop.write(action.text);
    else if (action.type === 'press') await desktop.press(action.keys);
    else {
      await desktop.moveMouse(action.x, action.y);
      if (action.type === 'click') await desktop.leftClick();
    }
  }

  async createTerminal(
    resourceId: string,
    operationId: string,
    id: string,
    cols: number,
    rows: number,
  ) {
    const sandbox = await this.connect(resourceId, operationId);
    const handle = await sandbox.pty.create({
      cols,
      rows,
      cwd: WORKSPACE_ROOT,
      timeoutMs: this.config.lifetimeMs,
      envs: { OPENMAIC_TERMINAL_ID: id },
      onData: () => {},
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    await handle.disconnect();
    return handle.pid;
  }

  async findTerminal(resourceId: string, operationId: string, id: string, signal?: AbortSignal) {
    const sandbox = await this.connect(resourceId, operationId, signal);
    const matches = (
      await checkpointIO(
        () => sandbox.commands.list({ requestTimeoutMs: REQUEST_TIMEOUT_MS, signal }),
        signal,
      )
    ).filter((p) => p.envs.OPENMAIC_TERMINAL_ID === id);
    if (matches.length > 1) throw sandboxConflict('Terminal allocation is ambiguous.');
    return matches[0]?.pid ?? null;
  }

  async terminalInput(resourceId: string, operationId: string, pid: number, data: string) {
    const sandbox = await this.connect(resourceId, operationId);
    await sandbox.pty.sendInput(pid, Buffer.from(data), { requestTimeoutMs: REQUEST_TIMEOUT_MS });
  }

  async resizeTerminal(
    resourceId: string,
    operationId: string,
    pid: number,
    cols: number,
    rows: number,
  ) {
    const sandbox = await this.connect(resourceId, operationId);
    await sandbox.pty.resize(pid, { cols, rows }, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
  }

  async closeTerminal(resourceId: string, operationId: string, pid: number, terminalId: string) {
    const sandbox = await this.connect(resourceId, operationId);
    await sandbox.commands.run(
      `python3 -c ${shellQuote(TERMINAL_CLEANUP)} ${pid} ${shellQuote(terminalId)}`,
      { timeoutMs: 5000, requestTimeoutMs: REQUEST_TIMEOUT_MS },
    );
  }

  async terminalStream(resourceId: string, operationId: string, pid: number, signal: AbortSignal) {
    const sandbox = await this.connect(resourceId, operationId);
    const encoder = new TextEncoder();
    let handle: Awaited<ReturnType<typeof sandbox.pty.connect>> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', close);
      void handle?.disconnect().catch(() => {});
      try {
        controller.close();
      } catch {
        /* downstream already cancelled */
      }
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        cancel() {
          close();
        },
      },
      { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength },
    );
    const emit = (value: Record<string, unknown>) => {
      if (closed) return;
      const bytes = encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
      if ((controller.desiredSize ?? 0) < bytes.byteLength) {
        close();
        return;
      }
      controller.enqueue(bytes);
    };
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close();
    if (!closed) {
      try {
        handle = await sandbox.pty.connect(pid, {
          timeoutMs: 120_000,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          onData: (data) => emit({ type: 'output', base64: Buffer.from(data).toString('base64') }),
        });
        if (closed) await handle.disconnect();
        else {
          emit({ type: 'ready' });
          timer = setTimeout(close, 110_000);
          void handle.wait().then(
            () => {
              emit({ type: 'exit' });
              close();
            },
            () => {
              emit({ type: 'disconnected' });
              close();
            },
          );
        }
      } catch {
        emit({ type: 'disconnected' });
        close();
      }
    }
    return stream;
  }

  async writeText(
    resourceId: string,
    operationId: string,
    path: string,
    text: string,
  ): Promise<void> {
    const sandbox = await this.connect(resourceId, operationId);
    const transfer = `/tmp/openmaic-file-${randomUUID()}`;
    try {
      await sandbox.files.write(transfer, text, { requestTimeoutMs: REQUEST_TIMEOUT_MS });
      await sandbox.commands.run(
        `python3 -c ${shellQuote(WORKSPACE_FILE_RUNNER)} write ${shellQuote(Buffer.from(workspacePath(path)).toString('base64'))} ${shellQuote(transfer)}`,
        { timeoutMs: 30_000, requestTimeoutMs: 35_000 },
      );
    } catch (error) {
      this.fileFailure(error);
    } finally {
      await sandbox.files.remove(transfer).catch(() => {});
    }
  }
  async mutateFile(
    resourceId: string,
    operationId: string,
    input: {
      action: 'create' | 'delete' | 'rename';
      path: string;
      destination?: string;
      expectedHash?: string;
      text?: string;
    },
  ) {
    const sandbox = await this.connect(resourceId, operationId);
    const transfer = `/tmp/openmaic-file-${randomUUID()}`;
    try {
      const spec = {
        ...input,
        ...(input.destination ? { destination: workspacePath(input.destination) } : {}),
      };
      await sandbox.files.write(transfer, JSON.stringify(spec), {
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });
      await sandbox.commands.run(
        `python3 -c ${shellQuote(WORKSPACE_FILE_RUNNER)} ${input.action} ${shellQuote(Buffer.from(workspacePath(input.path)).toString('base64'))} ${shellQuote(transfer)}`,
        { timeoutMs: 30000, requestTimeoutMs: 35000 },
      );
    } catch (error) {
      this.fileFailure(error);
    } finally {
      await sandbox.files.remove(transfer).catch(() => {});
    }
  }
  async renew(resourceId: string, operationId: string, lifetimeMs: number, signal?: AbortSignal) {
    const info = await this.ownedInfo(resourceId, operationId, signal);
    if (!info || info.state !== 'running')
      throw sandboxConflict('Only a running sandbox can be renewed.');
    // Ordinary short renewals must not shorten a checkpoint's temporary lease.
    const duration = Math.max(lifetimeMs, info.endAt.getTime() - Date.now());
    await checkpointIO(
      () => Sandbox.setTimeout(resourceId, duration, { ...this.options, signal }),
      signal,
    );
  }

  async previewLifetime(resourceId: string, operationId: string) {
    const info = await this.ownedInfo(resourceId, operationId);
    if (!info || info.state !== 'running' || info.network?.allowPublicTraffic !== false)
      throw sandboxConflict('Private preview is unavailable.');
    return info.endAt.getTime();
  }

  async openPreviewConnection(
    resourceId: string,
    operationId: string,
    port: number,
    signal: AbortSignal,
    durationMs: number,
  ) {
    return openSdkPreviewConnection(
      await this.connect(resourceId, operationId),
      port,
      signal,
      durationMs,
    );
  }

  /** Only the machine-authenticated proxy receives this descriptor. */
  async nativePreview(resourceId: string, operationId: string, port: number) {
    const sandbox = await this.connect(resourceId, operationId);
    const host = sandbox.getHost(port);
    if (!host.endsWith('.' + this.config.domain) || !sandbox.trafficAccessToken)
      throw sandboxConflict('Protected native preview is unavailable.');
    return {
      url: `https://${host}`,
      headers: { 'e2b-traffic-access-token': sandbox.trafficAccessToken },
    };
  }

  async *exportWorkspace(
    resourceId: string,
    operationId: string,
    signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS),
  ): AsyncIterable<Uint8Array> {
    signal.throwIfAborted();
    const sandbox = await this.connect(resourceId, operationId, signal);
    const path = `/tmp/openmaic-archive-${randomUUID()}.tar`;
    const policy = checkpointPolicy();
    const encoded = Buffer.from(JSON.stringify(policy)).toString('base64');
    try {
      await checkpointIO(
        () =>
          sandbox.commands.run(
            `python3 -c ${shellQuote(CHECKPOINT_RUNNER)} export ${shellQuote(path)} ${shellQuote(encoded)}`,
            {
              timeoutMs: CHECKPOINT_TIMEOUT_MS,
              requestTimeoutMs: CHECKPOINT_TIMEOUT_MS + 5_000,
              signal,
            },
          ),
        signal,
      );
      const stream = await checkpointIO(
        () =>
          sandbox.files.read(path, {
            format: 'stream',
            requestTimeoutMs: CHECKPOINT_TIMEOUT_MS,
            signal,
          }),
        signal,
      );
      const reader = stream.getReader();
      let size = 0;
      try {
        while (true) {
          const { done, value } = await checkpointIO(() => reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > checkpointArchiveLimit(policy))
            throw new SandboxError(
              'CHECKPOINT_ARCHIVE_LIMIT',
              409,
              'Workspace archive exceeds its configured limit.',
            );
          yield value;
        }
      } finally {
        const closing = reader.cancel().catch(() => {});
        if (!signal.aborted) await checkpointIO(() => closing, signal).catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      const tag =
        error instanceof CommandExitError
          ? /OPENMAIC_CHECKPOINT_ERROR:(limit|unsupported|changed|permission|disk-full)/.exec(
              error.stderr,
            )?.[1]
          : undefined;
      const codes: Record<string, string> = {
        limit: 'CHECKPOINT_ARCHIVE_LIMIT',
        unsupported: 'CHECKPOINT_UNSUPPORTED_FILES',
        changed: 'CHECKPOINT_CHANGED',
        permission: 'CHECKPOINT_WORKSPACE_PERMISSION',
        'disk-full': 'CHECKPOINT_WORKSPACE_FULL',
      };
      if (tag) throw new SandboxError(codes[tag], 409, 'Workspace export could not complete.');
      throw error;
    } finally {
      await this.removeTransfer(sandbox, path, signal);
    }
  }

  async importWorkspace(
    resourceId: string,
    operationId: string,
    bytes: AsyncIterable<Uint8Array>,
    hash: string,
  ) {
    const sandbox = await this.connect(resourceId, operationId);
    const path = `/tmp/openmaic-archive-${randomUUID()}.tar`;
    const encoded = Buffer.from(JSON.stringify(checkpointPolicy())).toString('base64');
    const source = Readable.from(bytes);
    try {
      await sandbox.files.write(path, Readable.toWeb(source) as ReadableStream<Uint8Array>, {
        requestTimeoutMs: 120_000,
        signal: AbortSignal.timeout(120_000),
      });
      // Upload and extraction each allow 120 seconds. Refresh between them so
      // a valid slow upload cannot exhaust extraction's remaining lease.
      await this.renew(
        resourceId,
        operationId,
        Math.max(this.config.lifetimeMs, CHECKPOINT_MIN_LIFETIME_MS),
      );
      await sandbox.commands.run(
        `python3 -c ${shellQuote(CHECKPOINT_RUNNER)} import ${shellQuote(path)} ${shellQuote(encoded)} ${shellQuote(hash)}`,
        { timeoutMs: 120_000, requestTimeoutMs: 125_000 },
      );
    } finally {
      source.destroy();
      await this.removeTransfer(sandbox, path);
    }
  }

  async initializeWorkspace(resourceId: string, operationId: string) {
    const sandbox = await this.connect(resourceId, operationId);
    // mkdir is idempotent and leaves existing project content intact.
    await sandbox.files.makeDir(WORKSPACE_ROOT);
  }

  async listWorkspace(resourceId: string, operationId: string, signal?: AbortSignal) {
    const sandbox = await this.connect(resourceId, operationId, signal);
    const result = await checkpointIO(
      () =>
        sandbox.commands.run(
          `python3 -c ${shellQuote(String.raw`
import os,json,stat
root='/home/user/project'; out=[]
if os.path.realpath(root)!=root: raise ValueError('root')
for parent,dirs,files in os.walk(root,followlinks=False):
    dirs[:]=sorted(n for n in dirs if n not in ${JSON.stringify(WORKSPACE_EXCLUDES)})
    for name in dirs+files:
        p=os.path.join(parent,name); info=os.lstat(p)
        if stat.S_ISDIR(info.st_mode): continue
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise ValueError('link')
        out.append({'path':os.path.relpath(p,root),'bytes':info.st_size})
        if len(out)>4096: raise ValueError('listing limit')
print(json.dumps(out))
`)}`,
          {
            timeoutMs: 30_000,
            requestTimeoutMs: 35_000,
            signal,
          },
        ),
      signal,
    );
    const entries = JSON.parse(result.stdout) as Array<{ path: string; bytes: number }>;
    if (
      !Array.isArray(entries) ||
      entries.length > 4096 ||
      entries.some(
        (e) =>
          !e || workspacePath(e.path) !== e.path || !Number.isSafeInteger(e.bytes) || e.bytes < 0,
      )
    )
      throw sandboxConflict('Invalid workspace listing.');
    return entries;
  }
}
