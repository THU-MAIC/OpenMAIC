/**
 * Draft generation stamps — how a composer draft store tells "the ref I just
 * sent" apart from "a ref with the same identity the user re-picked while the
 * POST was in flight".
 *
 * Identity alone cannot answer that: both items ARE the same course/element.
 * So every item a draft store accepts carries a monotonic, non-enumerable local
 * token, and a send only removes the items whose stamp matches the snapshot it
 * actually sent. The token is deliberately a Symbol-keyed, non-enumerable
 * property: it must never be serialized onto the wire, must never appear in a
 * `JSON.stringify` body assertion, and must survive an ordinary `{...ref}`
 * spread being *lost* (a copy is a new pick, not the sent one).
 *
 * Extracted from the element-refs store so the course-refs store shares the one
 * implementation rather than growing a second, subtly different copy.
 */

const DRAFT_GENERATION = Symbol('composer-draft-generation');

export type DraftStamped<T> = T & { readonly [DRAFT_GENERATION]: number };

/** A copy of `value` carrying `generation` as a hidden, non-enumerable stamp. */
export function stampDraft<T extends object>(value: T, generation: number): DraftStamped<T> {
  const next = { ...value } as DraftStamped<T>;
  Object.defineProperty(next, DRAFT_GENERATION, { value: generation, enumerable: false });
  return next;
}

/** The item's stamp, or `null` for anything this process did not stamp. */
export function draftGeneration(value: object): number | null {
  return (value as Partial<DraftStamped<object>>)[DRAFT_GENERATION] ?? null;
}

/**
 * Do these two items name the same draft pick — same identity AND same stamp?
 * An unstamped snapshot never matches, so a hand-built or replayed item cannot
 * clear a live draft.
 */
export function sameDraftPick<T extends object>(
  a: T,
  b: T,
  sameIdentity: (a: T, b: T) => boolean,
): boolean {
  const generation = draftGeneration(b);
  return sameIdentity(a, b) && generation !== null && generation === draftGeneration(a);
}
