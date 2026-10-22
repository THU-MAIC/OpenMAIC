export type SandboxErrorReason =
  | 'ENVIRONMENT_UNAVAILABLE'
  | 'ENVIRONMENT_BUSY'
  | 'ENVIRONMENT_CHANGED'
  | 'PROGRESS_CHANGED'
  | 'WORKBENCH_ACCESS_DENIED'
  | 'WORKSPACE_FILE_CONFLICT'
  | 'WORKSPACE_STOPPED'
  | 'PBL_SOURCE_PATH'
  | 'PBL_SOURCE_COUNT'
  | 'PBL_SOURCE_SIZE'
  | 'WORKSPACE_COMMAND_ACTIVE'
  | 'WORKSPACE_TERMINAL_ACTIVE';

/** Only these fixed messages cross the HTTP boundary; SDK errors can contain credentials. */
export class SandboxError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly reason?: SandboxErrorReason,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export function sandboxConflict(message: string, reason?: SandboxErrorReason): SandboxError {
  return new SandboxError('SANDBOX_CONFLICT', 409, message, reason);
}

export function sandboxNotFound(): SandboxError {
  return new SandboxError('SANDBOX_NOT_FOUND', 404, 'Sandbox environment not found.');
}

export function sandboxInvalid(message: string, reason?: SandboxErrorReason): SandboxError {
  return new SandboxError('SANDBOX_INVALID_REQUEST', 400, message, reason);
}
