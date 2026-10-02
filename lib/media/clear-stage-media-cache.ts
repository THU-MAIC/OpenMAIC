import { db } from '@/lib/device-storage/database';

/**
 * Drop a deleted stage's local media cache.
 *
 * This is cache hygiene and nothing more. The registry entries those rows
 * mirror are the server's to reclaim: a document write records what the
 * document claims, deleting the document withdraws those claims, and the
 * collector releases an entry whose last claim left longer ago than the grace
 * period. A browser has no standing in that — asset deletion is refused to every
 * caller, because the principal it would scope to is shared — so there is no
 * registry half of this function to write.
 *
 * `mediaFiles` rows are indexed by stage and belong to it exclusively, so all
 * of them go. `audioFiles` rows are keyed globally by audio id, and another
 * course (a copy, or another owner's course opened here) may play from the same
 * id. Proving that none does would need the owner's whole library and every
 * other course this browser has opened, which no browser can enumerate, so the
 * audio rows stay: leaving bounded cache garbage is recoverable, and deleting a
 * row a surviving course plays from is not. Clearing the local cache removes
 * them.
 *
 * Call this only after the authoritative document is deleted.
 */
export async function clearStageMediaCache(stageId: string): Promise<void> {
  const mediaRows = await db.mediaFiles.where('stageId').equals(stageId).toArray();
  if (mediaRows.length > 0) {
    await db.mediaFiles.bulkDelete(mediaRows.map((row) => row.id));
  }
}
