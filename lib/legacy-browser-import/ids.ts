/**
 * Ids the importer derives.
 *
 * A course id is global on the server. When another owner already holds the
 * legacy id, the course is imported under a fresh id. "Fresh" is derived, not
 * drawn at random, from the legacy id and a random salt this browser keeps in
 * its ledger: a run that crashed between the save and the ledger write, or a
 * second tab running without Web Locks, computes the same id and finds its own
 * earlier copy instead of importing a second one. The salt makes the id
 * unlinkable to the owner and impossible for anyone else to predict and take
 * first.
 */
import { sha256Hex } from './digest';

/** The id a legacy course takes when its own id is held by another owner. */
export function freshStageId(legacyStageId: string, salt: string): string {
  return `${legacyStageId}-i${sha256Hex(`${salt}\u0000${legacyStageId}`).slice(0, 16)}`;
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
