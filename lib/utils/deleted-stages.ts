/**
 * Session-scoped deletion generations ("epochs") for deleted stages.
 *
 * Stage deletion races the debounced persistence pipeline: a flush round that
 * already captured its dirty snapshot, or the departing-stage snapshot taken
 * on navigation (which retries after a short delay), can outlive
 * `discardPendingStageChanges` and — because the incremental save falls back
 * to a full document write when the destination is missing — recreate a
 * document the user just deleted.
 *
 * A plain boolean tombstone cannot express the full lifecycle, because a
 * deleted id can legitimately come back: deletion only removes client-side
 * data, so the server copy restored by the classroom loader, or a backup
 * import, may recreate the SAME document id. Once such a restore lifts a
 * boolean tombstone, a pre-delete write still in flight becomes
 * indistinguishable from a post-restore edit and can overwrite the restored
 * document with pre-delete content.
 *
 * The epoch model separates the two concerns:
 *
 * - `stageDeletionEpoch(id)` is a monotonic per-stage generation counter
 *   (0 = never deleted). Every deletion bumps it; nothing ever rewinds it.
 * - `isStageDeleted(id)` is the "deletion currently in effect" flag. Explicit
 *   document (re)creation points clear it via `unmarkStageDeleted` — the
 *   epoch stays bumped.
 *
 * Write protocol: every persistence path captures `stageDeletionEpoch(id)` at
 * the moment it captures the data it intends to write (flush-round snapshot,
 * departing-stage snapshot, aggregate save entry), and re-checks
 * `isStageWriteStale(id, capturedEpoch)` immediately before each actual write.
 * A write is dropped when the stage is currently deleted OR its captured epoch
 * is no longer current. Invariants:
 *
 * 1. A write captured before a deletion can never land after it — not even
 *    when a same-id restore has lifted the deleted flag — because the
 *    deletion bumped the epoch and the captured epoch is permanently stale.
 * 2. A write capturing data after a restore observes the current epoch and
 *    persists normally.
 * 3. A deletion that fails before the document was removed lifts only the
 *    deleted flag; the bumped epoch stays. Restored pending changes are
 *    re-queued as change descriptors, so their eventual flush captures a
 *    fresh snapshot of the CURRENT store state under the CURRENT epoch —
 *    nothing replays a stale capture.
 *
 * In-memory only, on purpose: newly created stages mint fresh nanoids, so a
 * deleted id never collides with a NEW document, and after a reload this tab
 * has no surviving in-flight work to fence off. Explicit (re)creation paths
 * lift the deleted flag via `unmarkStageDeleted` (see
 * `applyClassroomStageAndScenes` and `importDatabase`); an in-flight flush
 * must never lift it — dropping exactly those writes is the fence's job.
 *
 * Known limit: the state is per-tab. A sibling tab editing the same stage
 * keeps its own scheduler and never sees this tab's deletion state, so its
 * flushes can still recreate the document — deletion vs. live editing in
 * another tab is a cross-tab invalidation problem outside this fence's scope.
 */

interface StageDeletionState {
  /** Monotonic deletion generation; bumped by every markStageDeleted. */
  epoch: number;
  /** True while a deletion is in effect (until an explicit restore lifts it). */
  deleted: boolean;
}

const stageDeletionStates = new Map<string, StageDeletionState>();

/**
 * Register a stage as deleted. Call before the deletion cascade starts.
 * Bumps the stage's deletion epoch, permanently invalidating every write
 * whose data was captured before this call.
 */
export function markStageDeleted(stageId: string): void {
  const state = stageDeletionStates.get(stageId);
  stageDeletionStates.set(stageId, { epoch: (state?.epoch ?? 0) + 1, deleted: true });
}

/**
 * Lift the deleted flag again. Only for explicit document existence changes:
 * a deletion that failed before the document was removed, or a deliberate
 * (re)creation of the same id (server-copy restore, backup import) — in both
 * cases the stage exists again, so later edits must persist normally. Never
 * call this from a persistence flush path.
 *
 * The deletion epoch is deliberately NOT rewound: writes captured before the
 * deletion stay permanently stale, so an in-flight pre-delete flush cannot
 * masquerade as an edit of the restored document.
 */
export function unmarkStageDeleted(stageId: string): void {
  const state = stageDeletionStates.get(stageId);
  if (state) state.deleted = false;
}

/** True while a deletion is in effect this session; persistence must drop writes. */
export function isStageDeleted(stageId: string): boolean {
  return stageDeletionStates.get(stageId)?.deleted ?? false;
}

/**
 * The stage's current deletion generation (0 = never deleted this session).
 * Persistence paths capture this together with the data they intend to write.
 */
export function stageDeletionEpoch(stageId: string): number {
  return stageDeletionStates.get(stageId)?.epoch ?? 0;
}

/**
 * True when a write whose data was captured under `capturedEpoch` must be
 * dropped: the stage is currently deleted, or a deletion happened after the
 * capture (epoch mismatch — stale even if a restore has since lifted the
 * deleted flag). Check immediately before each actual write.
 */
export function isStageWriteStale(stageId: string, capturedEpoch: number): boolean {
  const state = stageDeletionStates.get(stageId);
  if (!state) return capturedEpoch !== 0;
  return state.deleted || state.epoch !== capturedEpoch;
}
