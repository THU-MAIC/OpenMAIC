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

import type { StageMetaResult } from './stage-meta-client';

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

/**
 * What a load learned about the viewer, in the four states the sidecar's three
 * outcomes actually produce.
 *
 * `'owner'` and `'not-owner'` are the two halves of a definite answer.
 * `'ownerless'` is also an answer — the sidecar replied that no ownership fact
 * exists for this course, which is what a deployment without the sidecar's
 * server-side prerequisites answers for every course, and what a course with no
 * ownership record answers. `'unresolved'` is the ABSENCE of an answer: not
 * asked yet, or asked and nothing usable came back.
 */
export type ClassroomGenerationOwnership = 'owner' | 'not-owner' | 'ownerless' | 'unresolved';

/** Map a sidecar result onto the generation gate's view of the viewer. */
export function classroomGenerationOwnership(
  result: StageMetaResult,
): ClassroomGenerationOwnership {
  if (result.outcome === 'found') return result.meta.isOwner ? 'owner' : 'not-owner';
  return result.outcome === 'absent' ? 'ownerless' : 'unresolved';
}

/**
 * May this browser start generation for this course?
 *
 * Generation spends the operator's provider budget, so under server-backed
 * persistence — where a course is shared and any visitor may open it — the gate
 * refuses everything except a viewer it has a reason to trust. That is `'owner'`
 * and, deliberately, `'ownerless'`: when the sidecar answers that this course
 * has no ownership fact at all there is nobody the budget needs protecting
 * from, and refusing would strand the course's own author forever behind a
 * question that can never be answered — so an ownerless course keeps the
 * behaviour it had before the gate existed. `'not-owner'` is a definite no, and
 * `'unresolved'` fails closed, because "we could not ask" must never be read as
 * "nobody owns this". Browser-only mode has one viewer who is by construction
 * the author, so the gate is inert there and behaviour is unchanged.
 */
export function mayStartOwnerGeneration(
  serverBackedMedia: boolean,
  ownership: ClassroomGenerationOwnership,
): boolean {
  if (!serverBackedMedia) return true;
  return ownership === 'owner' || ownership === 'ownerless';
}
