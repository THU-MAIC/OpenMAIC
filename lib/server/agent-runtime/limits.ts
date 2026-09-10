/**
 * Upper bound, in characters, for agent session prompts and follow-up messages.
 *
 * The upstream runtime has no credit gate and no per-identity quota, so an
 * anonymous identity could otherwise post unbounded text and drive unbounded
 * database bloat and unbounded LLM spend. 100k characters is generous for
 * real course-building prompts while still bounding a single request.
 */
export const MAX_SESSION_TEXT_LENGTH = 100_000;
