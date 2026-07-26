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
 * In-memory only, on purpose: newly created stages mint fresh nanoids, so a
 * deleted id never collides with a NEW document, and after a reload this tab
 * has no surviving in-flight work to fence off. A deleted id CAN legitimately
 * come back, though — deletion only removes client-side data, so the server
 * copy restored by the classroom loader, or a backup restore, may recreate the
 * same document. Every such explicit (re)creation path must lift the tombstone
 * via `unmarkStageDeleted` (see `applyClassroomStageAndScenes` and
 * `importDatabase`); an in-flight flush must never lift it — dropping exactly
 * those writes is the tombstone's job.
 *
 * Known limit: the set is per-tab. A sibling tab editing the same stage keeps
 * its own scheduler and never sees this tab's tombstone, so its flushes can
 * still recreate the document — deletion vs. live editing in another tab is a
 * cross-tab invalidation problem outside this fence's scope.
 */

const deletedStageIds = new Set<string>();

/** Register a stage as deleted. Call before the deletion cascade starts. */
export function markStageDeleted(stageId: string): void {
  deletedStageIds.add(stageId);
}

/**
 * Lift a tombstone again. Only for explicit document existence changes: a
 * deletion that failed before the document was removed, or a deliberate
 * (re)creation of the same id (server-copy restore, backup import) — in both
 * cases the stage exists again, so later edits must persist normally. Never
 * call this from a persistence flush path.
 */
export function unmarkStageDeleted(stageId: string): void {
  deletedStageIds.delete(stageId);
}

/** True when the stage was deleted this session; persistence must drop writes. */
export function isStageDeleted(stageId: string): boolean {
  return deletedStageIds.has(stageId);
}
