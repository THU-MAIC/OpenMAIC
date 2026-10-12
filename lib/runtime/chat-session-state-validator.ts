import type { CueUserState } from '@/lib/types/chat';

// Keep the durable cue within the same display limits as cue_user. The fixed
// key sets also prevent unbounded metadata hidden alongside these fields.
const MAX_CUE_AGENT_ID_LENGTH = 256;
const MAX_CUE_PROMPT_LENGTH = 240;
const MAX_CUE_OPTION_LENGTH = 60;
const CUE_KEYS = new Set(['fromAgentId', 'prompt', 'options', 'parkedAt']);
const OPTION_KEYS = new Set(['label', 'action']);

// Director context is cumulative across turns. Bound both collection work and
// the complete serialized UTF-8 size, including nested content and extra keys.
const MAX_DIRECTOR_COLLECTION_LENGTH = 256;
const MAX_DIRECTOR_STATE_BYTES = 64 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionLabel(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_CUE_OPTION_LENGTH
  );
}

function isValidOption(value: unknown): boolean {
  if (typeof value === 'string') return isOptionLabel(value);
  return (
    isObject(value) &&
    Object.keys(value).every((key) => OPTION_KEYS.has(key)) &&
    isOptionLabel(value.label) &&
    (value.action === undefined || value.action === 'end_discussion')
  );
}

/** Validate without normalizing or dropping a structured option's action. */
export function isValidCueUserState(value: unknown): value is CueUserState {
  if (!isObject(value) || !Object.keys(value).every((key) => CUE_KEYS.has(key))) return false;
  return (
    typeof value.parkedAt === 'number' &&
    Number.isFinite(value.parkedAt) &&
    (value.fromAgentId === undefined ||
      (typeof value.fromAgentId === 'string' &&
        value.fromAgentId.length <= MAX_CUE_AGENT_ID_LENGTH)) &&
    (value.prompt === undefined ||
      (typeof value.prompt === 'string' && value.prompt.length <= MAX_CUE_PROMPT_LENGTH)) &&
    (value.options === undefined ||
      (Array.isArray(value.options) &&
        value.options.length >= 2 &&
        value.options.length <= 4 &&
        value.options.every(isValidOption)))
  );
}

/** Validate the director envelope and bounds; nested action data stays extensible. */
export function isValidDirectorState(value: unknown): boolean {
  if (
    !isObject(value) ||
    typeof value.turnCount !== 'number' ||
    !Number.isFinite(value.turnCount) ||
    !Number.isInteger(value.turnCount) ||
    value.turnCount < 0 ||
    !Array.isArray(value.agentResponses) ||
    value.agentResponses.length > MAX_DIRECTOR_COLLECTION_LENGTH ||
    !Array.isArray(value.whiteboardLedger) ||
    value.whiteboardLedger.length > MAX_DIRECTOR_COLLECTION_LENGTH
  ) {
    return false;
  }
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_DIRECTOR_STATE_BYTES;
  } catch {
    return false;
  }
}
