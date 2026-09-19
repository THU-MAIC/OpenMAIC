/**
 * What this session has allocated for a course's derived narration keys.
 *
 * The mirror of the media path's allocation record, and it exists for the same
 * reason. A snapshot of the open course reaches durable storage from several
 * producers, each capturing at its own moment -- a queued autosave, an
 * editor-history entry replayed by undo, the save a course switch flushes --
 * and any of those moments can predate an adoption rewrite. Such a snapshot
 * still carries the derived `tts_*` key, and writing it puts the document back
 * where it started: naming an id nothing outside this browser can resolve, with
 * the allocated asset orphaned and the next load allocating another one.
 *
 * Marking the rewritten scenes dirty is not enough on its own. That covers the
 * round already in flight; it does not cover a producer that captures its
 * snapshot later from an older copy. So the record lives here, is read at the
 * one write boundary every producer passes through, and never drains -- a
 * derived key can reappear in a snapshot long after its rewrite landed.
 *
 * Entries are per stage and per session; a course switch clears its own.
 */

/**
 * Compose the map key. NUL as the separator, written as an escape so the
 * source stays printable: both halves are opaque strings, so any printable
 * separator could occur inside one of them and let two pairs collide.
 */
function key(stageId: string, derivedRef: string): string {
  return `${stageId}\u0000${derivedRef}`;
}

const allocated = new Map<string, string>();

/** Record that `derivedRef` in this course now means `assetId`. */
export function recordNarrationAllocation(
  stageId: string,
  derivedRef: string,
  assetId: string,
): void {
  allocated.set(key(stageId, derivedRef), assetId);
}

/** What this session allocated for a derived narration key, if anything. */
export function allocatedNarrationReference(
  stageId: string | undefined,
  derivedRef: string,
): string | undefined {
  if (!stageId) return undefined;
  return allocated.get(key(stageId, derivedRef));
}

/** Drop a course's records (switch, deletion, tests). */
export function clearNarrationAllocations(stageId?: string): void {
  if (stageId === undefined) {
    allocated.clear();
    return;
  }
  const prefix = `${stageId}\u0000`;
  for (const mapKey of [...allocated.keys()]) {
    if (mapKey.startsWith(prefix)) allocated.delete(mapKey);
  }
}
