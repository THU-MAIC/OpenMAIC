/**
 * Tool-call argument normalization for the pi stream adapter.
 *
 * pi tools and every provider that replays a tool call expect `arguments` /
 * `input` to be a plain JSON object. When a model emits malformed JSON, the AI
 * SDK hands back the raw string instead; storing it verbatim makes every later
 * turn fail on providers that require an object, so the session can never
 * recover. The raw string is therefore never stored — but the parse failure is
 * kept under a reserved key so pi's argument validation error ("Validation
 * failed for tool …", which echoes the received arguments) tells the model WHY
 * its call had no usable arguments instead of only listing missing fields.
 */

/** Reserved argument key carrying the parse diagnosis; stripped on replay. */
export const TOOL_ARGUMENTS_ERROR_KEY = '__toolArgumentsError';

const EXCERPT_RADIUS = 40;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** Human-readable parse failure with the position and the text around it. */
export function describeToolArgumentsParseError(raw: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const reason =
    message
      .replace(/,? "[\s\S]*" is not valid JSON$/, '')
      .replace(/ in JSON at position \d+[\s\S]*$/, '')
      .trim() || 'parse error';
  const match = /at position (\d+)/.exec(message);
  const position = match ? Number(match[1]) : raw.length;
  const start = Math.max(0, position - EXCERPT_RADIUS);
  const end = Math.min(raw.length, position + EXCERPT_RADIUS);
  const excerpt = `${start > 0 ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`;
  return (
    `Tool arguments were not valid JSON (${reason} at position ${position} of ${raw.length} chars, near ${JSON.stringify(excerpt)}). ` +
    'Check quote escaping inside string values, then resend the complete call.'
  );
}

/**
 * Normalize a tool call's input into plain-object arguments: a plain object is
 * used as is, a string that parses to a plain object is parsed, anything else
 * becomes `{}` plus a `TOOL_ARGUMENTS_ERROR_KEY` diagnosis.
 */
export function toolCallArguments(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      return { [TOOL_ARGUMENTS_ERROR_KEY]: describeToolArgumentsParseError(value, error) };
    }
    if (isPlainObject(parsed)) return parsed;
    return {
      [TOOL_ARGUMENTS_ERROR_KEY]: `Tool arguments must be a JSON object, got ${kindOf(parsed)}.`,
    };
  }
  return {
    [TOOL_ARGUMENTS_ERROR_KEY]: `Tool arguments must be a JSON object, got ${kindOf(value)}.`,
  };
}

/** Arguments to replay to a provider: always a plain object, never the diagnosis. */
export function replayToolCallArguments(value: unknown): Record<string, unknown> {
  const args = toolCallArguments(value);
  if (!Object.prototype.hasOwnProperty.call(args, TOOL_ARGUMENTS_ERROR_KEY)) return args;
  const rest = { ...args };
  delete rest[TOOL_ARGUMENTS_ERROR_KEY];
  return rest;
}

/**
 * The parse diagnosis carried by a tool call's arguments, if any. pi's schema
 * validation already surfaces it when a required field is missing; a tool whose
 * parameters are all optional would otherwise run with defaults, so the agent
 * blocks such a call before execution with this message.
 */
export function toolArgumentsError(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[TOOL_ARGUMENTS_ERROR_KEY];
  return typeof value === 'string' ? value : undefined;
}
