/** Public sandbox values are provider-neutral and contain no SDK handles or access tokens. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_COMMAND_BYTES = 32 * 1024;
export type SandboxProfile = 'code' | 'desktop';

export type SandboxState =
  | 'creating'
  | 'unknown'
  | 'running'
  | 'paused'
  | 'missing'
  | 'destroying'
  | 'destroyed';

export interface SandboxEnvironment {
  /** A never-reused host operation ID, not the provider's resource ID. */
  id: string;
  workspaceId: string;
  profile: SandboxProfile;
  state: SandboxState;
  workspaceReady: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxResource {
  id: string;
  state: 'running' | 'paused';
}

export interface SandboxCommandInput {
  id: string;
  command: string;
  cwd?: string;
  timeoutMs: number;
}

export interface SandboxCommandResult {
  id: string;
  state: 'starting' | 'running' | 'exited' | 'cancelled' | 'timed_out' | 'failed' | 'unknown';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}

export type DesktopAction =
  | { type: 'move' | 'click'; x: number; y: number }
  | { type: 'write'; text: string }
  | { type: 'press'; keys: string[] };

export interface SandboxTerminal {
  id: string;
  state: 'creating' | 'unknown' | 'running' | 'closed';
}

/** Server-side provider interface. Never serialize this adapter or its preview transport credentials to clients. */
/** Reserved flags; operation APIs are deferred until a real consumer implements them. */
export interface SandboxLifecycleCapabilities {
  readonly pause: boolean;
  readonly desktopStream: boolean;
}

export interface SandboxProvider {
  readonly capabilities: SandboxLifecycleCapabilities;
  exportWorkspace(
    resourceId: string,
    operationId: string,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
  importWorkspace(
    resourceId: string,
    operationId: string,
    bytes: AsyncIterable<Uint8Array>,
    hash: string,
  ): Promise<void>;
  /** Idempotent initialization before a newly created or adopted workspace becomes ready. */
  initializeWorkspace(resourceId: string, operationId: string): Promise<void>;
  listWorkspace(
    resourceId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; bytes: number }>>;
  /** Extend the lease without shortening any existing remaining lifetime. */
  renew(
    resourceId: string,
    operationId: string,
    lifetimeMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Server-only descriptor. Never serialize its credentials into a browser API response. */
  nativePreview(
    resourceId: string,
    operationId: string,
    port: number,
  ): Promise<{
    url: string;
    headers: Record<string, string>;
  }>;
  previewLifetime(resourceId: string, operationId: string): Promise<number>;
  openPreviewConnection(
    resourceId: string,
    operationId: string,
    port: number,
    signal: AbortSignal,
    durationMs: number,
  ): Promise<{
    output: ReadableStream<Uint8Array>;
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
  create(operationId: string, profile: SandboxProfile): Promise<SandboxResource>;
  /** Discovery must match the exact operation, not an owner-wide "first result". */
  find(operationId: string): Promise<SandboxResource[]>;
  inspect(resourceId: string, operationId: string): Promise<SandboxResource | null>;
  destroy(resourceId: string, operationId: string): Promise<void>;
  readText(
    resourceId: string,
    operationId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<string>;
  writeText(resourceId: string, operationId: string, path: string, text: string): Promise<void>;
  mutateFile?(
    resourceId: string,
    operationId: string,
    input: {
      action: 'create' | 'delete' | 'rename';
      path: string;
      destination?: string;
      expectedHash?: string;
      text?: string;
    },
  ): Promise<void>;
  startCommand(resourceId: string, operationId: string, input: SandboxCommandInput): Promise<void>;
  readCommand(
    resourceId: string,
    operationId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<SandboxCommandResult>;
  cancelCommand(resourceId: string, operationId: string, id: string): Promise<void>;
  desktopScreenshot(resourceId: string, operationId: string): Promise<Uint8Array>;
  desktopAction(resourceId: string, operationId: string, action: DesktopAction): Promise<void>;
  createTerminal(
    resourceId: string,
    operationId: string,
    id: string,
    cols: number,
    rows: number,
  ): Promise<number>;
  findTerminal(
    resourceId: string,
    operationId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<number | null>;
  terminalInput(resourceId: string, operationId: string, pid: number, data: string): Promise<void>;
  resizeTerminal(
    resourceId: string,
    operationId: string,
    pid: number,
    cols: number,
    rows: number,
  ): Promise<void>;
  closeTerminal(
    resourceId: string,
    operationId: string,
    pid: number,
    terminalId: string,
  ): Promise<void>;
  terminalStream(
    resourceId: string,
    operationId: string,
    pid: number,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
}
