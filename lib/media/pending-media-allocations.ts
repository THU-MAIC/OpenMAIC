/**
 * Media that is stored but has nowhere to be referenced from yet.
 *
 * During the first generation pass, media runs alongside content: an image is
 * usually finished before the slide that asked for it has been built, so the
 * write-back finds no slot for its placeholder anywhere. The bytes are already
 * paid for and stored, so the allocation is held here rather than dropped —
 * keyed by the placeholder the future slide will carry.
 *
 * Two consumers close the loop. The orchestrator refuses to call the provider
 * again for a placeholder that already has an allocation waiting, which is what
 * keeps a second pass in the same run from paying twice. And the scene commit
 * path drains the entries a newly built scene matches, rewriting its slots
 * before that scene is ever saved — so the document never records the
 * placeholder in the first place.
 *
 * Entries are per stage and live only for the session that made them. One left
 * behind means the scene it was waiting for never arrived (a failed or
 * abandoned generation); its bytes are then unreferenced, and nothing reclaims
 * them today — the stage-scoped registry sweep is written but not wired up.
 *
 * Alongside the parked entries this module keeps a second, non-draining record:
 * every placeholder this session has ever allocated for, and what it allocated.
 * The parked map answers "does this reference have bytes waiting for a slide";
 * the record answers "is this placeholder stale", which is what the persistence
 * write boundary needs. A snapshot captured before a rewrite — a queued
 * autosave, an editor-history entry, a departing-course save — still carries the
 * placeholder, and without the record the write boundary has no way to know the
 * document has moved past it.
 */

export interface PendingMediaAllocation {
  readonly stageId: string;
  /** The `gen_img_*` / `gen_vid_*` value the future slide will carry. */
  readonly placeholderRef: string;
  readonly assetId: string;
  readonly posterAssetId?: string;
  /** Object URL for this tab, handed to the task once a slot exists. */
  readonly objectUrl?: string;
  readonly posterObjectUrl?: string;
}

/**
 * Compose the map key. The separator is NUL, written as an escape so the source
 * stays printable: both halves are opaque, unconstrained strings, so any
 * printable separator could in principle occur inside one of them and let two
 * different pairs collide on one key.
 */
function key(stageId: string, placeholderRef: string): string {
  return `${stageId}\u0000${placeholderRef}`;
}

const pending = new Map<string, PendingMediaAllocation>();
const allocated = new Map<string, PendingMediaAllocation>();

/**
 * Record what this placeholder was allocated, whether or not it found a slide.
 *
 * Called for every allocation, placed or parked. The record never drains: a
 * placeholder can reappear in a snapshot long after its rewrite landed.
 */
export function recordMediaAllocation(allocation: PendingMediaAllocation): void {
  allocated.set(key(allocation.stageId, allocation.placeholderRef), allocation);
}

export function recordPendingMediaAllocation(allocation: PendingMediaAllocation): void {
  recordMediaAllocation(allocation);
  pending.set(key(allocation.stageId, allocation.placeholderRef), allocation);
}

/** What this session allocated for a placeholder, parked or long since placed. */
export function allocatedMediaReference(
  stageId: string | undefined,
  placeholderRef: string,
): PendingMediaAllocation | undefined {
  if (!stageId) return undefined;
  return allocated.get(key(stageId, placeholderRef));
}

/** The allocation waiting for this placeholder, if one is. */
export function pendingMediaAllocation(
  stageId: string | undefined,
  placeholderRef: string,
): PendingMediaAllocation | undefined {
  if (!stageId) return undefined;
  return pending.get(key(stageId, placeholderRef));
}

/**
 * Remove and return the allocations whose placeholders appear in `refs`.
 *
 * Taking rather than reading: an allocation is applied to exactly one scene,
 * and leaving it behind would make a later rewrite of an already-rewritten slot
 * look possible.
 */
export function takePendingMediaAllocations(
  stageId: string,
  refs: Iterable<string>,
): PendingMediaAllocation[] {
  const taken: PendingMediaAllocation[] = [];
  for (const ref of refs) {
    const mapKey = key(stageId, ref);
    const allocation = pending.get(mapKey);
    if (!allocation) continue;
    pending.delete(mapKey);
    taken.push(allocation);
  }
  return taken;
}

/**
 * Forget an allocation whose bytes are gone.
 *
 * Called wherever a reclaim removes the asset. The record outlives the parked
 * queue on purpose, so without this a later save would stamp a deleted id into
 * the document — and the placeholder it replaced would be gone, which reads as
 * "already generated" and stops anything from retrying.
 */
export function forgetMediaAllocation(stageId: string, placeholderRef: string): void {
  const mapKey = key(stageId, placeholderRef);
  pending.delete(mapKey);
  allocated.delete(mapKey);
}

/** Drop a course's allocations, parked and recorded alike (switch, deletion, tests). */
export function clearPendingMediaAllocations(stageId?: string): void {
  if (stageId === undefined) {
    pending.clear();
    allocated.clear();
    return;
  }
  const prefix = `${stageId}\u0000`;
  for (const map of [pending, allocated]) {
    for (const mapKey of [...map.keys()]) {
      if (mapKey.startsWith(prefix)) map.delete(mapKey);
    }
  }
}
