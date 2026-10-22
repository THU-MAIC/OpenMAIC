import { getClientTranslation } from '@/lib/i18n';
import type { SandboxErrorReason } from './errors';

const reasonKeys: Record<SandboxErrorReason, string> = {
  ENVIRONMENT_UNAVAILABLE: 'sandbox.errors.environmentUnavailable',
  ENVIRONMENT_BUSY: 'sandbox.errors.environmentBusy',
  ENVIRONMENT_CHANGED: 'sandbox.errors.environmentChanged',
  PROGRESS_CHANGED: 'sandbox.errors.progressChanged',
  WORKBENCH_ACCESS_DENIED: 'sandbox.errors.workbenchAccessDenied',
  WORKSPACE_FILE_CONFLICT: 'sandbox.errors.fileConflict',
  WORKSPACE_STOPPED: 'sandbox.errors.stopped',
  PBL_SOURCE_PATH: 'sandbox.errors.sourcePath',
  PBL_SOURCE_COUNT: 'sandbox.errors.sourceCount',
  PBL_SOURCE_SIZE: 'sandbox.errors.sourceSize',
  WORKSPACE_COMMAND_ACTIVE: 'sandbox.errors.commandActive',
  WORKSPACE_TERMINAL_ACTIVE: 'sandbox.errors.terminalActive',
};

/** Translate structured workspace errors; retain fixed server messages for legacy errors. */
export function sandboxErrorMessage(error?: {
  code?: string;
  reason?: string;
  message?: string;
}): string {
  if (error?.code === 'PBL_WORKSPACE_MANAGED')
    return getClientTranslation('sandbox.errors.learningManaged');
  if (error?.code === 'PBL_PROMPT_SIZE')
    return getClientTranslation('sandbox.errors.teachingContextSize');
  if (error?.reason) {
    const key = Object.hasOwn(reasonKeys, error.reason)
      ? reasonKeys[error.reason as SandboxErrorReason]
      : 'sandbox.requestFailed';
    return getClientTranslation(key);
  }
  if (error?.code === 'SANDBOX_UNAVAILABLE')
    return getClientTranslation('sandbox.errors.unavailable');
  if (error?.code === 'SANDBOX_INVALID_REQUEST')
    return getClientTranslation('sandbox.errors.invalidRequest');
  if (error?.code === 'SANDBOX_UNSUPPORTED')
    return getClientTranslation('sandbox.errors.unsupported');
  return error?.message || getClientTranslation('sandbox.requestFailed');
}
