import { getClientTranslation } from '@/lib/i18n';
import type { SandboxErrorReason } from './errors';

const reasonKeys: Record<SandboxErrorReason, string> = {
  ENVIRONMENT_BUSY: 'sandbox.errors.environmentBusy',
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
  if (error?.reason) {
    const key = Object.hasOwn(reasonKeys, error.reason)
      ? reasonKeys[error.reason as SandboxErrorReason]
      : 'sandbox.requestFailed';
    return getClientTranslation(key);
  }
  return error?.message || getClientTranslation('sandbox.requestFailed');
}
