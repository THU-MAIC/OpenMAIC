/**
 * Ids the importer derives.
 *
 * A course id is global on the server. When another owner already holds the
 * legacy id, the course is imported under a fresh id -- and "fresh" is derived
 * from the owner and the legacy id rather than drawn at random, so a run that
 * lost its ledger (or crashed between the save and the ledger write) finds its
 * own earlier copy under the same id instead of importing a second one.
 */

/** 32-bit FNV-1a over UTF-16 code units, with a caller-chosen offset basis. */
function fnv1a(text: string, basis: number): number {
  let hash = basis >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A stable 12-hex-digit digest of `text` (two independent FNV-1a lanes). */
export function stableDigest(text: string): string {
  const high = fnv1a(text, 0x811c9dc5).toString(16).padStart(8, '0');
  const low = fnv1a(text, 0x050c5d1f).toString(16).padStart(8, '0');
  return `${high}${low}`.slice(0, 12);
}

/** The id a legacy course takes when its own id is held by another owner. */
export function freshStageId(legacyStageId: string, ownerId: string): string {
  return `${legacyStageId}-i${stableDigest(`${ownerId}\u0000${legacyStageId}`)}`;
}

/**
 * Carry an id that embeds the legacy course id over to the course's server id.
 *
 * Runtime session and record ids name their course -- `chat:<stage>:...`
 * (URI-encoded) and `pbl-<stage>-...` (raw) -- and the chat layer finds a
 * session by that prefix. The learner segment is left as it was: re-keying a
 * learner never rewrites ids (the runtime contract's `mergeLearner` does the
 * same), and readers select sessions by their `learnerKey` field.
 */
export function rewriteStageSegment(id: string, fromStageId: string, toStageId: string): string {
  if (fromStageId === toStageId) return id;
  const encodedFrom = encodeURIComponent(fromStageId);
  const encodedTo = encodeURIComponent(toStageId);
  let rewritten = id.split(encodedFrom).join(encodedTo);
  if (encodedFrom !== fromStageId) rewritten = rewritten.split(fromStageId).join(toStageId);
  return rewritten;
}
