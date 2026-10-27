import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { isPersonalInstallationOwner } from '@/lib/server/identity';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import { SandboxError, sandboxConflict, sandboxInvalid } from '@/lib/sandbox/errors';
import {
  MAX_TEXT_FILE_BYTES,
  MAX_COMMAND_BYTES,
  type SandboxProvider,
  type SandboxCommandResult,
  type DesktopAction,
} from '@/lib/sandbox/types';

import { assertWorkspaceMutation, type WorkspaceMutation } from './managed-workspace';
import { issuePreviewGrant, previewConfig, verifyPreviewGrant } from './preview';
import { WORKSPACE_ROOT, workspacePath } from './workspace-archive';
import {
  checkpointPolicy,
  CHECKPOINT_TIMEOUT_MS,
  CHECKPOINT_MIN_LIFETIME_MS,
} from './checkpoint-policy';
import { checkpointIO } from './checkpoint-errors';
import type { SandboxConfig } from './config';
import { resolvedSandboxConfig } from './settings';
import { publicEnvironment, SandboxStore, type SandboxRow } from './store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKSPACE = /^[A-Za-z0-9._:-]{1,128}$/;

export function assertSandboxId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID.test(id))
    throw sandboxInvalid('A lowercase UUID is required.');
}

function assertPath(path: unknown): asserts path is string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.length > 4096 ||
    path.includes('\0')
  ) {
    throw sandboxInvalid('An absolute sandbox file path is required.');
  }
}

/** No anonymous/shared-owner billable resources, and no implicit shell grant to course agents. */
function authorize(principal: OwnerPrincipal): void {
  if (isPersonalInstallationOwner(principal)) return;
  if (
    (principal.kind === 'user' || principal.kind === 'service') &&
    principal.assurance === 'verified' &&
    principal.roles.has('sandbox:use')
  )
    return;
  throw new SandboxError(
    'SANDBOX_FORBIDDEN',
    403,
    'This identity is not allowed to use sandboxes.',
  );
}

export class SandboxService {
  private constructor(
    private readonly ownerId: string,
    private readonly config: SandboxConfig,
    private readonly store: SandboxStore,
    private readonly provider: SandboxProvider,
  ) {}

  static async forOwner(principal: OwnerPrincipal): Promise<SandboxService> {
    authorize(principal);
    const config = await resolvedSandboxConfig();
    const { E2BCompatibleSandboxProvider } = await import('./providers/e2b-compatible');
    return new SandboxService(
      principal.ownerId,
      config,
      await SandboxStore.open(),
      new E2BCompatibleSandboxProvider(config),
    );
  }

  /** Host maintenance of an existing study binding, without inventing a verified user identity.
   * The caller holds the study lock and grants only checkpoint/destroy workspace operations.
   */
  static async forLearningMaintenance(studyId: string, ownerId: string, environmentId: string) {
    const store = await SandboxStore.open();
    await store.assertLearningBinding(studyId, ownerId, environmentId);
    const config = await resolvedSandboxConfig();
    const { E2BCompatibleSandboxProvider } = await import('./providers/e2b-compatible');
    return new SandboxService(ownerId, config, store, new E2BCompatibleSandboxProvider(config));
  }

  /** An explicit, expiring delegation created by an authenticated sandbox owner. */
  async grantSession(id: string, sessionId: unknown, writes: unknown, commands: unknown) {
    if (
      typeof sessionId !== 'string' ||
      sessionId.length > 256 ||
      typeof writes !== 'boolean' ||
      typeof commands !== 'boolean'
    )
      throw sandboxInvalid('Expected a session ID and explicit write/command grants.');
    await this.mutation(id, 'delegate');
    const { getAgentSessionStore } = await import('@/lib/server/agent-runtime/store');
    const session = await (await getAgentSessionStore()).getSession(sessionId);
    if (!session || session.ownerId !== this.ownerId)
      throw new SandboxError('SANDBOX_SESSION_FORBIDDEN', 403, 'Session is unavailable.');
    const row = await this.running(id);
    await this.store.grantSession(row, sessionId, randomUUID(), writes, commands);
    return { granted: true, durationSeconds: 3600 };
  }

  async revokeSession(sessionId: string) {
    await this.store.revokeSession(this.ownerId, sessionId);
    return { revoked: true };
  }

  /** No stored owner is promoted into a verified principal. A durable explicit delegation is required. */
  static async forAgentSession(sessionId: string, ownerId: string, grantId: string) {
    const config = await resolvedSandboxConfig();
    const store = await SandboxStore.open();
    const grant = await store.sessionGrant(sessionId, ownerId);
    const { getAgentSessionStore } = await import('@/lib/server/agent-runtime/store');
    const session = await (await getAgentSessionStore()).getSession(sessionId);
    if (!grant || grant.grant_id !== grantId || !session || session.ownerId !== ownerId)
      throw new SandboxError(
        'SANDBOX_GRANT_EXPIRED',
        403,
        'Sandbox access expired or was revoked. Renew it from the project workspace.',
      );
    const { E2BCompatibleSandboxProvider } = await import('./providers/e2b-compatible');
    const service = new SandboxService(
      ownerId,
      config,
      store,
      new E2BCompatibleSandboxProvider(config),
    );
    await service.running(grant.environment_id);
    return service;
  }

  private async binding(id: string): Promise<SandboxRow> {
    assertSandboxId(id);
    const row = await this.store.get(this.ownerId, id);
    if (row.connection_fingerprint !== this.config.fingerprint) {
      throw sandboxConflict(
        'This environment belongs to a different provider configuration. Restore that configuration to manage it.',
      );
    }
    return row;
  }

  private async mutation(id: string, operation: WorkspaceMutation) {
    const row = await this.binding(id);
    assertWorkspaceMutation(this.ownerId, row.workspace_id, row.id, operation);
    return row;
  }

  async list() {
    return (await this.store.list(this.ownerId)).map(publicEnvironment);
  }

  async savedProjects() {
    return this.store.checkpointSummaries(this.ownerId);
  }

  async deleteSavedProject(workspaceId: unknown, revision: unknown) {
    if (
      typeof workspaceId !== 'string' ||
      !WORKSPACE.test(workspaceId) ||
      !Number.isSafeInteger(revision) ||
      (revision as number) < 1
    )
      throw sandboxInvalid('A workspace and checkpoint revision are required.');
    assertWorkspaceMutation(this.ownerId, workspaceId, null, 'checkpoint');
    await this.store.deleteCheckpoint(this.ownerId, workspaceId, revision as number);
    return { deleted: true };
  }

  async capabilities() {
    let browserPreview = false;
    try {
      previewConfig();
      browserPreview = true;
    } catch {
      /* Optional feature remains unavailable. */
    }
    return {
      ...this.provider.capabilities,
      profiles: this.config.desktopTemplate ? ['code', 'desktop'] : ['code'],
      files: { text: true, list: true, root: WORKSPACE_ROOT, maxBytes: MAX_TEXT_FILE_BYTES },
      commands: { background: true, cancellation: true, outputLimitBytes: 262144 },
      terminal: { input: true, resize: true, reconnect: true, historyReplay: false },
      desktop: {
        screenshot: !!this.config.desktopTemplate,
        input: !!this.config.desktopTemplate,
        browserStream: false,
      },
      preview: {
        browser: browserPreview,
        websocket: browserPreview,
      },
      storage: {
        survivesRelease: 'explicit-checkpoint',
        pauseResume: false,
        available: await this.store.checkpointStorageAvailable(),
        ...checkpointPolicy(),
      },
      lifetimeMs: this.config.lifetimeMs,
      maxActive: this.config.maxActive,
      maxActivePerOwner: this.config.maxActivePerOwner,
    };
  }

  async listCommands(id: string) {
    return this.store.listCommands(await this.binding(id));
  }
  async listTerminals(id: string) {
    return this.store.listTerminals(await this.binding(id));
  }

  async get(id: string) {
    return publicEnvironment(await this.binding(id));
  }

  async create(requestId: unknown, workspaceId: unknown, profile: unknown = 'code') {
    assertSandboxId(requestId);
    if (profile !== 'code' && profile !== 'desktop')
      throw sandboxInvalid('Unknown runtime profile.');
    if (profile === 'desktop' && !this.config.desktopTemplate)
      throw new SandboxError('SANDBOX_UNSUPPORTED', 422, 'Desktop runtime is not configured.');
    if (typeof workspaceId !== 'string' || !WORKSPACE.test(workspaceId)) {
      throw sandboxInvalid(
        'workspaceId must be 1-128 letters, numbers, dots, colons, underscores or dashes.',
      );
    }
    assertWorkspaceMutation(this.ownerId, workspaceId, requestId, 'create');
    const checkpoint = await this.store.checkpoint(this.ownerId, workspaceId);
    if (checkpoint) await this.store.assertCheckpointReadable(this.ownerId, checkpoint);
    const reservation = {
      ownerId: this.ownerId,
      id: requestId,
      workspaceId,
      fingerprint: this.config.fingerprint,
      settingsRevision: this.config.settingsRevision ?? 0,
      maxActive: this.config.maxActivePerOwner,
      maxActiveTotal: this.config.maxActive,
      profile,
    } as const;
    let reserved;
    try {
      reserved = await this.store.reserve(reservation);
    } catch (error) {
      if (!(error instanceof SandboxError) || error.code !== 'SANDBOX_LIMIT') throw error;
      // A provider TTL can expire without the owner returning. Only confirmed missing,
      // already-bound resources release capacity; uncertain creates remain reserved.
      await this.reconcileCapacity();
      reserved = await this.store.reserve(reservation);
    }
    const { row, created } = reserved;
    if (!created) {
      // reserve already checked ownership and request identity. A destroyed row
      // has no live binding to protect; let the client rotate its old operation ID.
      if (row.state === 'destroyed') return publicEnvironment(row);
      const existing = await this.binding(row.id);
      if (existing.state === 'running' && !existing.workspace_ready)
        return this.restoreWorkspace(row.id);
      return publicEnvironment(existing);
    }
    let resource;
    try {
      resource = await this.provider.create(row.id, row.profile);
    } catch {
      // Even an apparent failure can hide a successful allocation. No second create.
      return publicEnvironment(await this.store.transition(row, ['creating'], 'unknown'));
    }
    // A database failure here leaves 'creating'; discovery recovers by the same operation ID.
    const bound = await this.store.transition(
      row,
      ['creating', 'unknown'],
      resource.state,
      resource.id,
    );
    if (bound.state === 'running' && !bound.workspace_ready) return this.restoreWorkspace(bound.id);
    return publicEnvironment(bound);
  }

  private async reconcileCapacity() {
    const rows = await this.store.reconciliationCandidates(this.config.fingerprint);
    // Bounded parallel metadata reads, no allocation/deletion and no new scheduler.
    // Failures keep the reservation. Successful live checks rotate the oldest-first batch.
    await Promise.allSettled(
      rows.map((candidate) =>
        this.store.exclusive(candidate.id, async () => {
          const row = await this.store.get(candidate.owner_id, candidate.id);
          if (
            !row.resource_id ||
            row.state === 'destroyed' ||
            row.connection_fingerprint !== this.config.fingerprint
          )
            return;
          const resource = await this.provider.inspect(row.resource_id, row.id);
          await this.store.transition(
            row,
            [row.state],
            resource ? (row.state === 'destroying' ? row.state : resource.state) : 'destroyed',
          );
        }),
      ),
    );
  }

  async reconcile(id: string, prepareWorkspace = true) {
    return this.reconcileResource(id, prepareWorkspace);
  }

  private async reconcileResource(id: string, prepareWorkspace: boolean) {
    const row = await this.binding(id);
    if (row.state === 'destroyed') return publicEnvironment(row);
    if (!row.resource_id) {
      const resources = await this.provider.find(row.id);
      if (resources.length > 1)
        throw sandboxConflict(
          'Multiple resources match this operation. Operator reconciliation is required.',
        );
      if (!resources[0]) {
        // Absence from a list does not prove a timed-out create never happened.
        return publicEnvironment(await this.store.transition(row, ['creating'], 'unknown'));
      }
      const resource = resources[0];
      const adopted = await this.store.transition(
        row,
        ['creating', 'unknown'],
        resource.state,
        resource.id,
      );
      if (prepareWorkspace && adopted.state === 'running' && !adopted.workspace_ready)
        return this.restoreWorkspace(id);
      return publicEnvironment(adopted);
    }
    const resource = await this.provider.inspect(row.resource_id, row.id);
    if (row.state === 'destroying') {
      if (!resource)
        return publicEnvironment(await this.store.transition(row, ['destroying'], 'destroyed'));
      // An interrupted delete is retried only by an explicit DELETE, never by a read.
      return publicEnvironment(row);
    }
    const updated = await this.store.transition(row, [row.state], resource?.state ?? 'destroyed');
    if (prepareWorkspace && updated.state === 'running' && !updated.workspace_ready)
      return this.restoreWorkspace(id);
    return publicEnvironment(updated);
  }

  async destroy(id: string) {
    await this.mutation(id, 'destroy');
    return this.store.exclusive(id, () => this.destroyUnlocked(id));
  }

  private async destroyUnlocked(id: string) {
    let row = await this.binding(id);
    if (row.state === 'destroyed') return publicEnvironment(row);
    if (!row.resource_id) {
      await this.reconcileResource(id, false);
      row = await this.binding(id);
    }
    if (!row.resource_id)
      throw sandboxConflict(
        'The create outcome is unknown. Reconcile it before deletion; it must not be replaced automatically.',
      );
    row = await this.store.transition(
      row,
      ['running', 'paused', 'missing', 'destroying'],
      'destroying',
    );
    if (row.state !== 'destroying') return publicEnvironment(row);
    await this.provider.destroy(row.resource_id!, row.id);
    return publicEnvironment(await this.store.transition(row, ['destroying'], 'destroyed'));
  }

  private async running(id: string): Promise<SandboxRow & { resource_id: string }> {
    const row = await this.binding(id);
    if (row.state !== 'running' || !row.resource_id || !row.workspace_ready) {
      throw sandboxConflict('Sandbox is not running. Reconcile its state before using files.');
    }
    return row as SandboxRow & { resource_id: string };
  }

  async readText(id: string, path: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    path = `${WORKSPACE_ROOT}/${workspacePath(path)}`;
    assertPath(path);
    const row = await this.running(id);
    signal?.throwIfAborted();
    return this.provider.readText(row.resource_id, row.id, path, signal);
  }

  async writeText(id: string, path: unknown, text: unknown) {
    await this.mutation(id, 'write');
    return this.store.exclusive(id, () => this.writeTextUnlocked(id, path, text));
  }

  /** Optimistic file edits share the environment mutation lock with all host writers. */
  async compareAndWriteText(
    id: string,
    path: string,
    text: string,
    expectedHash: string,
    beforeWrite?: () => Promise<void>,
  ) {
    await this.mutation(id, 'write');
    return this.store.exclusive(id, async () => {
      const current = await this.readText(id, path);
      if (createHash('sha256').update(current).digest('hex') !== expectedHash)
        throw sandboxConflict(
          'The file changed since it was read. Reload before saving.',
          'WORKSPACE_FILE_CONFLICT',
        );
      if (current === text) return false;
      // Durable evidence is invalidated under the same lock, before a possibly ambiguous write.
      await beforeWrite?.();
      await this.writeTextUnlocked(id, path, text);
      return true;
    });
  }

  private async writeTextUnlocked(id: string, path: unknown, text: unknown) {
    path = `${WORKSPACE_ROOT}/${workspacePath(path)}`;
    assertPath(path);
    if (typeof text !== 'string') throw sandboxInvalid('text must be a string.');
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_FILE_BYTES) {
      throw new SandboxError('SANDBOX_FILE_TOO_LARGE', 413, 'Text files are limited to 1 MiB.');
    }
    const row = await this.running(id);
    assertWorkspaceMutation(this.ownerId, row.workspace_id, row.id, 'write');
    await this.provider.writeText(row.resource_id, row.id, path, text);
  }

  async mutateFile(
    id: string,
    input: {
      action: 'create' | 'delete' | 'rename';
      path: string;
      destination?: string;
      expectedHash?: string;
      text?: string;
    },
    beforeWrite: () => Promise<void>,
  ) {
    await this.mutation(id, 'write');
    const path = workspacePath(input.path);
    const destination =
      input.destination === undefined ? undefined : workspacePath(input.destination);
    if (
      !['create', 'delete', 'rename'].includes(input.action) ||
      (input.action === 'rename' && !destination)
    )
      throw sandboxInvalid('Choose a valid file operation.');
    if (input.action !== 'create' && !/^[a-f0-9]{64}$/.test(input.expectedHash ?? ''))
      throw sandboxInvalid('An observed file hash is required.');
    if (
      input.text !== undefined &&
      (typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX_TEXT_FILE_BYTES)
    )
      throw sandboxInvalid('Text is too large.');
    return this.store.exclusive(id, async () => {
      const row = await this.running(id);
      await this.assertWorkspaceIdleUnlocked(row);
      if (!this.provider.mutateFile)
        throw new SandboxError(
          'SANDBOX_UNSUPPORTED',
          422,
          'File management is unavailable for this provider.',
        );
      const files = await this.provider.listWorkspace(row.resource_id!, row.id);
      const existing = files.some((f) => f.path === path);
      if (input.action === 'create' ? existing : !existing)
        throw sandboxConflict(
          'The file list changed. Reload the workspace.',
          'WORKSPACE_FILE_CONFLICT',
        );
      if (destination && files.some((f) => f.path === destination))
        throw sandboxConflict('The destination already exists.', 'WORKSPACE_FILE_CONFLICT');
      if (
        input.action !== 'create' &&
        createHash('sha256')
          .update(await this.readText(id, path))
          .digest('hex') !== input.expectedHash
      )
        throw sandboxConflict(
          'The file changed. Reload before continuing.',
          'WORKSPACE_FILE_CONFLICT',
        );
      await beforeWrite();
      assertWorkspaceMutation(this.ownerId, row.workspace_id, row.id, 'write');
      await this.provider.mutateFile(row.resource_id!, row.id, { ...input, path, destination });
      return { changed: true };
    });
  }
  /** Observed Stop generation, also used for preview revocation; safe to expose to the owner. */
  async workspaceEpoch(id: string) {
    return (await this.binding(id)).preview_epoch;
  }

  async startCommand(id: string, body: Record<string, unknown>, epoch?: number) {
    await this.mutation(id, 'command');
    return this.store.exclusive(id, () => this.startCommandUnlocked(id, body, epoch));
  }

  private async startCommandUnlocked(id: string, body: Record<string, unknown>, epoch?: number) {
    assertSandboxId(body.requestId);
    if (
      typeof body.command !== 'string' ||
      !body.command.trim() ||
      body.command.includes('\0') ||
      Buffer.byteLength(body.command) > MAX_COMMAND_BYTES
    )
      throw sandboxInvalid('command must be a non-empty string of at most 32 KiB.');
    if (body.cwd !== undefined) assertPath(body.cwd);
    const timeoutMs = body.timeoutMs ?? 60_000;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > Math.min(this.config.lifetimeMs, 3_600_000)
    )
      throw sandboxInvalid(
        'Command timeout must be finite and no longer than the sandbox lifetime.',
      );
    const row = await this.running(id);
    const input = {
      id: body.requestId,
      command: body.command,
      cwd: (body.cwd as string | undefined) ?? WORKSPACE_ROOT,
      timeoutMs,
    };
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const created = await this.store.reserveCommand(row, input.id, hash, epoch);
    if (created) {
      try {
        assertWorkspaceMutation(this.ownerId, row.workspace_id, row.id, 'command');
      } catch (error) {
        // No provider dispatch happened; leave a collectable terminal command, not an orphan writer.
        await this.store.saveCommand(row, {
          id: input.id,
          state: 'cancelled',
          stdout: '',
          stderr: '',
          exitCode: null,
          truncated: false,
        });
        throw error;
      }
      try {
        await this.provider.startCommand(row.resource_id, row.id, input);
      } catch {
        // A lost start acknowledgement is unknown, never grounds for a second execution.
        return {
          id: input.id,
          state: 'unknown',
          stdout: '',
          stderr: '',
          exitCode: null,
          truncated: false,
        } satisfies SandboxCommandResult;
      }
    }
    return this.command(id, input.id);
  }

  async command(
    id: string,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<SandboxCommandResult> {
    signal?.throwIfAborted();
    assertSandboxId(commandId);
    const row = await this.binding(id);
    const cached = await this.store.command(row, commandId);
    if (cached && !['starting', 'running', 'unknown'].includes(cached.state)) return cached;
    if (row.state !== 'running' || !row.resource_id)
      throw sandboxConflict(
        'The command result was not collected before the sandbox became unavailable.',
      );
    const result = await checkpointIO(
      () => this.provider.readCommand(row.resource_id!, row.id, commandId, signal),
      signal,
    );
    signal?.throwIfAborted();
    await this.store.saveCommand(row, result);
    return (await this.store.command(row, commandId)) ?? result;
  }

  async cancelCommand(id: string, commandId: string) {
    assertSandboxId(commandId);
    const row = await this.running(id);
    const cached = await this.store.command(row, commandId);
    if (cached && !['starting', 'running', 'unknown'].includes(cached.state)) return cached;
    await this.provider.cancelCommand(row.resource_id, row.id, commandId);
    return { id: commandId, cancellationRequested: true };
  }

  private async desktop(id: string) {
    const row = await this.running(id);
    if (row.profile !== 'desktop') throw sandboxInvalid('A desktop environment is required.');
    return row;
  }

  async screenshot(id: string) {
    const row = await this.desktop(id);
    const bytes = await this.provider.desktopScreenshot(row.resource_id, row.id);
    return { mimeType: 'image/png', base64: Buffer.from(bytes).toString('base64') };
  }

  async desktopAction(id: string, body: Record<string, unknown>) {
    await this.mutation(id, 'desktop');
    let action: DesktopAction;
    if (body.type === 'move' || body.type === 'click') {
      if (
        typeof body.x !== 'number' ||
        typeof body.y !== 'number' ||
        !Number.isInteger(body.x) ||
        !Number.isInteger(body.y) ||
        body.x < 0 ||
        body.y < 0 ||
        body.x > 8192 ||
        body.y > 8192
      )
        throw sandboxInvalid('Desktop coordinates must be nonnegative integers up to 8192.');
      action = { type: body.type, x: body.x, y: body.y };
    } else if (body.type === 'write') {
      if (
        typeof body.text !== 'string' ||
        Buffer.byteLength(body.text) > 16384 ||
        body.text.includes('\0')
      )
        throw sandboxInvalid('Desktop text is limited to 16 KiB.');
      action = { type: 'write', text: body.text };
    } else if (body.type === 'press') {
      if (
        !Array.isArray(body.keys) ||
        body.keys.length < 1 ||
        body.keys.length > 4 ||
        !body.keys.every((k) => typeof k === 'string' && /^[a-zA-Z0-9_]{1,24}$/.test(k))
      )
        throw sandboxInvalid('Expected one to four key names.');
      action = { type: 'press', keys: body.keys as string[] };
    } else throw sandboxInvalid('Unknown desktop action.');
    const row = await this.desktop(id);
    await this.provider.desktopAction(row.resource_id, row.id, action);
    return { performed: true };
  }

  private terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
    if (
      typeof cols !== 'number' ||
      typeof rows !== 'number' ||
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > 400 ||
      rows > 200
    )
      throw sandboxInvalid('Terminal size must be 1-400 columns and 1-200 rows.');
    return { cols, rows };
  }

  async createTerminal(id: string, body: Record<string, unknown>, epoch?: number) {
    await this.mutation(id, 'terminal');
    return this.store.exclusive(id, () => this.createTerminalUnlocked(id, body, epoch));
  }

  private async createTerminalUnlocked(id: string, body: Record<string, unknown>, epoch?: number) {
    assertSandboxId(body.requestId);
    const { cols, rows } = this.terminalSize(body.cols ?? 80, body.rows ?? 24);
    const env = await this.running(id);
    const reserved = await this.store.reserveTerminal(env, body.requestId, epoch);
    if (reserved.created) {
      try {
        const pid = await this.provider.createTerminal(
          env.resource_id,
          env.id,
          body.requestId,
          cols,
          rows,
        );
        await this.store.setTerminal(env, body.requestId, 'running', pid);
      } catch {
        await this.store.setTerminal(env, body.requestId, 'unknown', null);
      }
    }
    const terminal = await this.store.terminal(env, body.requestId);
    return { id: terminal.id, state: terminal.state };
  }

  private async terminalBinding(id: string, terminalId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    assertSandboxId(terminalId);
    const env = await this.running(id);
    let terminal = await this.store.terminal(env, terminalId);
    if (terminal.state === 'closed') return { env, terminal };
    const pid = await checkpointIO(
      () => this.provider.findTerminal(env.resource_id, env.id, terminalId, signal),
      signal,
    );
    signal?.throwIfAborted();
    if (pid !== null) {
      if (terminal.pid !== null && terminal.pid !== pid)
        throw sandboxConflict('Terminal process identity changed.');
      terminal = await this.store.setTerminal(env, terminalId, 'running', pid);
    } else if (terminal.pid !== null) {
      terminal = await this.store.setTerminal(env, terminalId, 'closed', terminal.pid);
    }
    return { env, terminal };
  }

  async terminal(id: string, terminalId: string, signal?: AbortSignal) {
    const { terminal } = await this.terminalBinding(id, terminalId, signal);
    return { id: terminal.id, state: terminal.state };
  }

  async updateTerminal(
    id: string,
    terminalId: string,
    body: Record<string, unknown>,
    authorize?: () => Promise<void>,
  ) {
    await this.mutation(id, 'terminal');
    return this.store.exclusive(id, () =>
      this.updateTerminalUnlocked(id, terminalId, body, authorize),
    );
  }

  private async updateTerminalUnlocked(
    id: string,
    terminalId: string,
    body: Record<string, unknown>,
    authorize?: () => Promise<void>,
  ) {
    const { env, terminal } = await this.terminalBinding(id, terminalId);
    if (terminal.state !== 'running' || terminal.pid === null)
      throw sandboxConflict('Terminal is not running.');
    // Discovery can outlive a learning release decision. Recheck policy after remote reads.
    await authorize?.();
    if (body.action === 'input') {
      if (typeof body.data !== 'string' || Buffer.byteLength(body.data) > 16_384)
        throw sandboxInvalid('Terminal input is limited to 16 KiB.');
      await this.provider.terminalInput(env.resource_id, env.id, terminal.pid, body.data);
    } else if (body.action === 'resize') {
      const { cols, rows } = this.terminalSize(body.cols, body.rows);
      await this.provider.resizeTerminal(env.resource_id, env.id, terminal.pid, cols, rows);
    } else throw sandboxInvalid('Expected terminal input or resize.');
    return { accepted: true };
  }

  async closeTerminal(id: string, terminalId: string) {
    await this.binding(id);
    return this.store.exclusive(id, async () => {
      const { env, terminal } = await this.terminalBinding(id, terminalId);
      if (terminal.state === 'closed') return { id: terminal.id, state: terminal.state };
      // terminalBinding completed process discovery under the creation lock.
      // A failed/ambiguous lookup throws and retains the reservation. An explicit
      // close may retire a no-match reservation; reads never discard an unknown ID.
      if (terminal.pid !== null)
        await this.provider.closeTerminal(env.resource_id, env.id, terminal.pid, terminal.id);
      const updated = await this.store.setTerminal(env, terminal.id, 'closed', terminal.pid);
      return { id: updated.id, state: updated.state };
    });
  }

  async terminalStream(id: string, terminalId: string, signal: AbortSignal) {
    const { env, terminal } = await this.terminalBinding(id, terminalId);
    if (terminal.state !== 'running' || terminal.pid === null)
      throw sandboxConflict('Terminal is not running.');
    return this.provider.terminalStream(env.resource_id, env.id, terminal.pid, signal);
  }
  async renew(id: string) {
    await this.binding(id);
    return this.store.exclusive(id, async () => {
      const row = await this.running(id);
      return this.renewUnlocked(row, this.config.lifetimeMs);
    });
  }

  /** Protect source snapshot I/O before the archive path acquires its own environment lock. */
  async renewForCheckpoint(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.binding(id);
    return this.store.exclusive(id, async () =>
      this.renewUnlocked(
        await this.running(id),
        Math.max(this.config.lifetimeMs, CHECKPOINT_MIN_LIFETIME_MS),
        signal,
      ),
    );
  }

  private async renewUnlocked(
    row: SandboxRow & { resource_id: string },
    lifetimeMs: number,
    signal?: AbortSignal,
  ) {
    await checkpointIO(
      () => this.provider.renew(row.resource_id, row.id, lifetimeMs, signal),
      signal,
    );
    return { renewed: true, lifetimeMs };
  }

  async listFiles(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const row = await this.running(id);
    signal?.throwIfAborted();
    return this.provider.listWorkspace(row.resource_id, row.id, signal);
  }

  async checkpoint(id: string) {
    const row = await this.binding(id);
    const saved = await this.store.checkpoint(this.ownerId, row.workspace_id);
    return saved
      ? {
          revision: saved.revision,
          hash: saved.archive_hash,
          bytes: Number(saved.archive_size),
          createdAt: saved.created_at.toISOString(),
        }
      : null;
  }

  /** Reads/evidence must not race background commands or a terminal started before teaching took ownership. */
  async assertWorkspaceIdle(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.binding(id);
    return this.store.exclusive(id, async () =>
      this.assertWorkspaceIdleUnlocked(await this.running(id), signal),
    );
  }

  private async assertWorkspaceIdleUnlocked(row: SandboxRow, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // A file checkpoint is not a process or database snapshot. Quiesce managed writers first.
    for (const cmd of await this.store.listCommands(row)) {
      const result = await this.command(row.id, cmd.id, signal);
      if (['starting', 'running', 'unknown'].includes(result.state))
        throw sandboxConflict(
          'Stop and collect running commands before saving the workspace.',
          'WORKSPACE_COMMAND_ACTIVE',
        );
    }
    for (const t of await this.store.listTerminals(row)) {
      const observed = await this.terminal(row.id, t.id, signal);
      if (observed.state !== 'closed')
        throw sandboxConflict(
          'Close terminals before saving the workspace.',
          'WORKSPACE_TERMINAL_ACTIVE',
        );
    }
  }

  async saveWorkspace(
    id: string,
    expectedRevision: unknown,
    release = false,
    signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS),
  ) {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0)
      throw sandboxInvalid('An expected checkpoint revision is required (0 for the first save).');
    await this.mutation(id, 'checkpoint');
    return this.store.exclusive(id, async () => {
      const row = await this.running(id);
      await this.renewUnlocked(
        row,
        Math.max(this.config.lifetimeMs, CHECKPOINT_MIN_LIFETIME_MS),
        signal,
      );
      await this.assertWorkspaceIdleUnlocked(row, signal);
      const checkpoint = await this.store.saveCheckpoint(
        row,
        expectedRevision as number,
        this.provider.exportWorkspace(row.resource_id, row.id, signal),
        signal,
      );
      // Durability is established BEFORE resource deletion. Delete uncertainty retains the checkpoint.
      if (release) await this.destroyUnlocked(id);
      return { checkpoint, released: release };
    });
  }

  /** Periodic capture/upload is read-only and holds no environment lock; publication is short. */
  async assertRecordedWorkspaceIdle(id: string) {
    return this.store.assertRecordedIdle(await this.running(id));
  }

  async prepareWorkspaceCheckpoint(
    id: string,
    revision: number,
    signal: AbortSignal,
    options: { renew?: boolean } = {},
  ) {
    signal.throwIfAborted();
    await this.mutation(id, 'checkpoint');
    if (options.renew !== false) await this.renewForCheckpoint(id, signal);
    const row = await this.running(id);
    await this.store.assertRecordedIdle(row);
    const prepared = await this.store.prepareCheckpoint(
      row,
      revision,
      this.provider.exportWorkspace(row.resource_id, row.id, signal),
      signal,
    );
    return {
      checkpoint: prepared.checkpoint,
      discard: prepared.discard,
      commit: (publish?: Parameters<typeof prepared.commit>[0]) =>
        this.store.exclusive(id, async () => {
          signal.throwIfAborted();
          await this.mutation(id, 'checkpoint');
          const current = await this.running(id);
          if (current.resource_id !== row.resource_id)
            throw sandboxConflict('Workspace changed.', 'WORKSPACE_STOPPED');
          await this.store.assertRecordedIdle(current);
          return prepared.commit(publish);
        }),
    };
  }

  async restoreWorkspace(id: string) {
    await this.mutation(id, 'restore');
    return this.store.exclusive(id, async () => {
      const row = await this.binding(id);
      if (row.state !== 'running' || !row.resource_id)
        throw sandboxConflict('Reconcile the sandbox before restoring.');
      const saved = await this.store.checkpoint(this.ownerId, row.workspace_id);
      const hash = saved?.archive_hash ?? null;
      if (row.restore_hash && row.restore_hash !== hash)
        throw sandboxConflict('This environment is bound to another checkpoint.');
      if (row.workspace_ready && row.restore_hash === hash) return publicEnvironment(row);
      // Initialization and restore are retryable; cloud allocation is not repeated.
      await this.store.restoreState(row, hash, false);
      await this.provider.initializeWorkspace(row.resource_id, row.id);
      if (saved) {
        await this.provider.importWorkspace(
          row.resource_id,
          row.id,
          this.store.readCheckpoint(this.ownerId, saved),
          saved.archive_hash,
        );
        const digest = createHash('sha256');
        for await (const chunk of this.provider.exportWorkspace(row.resource_id, row.id))
          digest.update(chunk);
        if (digest.digest('hex') !== saved.archive_hash)
          throw sandboxConflict('Restored workspace checksum does not match.');
      }
      await this.store.restoreState(row, hash, true);
      return publicEnvironment(await this.binding(id));
    });
  }

  async preview(id: string, port: unknown, epoch?: number) {
    await this.mutation(id, 'preview');
    if (
      !Number.isInteger(port) ||
      (port as number) < 1024 ||
      (port as number) > 65535 ||
      port === 49983
    )
      throw sandboxInvalid('Preview port must be 1024–65535, excluding the runtime control port.');
    previewConfig();
    const row = await this.running(id);
    if (epoch !== undefined && row.preview_epoch !== epoch)
      throw sandboxConflict('Workspace was stopped. Retry the operation.', 'WORKSPACE_STOPPED');
    return issuePreviewGrant({
      ownerId: this.ownerId,
      environmentId: row.id,
      port: port as number,
      epoch: row.preview_epoch,
    });
  }

  async revokePreviews(id: string) {
    await this.store.revokePreviews(await this.binding(id));
    return { revoked: true };
  }

  /** Only the authenticated preview gateway calls this; grants are server-issued, not owner input. */
  private static async resolvePreview(ticket: string, host: string) {
    const grant = verifyPreviewGrant(ticket, host);
    assertSandboxId(grant.environmentId);
    const config = await resolvedSandboxConfig();
    const store = await SandboxStore.open();
    const row = await store.get(grant.ownerId, grant.environmentId);
    assertWorkspaceMutation(grant.ownerId, row.workspace_id, row.id, 'preview');
    if (
      row.state !== 'running' ||
      !row.workspace_ready ||
      !row.resource_id ||
      row.connection_fingerprint !== config.fingerprint ||
      row.preview_epoch !== grant.epoch
    )
      throw sandboxConflict('Preview environment is unavailable or access was revoked.');
    const { E2BCompatibleSandboxProvider } = await import('./providers/e2b-compatible');
    const provider = new E2BCompatibleSandboxProvider(config);
    const expiresAt = Math.min(
      await provider.previewLifetime(row.resource_id, row.id),
      grant.expiresAt,
    );
    return { row, grant, provider, expiresAt };
  }

  static async previewTarget(ticket: string, host: string) {
    const { row, grant, provider, expiresAt } = await this.resolvePreview(ticket, host);
    if (previewConfig().transport === 'sdk')
      return { transport: 'sdk', url: `http://127.0.0.1:${grant.port}`, expiresAt };
    return {
      transport: 'native',
      ...(await provider.nativePreview(row.resource_id!, row.id, grant.port)),
      expiresAt,
    };
  }

  static async openPreviewConnection(ticket: string, host: string, signal: AbortSignal) {
    if (previewConfig().transport !== 'sdk')
      throw sandboxConflict('SDK preview transport is disabled.');
    const { row, grant, provider, expiresAt } = await this.resolvePreview(ticket, host);
    return provider.openPreviewConnection(
      row.resource_id!,
      row.id,
      grant.port,
      signal,
      expiresAt - Date.now(),
    );
  }
}
