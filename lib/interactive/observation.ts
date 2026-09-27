/** Experimental, declared semantic evidence. Not a complete JS-state export or tool authority. */

export const OBSERVATION_VERSION = 1;
export const OBSERVATION_MAX_BYTES = 32_768;
/**
 * Nesting bound, checked iteratively. Bytes do not bound depth — 20 KB of JSON
 * can nest ten thousand levels — and every later step over a report
 * (`JSON.stringify`, `structuredClone`, freezing) recurses and throws
 * `RangeError` past the engine's stack. This is a platform bound like the byte
 * cap, not a requirement on what a lesson reports.
 */
export const OBSERVATION_MAX_DEPTH = 64;
export const OBSERVATION_ATTRIBUTE = 'data-maic-observation';
/**
 * The single declared activity scope a page publishes state for. It names the
 * state-evidence scope only; it is never the identity of a referenced component.
 */
export const OBSERVATION_SCOPE_ID = 'experiment';
/** Optional browser capability; unsupported contexts retain static references. */
export function supportsInteractiveObservation(): boolean {
  return (
    typeof globalThis.crypto?.randomUUID === 'function' &&
    typeof globalThis.crypto?.subtle?.digest === 'function' &&
    typeof globalThis.AbortSignal?.any === 'function'
  );
}

/**
 * A page's own report of what its activity is now.
 *
 * Generation asks for a `summary` and a `state`; reading enforces neither. A
 * report that drifts from the asked-for shape is still the only account of the
 * activity there is, and dropping it would cost that lesson the capability over
 * a field name. So this layer parses, bounds bytes, and hands the result on;
 * identity and freshness are checked where the platform message is handled.
 *
 * An earlier revision required an objects/facts/relations graph with declared
 * relation completeness, and that was the wrong place for it: the reader of this
 * JSON is a language model that reads free-form data fine, while the writer is a
 * generator least reliable exactly on the load-bearing fields. A carelessly
 * emitted `complete` would have had the platform certify that unlisted
 * relationships were provably absent.
 *
 * "Unknown stays unknown" is a prompt-level instruction and lives with the
 * request evidence, not in this shape.
 */
export type Observation = unknown;
export type UnavailableReason =
  | 'no-interface'
  | 'not-ready'
  | 'invalid-data'
  | 'too-large'
  | 'scope-changed'
  | 'document-changed'
  | 'timeout'
  | 'cancelled';
export type ParsedObservation =
  | { status: 'available'; observation: Observation }
  | { status: 'unavailable'; reason: UnavailableReason };

/** Iterative, so measuring the bound cannot itself overflow the stack. */
export function exceedsDepth(value: unknown, limit = OBSERVATION_MAX_DEPTH): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  while (stack.length) {
    const { value: current, depth } = stack.pop()!;
    if (!current || typeof current !== 'object') continue;
    if (depth > limit) return true;
    for (const child of Object.values(current)) stack.push({ value: child, depth: depth + 1 });
  }
  return false;
}

export function parseObservation(raw: string): ParsedObservation {
  if (
    raw.length > OBSERVATION_MAX_BYTES ||
    new TextEncoder().encode(raw).length > OBSERVATION_MAX_BYTES
  )
    return { status: 'unavailable', reason: 'too-large' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (exceedsDepth(parsed)) return { status: 'unavailable', reason: 'too-large' };
    return { status: 'available', observation: parsed };
  } catch {
    return { status: 'unavailable', reason: 'invalid-data' };
  }
}

/** Request results are detached and recursively frozen; future publications cannot change them. */
export function freezeEvidence<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeEvidence(item);
    Object.freeze(value);
  }
  return value;
}
