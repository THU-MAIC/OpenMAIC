/**
 * "We do not know whether this viewer owns this course" — the third ownership
 * state, carried beside the store rather than inside it (the reference's
 * `ownership-signal.ts`, trimmed to what this branch's classroom needs).
 *
 * The stage-meta sidecar answers THREE outcomes; the store holds only booleans.
 * `isOwner === false` must therefore never be read as "this is a stranger's
 * course" when the sidecar never answered: the classroom's edit gate fails
 * closed, but the destructive "visitor" conclusions (cleanup, hydration) must
 * not fire on a misjudged owner. This module records which outcome a load
 * actually got, so consumers can tell "not the owner" from "we do not know".
 *
 * The reference's full module adds per-load probe-id ordering to resolve
 * overlapping A → B → A loads; this branch's classroom has no destructive
 * visitor path, so a plain per-stage last-write record is sufficient.
 */

export interface StageAccessSignal {
  isOwner: boolean;
}

const stageOwnership = new Map<string, { resolved: boolean; access: StageAccessSignal | null }>();

/**
 * Record what the most recent load of `stageId` learned about ownership.
 *
 * `resolved: true` for any load that got an answer (owner or not), which
 * clears a previous outage. `access` is the answer for a 200; `null` for a
 * definite 404 (the sidecar says no such course for this viewer).
 */
export function noteStageOwnership(
  stageId: string,
  resolved: boolean,
  access: StageAccessSignal | null = null,
): void {
  stageOwnership.set(stageId, { resolved, access });
}

/** True when the most recent load of `stageId` could not establish ownership. */
export function isStageOwnershipUnknown(stageId: string): boolean {
  return stageOwnership.get(stageId)?.resolved === false;
}

/** Latest resolved sidecar access, including when the document read was absent. */
export function getStageAccessSignal(stageId: string): StageAccessSignal | null {
  const recorded = stageOwnership.get(stageId);
  return recorded?.resolved ? recorded.access : null;
}

/**
 * Access defaults for a classroom load. This branch has no live-mode session
 * model and the classroom serves local-only courses without a sidecar row, so
 * the fallback keeps the upstream single-user default (`isOwner: true`) when
 * the sidecar had no answer — a course that was never probed stays editable,
 * and the server's owner-scoped writes remain the authority that actually
 * enforces ownership.
 */
export function resolveStageFallbackAccess(stageId: string): StageAccessSignal {
  return getStageAccessSignal(stageId) ?? { isOwner: true };
}

/** Test hook: forget every recorded outcome. */
export function resetStageOwnershipSignals(): void {
  stageOwnership.clear();
}
