export interface ASRServerControl {
  serverDisabled?: boolean;
}

export const ASR_SERVER_DISABLED_MESSAGE = 'This ASR provider is disabled by the server';

/** Server force-off takes precedence even for ASR that executes entirely in the browser. */
export function getASRServerDisabledError(config?: ASRServerControl): string | undefined {
  return config?.serverDisabled ? ASR_SERVER_DISABLED_MESSAGE : undefined;
}
