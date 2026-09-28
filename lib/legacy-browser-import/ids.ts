/**
 * Ids the importer derives.
 *
 * A course id is global on the server. When another owner already holds the
 * legacy id, the course is imported under a fresh id. "Fresh" is derived, not
 * drawn at random, from the legacy id and this browser's random id (kept in
 * the ledger): a run that crashed between the save and the ledger write, or a
 * second tab running without Web Locks, computes the same id and finds its own
 * earlier copy instead of importing a second one. The browser id also makes
 * the fresh id unpredictable to anyone else.
 */
import { sha256Hex } from './digest';

/** The id a legacy course takes when its own id is held by another owner. */
export function freshStageId(legacyStageId: string, browserId: string): string {
  return `${legacyStageId}-i${sha256Hex(`${browserId}\u0000${legacyStageId}`).slice(0, 16)}`;
}

/** Runtime id families whose second `:`-separated segment is the course id (URI-encoded). */
const STAGE_SEGMENT_PREFIXES = new Set([
  'chat',
  'chat-restore-marker',
  'chat-deletion',
  'whiteboard',
  'quiz-attempt',
]);

/**
 * Carry an id that names the legacy course over to the course's server id.
 *
 * Runtime session and record ids name their course in a fixed position --
 * `chat:<stage>:<learner>:<chat>`, `chat-restore-marker:<stage>:...`,
 * `chat-deletion:<stage>:...`, `whiteboard:<stage>:<learner>`,
 * `quiz-attempt:<stage>:<scene>:<learner>` (URI-encoded segments; record ids
 * extend their session's), and `pbl-<stage>-<learner>` (raw) -- and the chat
 * layer finds a session by that prefix. Only that segment is replaced, so a
 * short course id that also occurs elsewhere in the id cannot corrupt the
 * prefix, the learner or the chat segment. The learner segment is left as it
 * was: re-keying a learner never rewrites ids (the runtime contract's
 * `mergeLearner` does the same), and readers select sessions by their
 * `learnerKey` field. Any other id is returned unchanged.
 */
export function rewriteStageSegment(id: string, fromStageId: string, toStageId: string): string {
  if (fromStageId === toStageId) return id;
  const parts = id.split(':');
  if (
    parts.length >= 2 &&
    STAGE_SEGMENT_PREFIXES.has(parts[0]!) &&
    parts[1] === encodeURIComponent(fromStageId)
  ) {
    parts[1] = encodeURIComponent(toStageId);
    return parts.join(':');
  }
  const pbl = `pbl-${fromStageId}-`;
  if (id.startsWith(pbl)) return `pbl-${toStageId}-${id.slice(pbl.length)}`;
  return id;
}
