import { SandboxError } from '@/lib/sandbox/errors';

export type CheckpointFailureReason =
  | 'source-limit'
  | 'archive-limit'
  | 'unsupported-files'
  | 'workspace-permission'
  | 'workspace-full'
  | 'execution-unsettled'
  | 'storage-quota'
  | 'storage-config'
  | 'storage-permission'
  | 'timeout'
  | 'workspace-changed'
  | 'unavailable';
export type CheckpointStage =
  | 'snapshot'
  | 'archive'
  | 'recovery'
  | 'release'
  | 'execution'
  | 'collection'
  | 'terminal';

export function checkpointBusy(error: unknown) {
  return (
    error instanceof SandboxError &&
    [409, 429].includes(error.status) &&
    ['ENVIRONMENT_BUSY', 'WORKSPACE_COMMAND_ACTIVE', 'WORKSPACE_TERMINAL_ACTIVE'].includes(
      error.reason ?? '',
    )
  );
}

export class CheckpointAttemptError extends Error {
  constructor(
    readonly stage: CheckpointStage,
    readonly failure: { reason: CheckpointFailureReason; retryable: boolean },
  ) {
    super('Workspace checkpoint failed.');
  }
}

export async function checkpointStep<T>(stage: CheckpointStage, action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (checkpointBusy(error)) throw error;
    throw new CheckpointAttemptError(stage, checkpointFailure(error));
  }
}

export function checkpointFailure(error: unknown) {
  if (error instanceof CheckpointAttemptError) return error.failure;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  let reason: CheckpointFailureReason = 'unavailable';
  if (
    error instanceof SandboxError &&
    ['PBL_SOURCE_COUNT', 'PBL_SOURCE_SIZE'].includes(error.reason ?? '')
  )
    reason = 'source-limit';
  else if (code === 'SANDBOX_STORAGE_LIMIT') reason = 'storage-quota';
  else if (
    [
      'SANDBOX_CHECKPOINT_CONFIG',
      'SANDBOX_CHECKPOINT_STORAGE_UNAVAILABLE',
      'ASSET_STORAGE_CONFIG',
    ].includes(String(code))
  )
    reason = 'storage-config';
  else if (code === 'ASSET_STORAGE_PERMISSION') reason = 'storage-permission';
  else if (code === 'CHECKPOINT_ARCHIVE_LIMIT') reason = 'archive-limit';
  else if (code === 'CHECKPOINT_UNSUPPORTED_FILES') reason = 'unsupported-files';
  else if (code === 'CHECKPOINT_WORKSPACE_PERMISSION') reason = 'workspace-permission';
  else if (code === 'CHECKPOINT_WORKSPACE_FULL') reason = 'workspace-full';
  else if (code === 'CHECKPOINT_CHANGED') reason = 'workspace-changed';
  else if (
    code === 'ASSET_STORAGE_TIMEOUT' ||
    (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
  )
    reason = 'timeout';
  return { reason, retryable: ['timeout', 'workspace-changed', 'unavailable'].includes(reason) };
}

/** Race only external I/O, never a DB transaction or a callback that can commit late. */
export async function checkpointIO<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation();
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation(), interrupted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
