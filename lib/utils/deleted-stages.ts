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
  /**
   * Number of deletion cascades currently running whose outcome is not yet
   * known. While it is positive, the deleted flag alone must not be read as
   * "the document is gone": a cascade can still fail before removing the
   * document, in which case the flag is lifted and the warm store state (plus
   * restored pending dirt) is the user's only copy of the pre-delete edits.
   *
   * A counter, not a boolean: `deleteStageData` single-flights concurrent
   * deletions of the same stage, but this module must not depend on that —
   * with overlapping begin/settle pairs the stage stays in flight until the
   * LAST cascade settles, instead of the first settle clearing a bit while
   * another cascade is still undecided.
   */
  unsettledCascades: number;
}

const stageDeletionStates = new Map<string, StageDeletionState>();

/**
 * Per-stage settlement promise for the currently in-flight cascade(s).
 * Created when the first cascade begins, resolved (and dropped) when the last
 * one settles, so read-side waiters can `await` the outcome instead of
 * polling `isStageDeletionInFlight`.
 */
const cascadeSettlements = new Map<string, { promise: Promise<void>; resolve: () => void }>();

/**
 * Register a stage as deleted. Call before the deletion cascade starts.
 * Bumps the stage's deletion epoch, permanently invalidating every write
 * whose data was captured before this call.
 */
export function markStageDeleted(stageId: string): void {
  const state = stageDeletionStates.get(stageId);
  stageDeletionStates.set(stageId, {
    epoch: (state?.epoch ?? 0) + 1,
    deleted: true,
    // Not a settlement event: an import-rollback re-mark records a document
    // whose absence is already a settled fact, so it must not touch the count.
    unsettledCascades: state?.unsettledCascades ?? 0,
  });
}

/**
 * Record that a deletion cascade for `stageId` has started and its outcome —
 * document removed, or deletion failed before removal — is not yet known.
 * Called by `deleteStageData` immediately after `markStageDeleted`; no other
 * mark point starts a cascade.
 */
export function beginStageDeletionCascade(stageId: string): void {
  const state = stageDeletionStates.get(stageId);
  if (!state) return;
  state.unsettledCascades += 1;
  if (!cascadeSettlements.has(stageId)) {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    cascadeSettlements.set(stageId, { promise, resolve });
  }
}

/**
 * A cascade's outcome is now known: either the document was confirmed
 * removed (deleted flag kept) or the deletion failed before removing it
 * (flag lifted). Once the LAST overlapping cascade settles, read-side
 * consumers may act on the deleted flag again and every settlement waiter is
 * released. Extra settles (no matching begin) are no-ops — the count never
 * underflows into a phantom cascade.
 */
export function settleStageDeletionCascade(stageId: string): void {
  const state = stageDeletionStates.get(stageId);
  if (!state || state.unsettledCascades === 0) return;
  state.unsettledCascades -= 1;
  if (state.unsettledCascades === 0) {
    const settlement = cascadeSettlements.get(stageId);
    cascadeSettlements.delete(stageId);
    settlement?.resolve();
  }
}

/**
 * True while a deletion cascade for `stageId` is running and unsettled. The
 * deleted-warm branch in `loadFromStorage` must keep the warm state (and any
 * restorable pending dirt) until the deletion settles — discarding early
 * would lose the only copy of pre-delete edits if the cascade then fails
 * before removing the document.
 */
export function isStageDeletionInFlight(stageId: string): boolean {
  return (stageDeletionStates.get(stageId)?.unsettledCascades ?? 0) > 0;
}

/**
 * Resolves when every currently in-flight deletion cascade for `stageId` has
 * settled (already-resolved when none is in flight). Read-side consumers that
 * cannot proceed until the outcome is known — the deleted-warm branch in
 * `loadFromStorage` — await this instead of completing early. Never rejects:
 * a failed cascade still settles (its `finally` runs after the failure path
 * lifted the flag / restored dirt), so waiters observe the post-outcome flag
 * state, not the error.
 */
export function stageDeletionSettled(stageId: string): Promise<void> {
  return cascadeSettlements.get(stageId)?.promise ?? Promise.resolve();
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
