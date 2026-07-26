/**
 * Session-scoped tombstones for deleted stages.
 *
 * Stage deletion races the debounced persistence pipeline: a flush round that
 * already captured its dirty snapshot, or the departing-stage snapshot taken
 * on navigation (which retries after a short delay), can outlive
 * `discardPendingStageChanges` and — because the incremental save falls back
 * to a full document write when the destination is missing — recreate a
 * document the user just deleted.
 *
 * The deletion path registers the stage id here BEFORE removing anything, and
 * every persistence landing point (scheduled flush, departing-stage retry,
 * aggregate and incremental saves, including their full-save fallbacks)
 * consults the set and drops the write instead of resurrecting the document.
 *
 * In-memory only, on purpose: stage ids are freshly minted nanoids, so a
 * deleted id is never legitimately reused, and after a reload there is no
 * surviving in-flight work to fence off.
 */

const deletedStageIds = new Set<string>();

/** Register a stage as deleted. Call before the deletion cascade starts. */
export function markStageDeleted(stageId: string): void {
  deletedStageIds.add(stageId);
}

/**
 * Lift a tombstone again. Only for a deletion that failed before the document
 * was removed — the stage still exists, so later edits must persist normally.
 */
export function unmarkStageDeleted(stageId: string): void {
  deletedStageIds.delete(stageId);
}

/** True when the stage was deleted this session; persistence must drop writes. */
export function isStageDeleted(stageId: string): boolean {
  return deletedStageIds.has(stageId);
}
