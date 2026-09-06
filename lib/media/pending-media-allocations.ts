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
 * abandoned generation), and its bytes are reclaimed by the stage-scoped
 * document-truth sweep like any other unreferenced asset.
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

export function recordPendingMediaAllocation(allocation: PendingMediaAllocation): void {
  pending.set(key(allocation.stageId, allocation.placeholderRef), allocation);
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

/** Drop a course's waiting allocations (course switch, deletion, tests). */
export function clearPendingMediaAllocations(stageId?: string): void {
  if (stageId === undefined) {
    pending.clear();
    return;
  }
  const prefix = `${stageId}\u0000`;
  for (const mapKey of [...pending.keys()]) {
    if (mapKey.startsWith(prefix)) pending.delete(mapKey);
  }
}
