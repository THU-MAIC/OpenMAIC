import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

type RpcId = number;

interface RpcErrorBody {
  code?: number;
  message?: string;
  data?: unknown;
}

interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcErrorBody;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export type CodexNotificationHandler = (method: string, params: unknown) => void;

export interface CodexAppServer {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  onNotification(handler: CodexNotificationHandler): () => void;
}

type ProcessFactory = () => ChildProcessWithoutNullStreams;

function resolveCodexCliScript(): string {
  return path.join(process.cwd(), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

function defaultProcessFactory(): ChildProcessWithoutNullStreams {
  const configuredHome = process.env.CODEX_PROVIDER_HOME?.trim();
  if (!configuredHome || !path.isAbsolute(configuredHome)) {
    throw new Error(
      'CODEX_PROVIDER_HOME must be set to an absolute, dedicated directory before enabling the Codex provider.',
    );
  }
  const codexHome = path.resolve(configuredHome);
  mkdirSync(codexHome, { recursive: true });
  return spawn(process.execPath, [resolveCodexCliScript(), 'app-server', '--stdio'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export class CodexAppServerClient implements CodexAppServer {
  private readonly processFactory: ProcessFactory;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private startPromise: Promise<void> | null = null;
  private initialized = false;
  private nextId = 1;
  private pending = new Map<RpcId, PendingRequest>();
  private notificationHandlers = new Set<CodexNotificationHandler>();

  constructor(processFactory: ProcessFactory = defaultProcessFactory) {
    this.processFactory = processFactory;
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  onNotification(handler: CodexNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.startPromise = null;
    this.lines?.close();
    this.lines = null;
    this.rejectPending(new Error('Codex App Server stopped.'));
    if (child && !child.killed) child.kill();
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized && this.child && this.child.exitCode === null) return;
    if (!this.startPromise) {
      this.startPromise = this.start().catch((error) => {
        this.dispose();
        throw error;
      });
    }
    await this.startPromise;
  }

  private async start(): Promise<void> {
    const child = this.processFactory();
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));

    // Always drain stderr. App Server reserves stdout for JSONL protocol frames.
    child.stderr.on('data', () => undefined);
    child.once('error', (error) => this.handleProcessClose(child, error));
    child.once('exit', (code, signal) => {
      this.handleProcessClose(
        child,
        new Error(
          `Codex App Server exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}.`,
        ),
      );
    });

    await this.sendRequest(
      'initialize',
      {
        clientInfo: { name: 'openmaic', title: 'OpenMAIC', version: '1.0.0' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
      20_000,
    );
    this.write({ method: 'initialized' });
    this.initialized = true;
  }

  private sendRequest<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      try {
        this.write(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: RpcMessage): void {
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error('Codex App Server is not available.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'Codex App Server request failed.'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      this.write({
        id: message.id,
        error: {
          code: -32601,
          message: 'OpenMAIC does not expose App Server callback tools.',
        },
      });
      return;
    }

    if (message.method) {
      for (const handler of this.notificationHandlers) {
        handler(message.method, message.params);
      }
    }
  }

  private handleProcessClose(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.initialized = false;
    this.startPromise = null;
    this.lines?.close();
    this.lines = null;
    this.rejectPending(error);
    for (const handler of this.notificationHandlers) {
      handler('server/closed', { error: error.message });
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const globalState = globalThis as typeof globalThis & {
  __openmaicCodexAppServer?: CodexAppServerClient;
};

export function getCodexAppServer(): CodexAppServerClient {
  globalState.__openmaicCodexAppServer ??= new CodexAppServerClient();
  return globalState.__openmaicCodexAppServer;
}
