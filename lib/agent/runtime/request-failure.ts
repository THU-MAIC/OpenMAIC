/** Stable, non-sensitive execution reasons; persisted in AgentSessionMeta.error and session_end. */
export const MODEL_REQUEST_IDLE_TIMEOUT = 'MODEL_REQUEST_IDLE_TIMEOUT';
export const MODEL_REQUEST_FAILED = 'MODEL_REQUEST_FAILED';
export type ModelRequestFailureCode =
  | typeof MODEL_REQUEST_IDLE_TIMEOUT
  | typeof MODEL_REQUEST_FAILED;

export function modelRequestFailureCode(error: unknown): ModelRequestFailureCode | null {
  if (typeof error !== 'string') return null;
  if (error.startsWith(`[${MODEL_REQUEST_IDLE_TIMEOUT}]`)) return MODEL_REQUEST_IDLE_TIMEOUT;
  if (error.startsWith(`[${MODEL_REQUEST_FAILED}]`)) return MODEL_REQUEST_FAILED;
  return null;
}

export function modelRequestFailure(error: string): string {
  return modelRequestFailureCode(error) ? error : `[${MODEL_REQUEST_FAILED}] ${error}`;
}

export const AGENT_EXECUTION_IDLE_TIMEOUT = 'AGENT_EXECUTION_IDLE_TIMEOUT';
export type ExecutionFailureCode = ModelRequestFailureCode | typeof AGENT_EXECUTION_IDLE_TIMEOUT;
export function executionFailureCode(error: unknown): ExecutionFailureCode | null {
  return typeof error === 'string' && error.startsWith(`[${AGENT_EXECUTION_IDLE_TIMEOUT}]`)
    ? AGENT_EXECUTION_IDLE_TIMEOUT
    : modelRequestFailureCode(error);
}
