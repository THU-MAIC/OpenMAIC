import { loadSurvivingDocumentAssetRefs } from './collect-stage-asset-refs';
import { db } from '@/lib/utils/database';

/**
 * Drop a deleted stage's local media cache.
 *
 * This is cache hygiene and nothing more. The registry entries those rows
 * mirror are the server's to reclaim: a document write records what the
 * document claims, deleting the document withdraws those claims, and the
 * collector releases an entry whose last claim left longer ago than the grace
 * period. A browser has no standing in that — asset deletion is refused to
 * every caller, because the principal it would scope to is shared — so there is
 * no registry half of this function to write.
 *
 * `mediaFiles` rows are indexed by stage and belong to it exclusively, so all
 * of them go. `audioFiles` rows are keyed globally by audio id, and playback,
 * classroom export and video export read that table directly rather than
 * falling back to the pool, so a row another document still plays from must
 * survive. Liveness is therefore proved before removal, and a proof that could
 * not be carried out (`null`) keeps every row: leaving bounded cache garbage is
 * recoverable, and deleting a row a surviving course plays from is not.
 *
 * Call this only after the authoritative document is deleted. Before it, the
 * document being deleted is still in the enumeration and every row looks live.
 */
export async function clearStageMediaCache(stageId: string): Promise<void> {
  const mediaRows = await db.mediaFiles.where('stageId').equals(stageId).toArray();
  const audioRows = await db.audioFiles.where('stageId').equals(stageId).toArray();

  if (mediaRows.length > 0) {
    await db.mediaFiles.bulkDelete(mediaRows.map((row) => row.id));
  }
  if (audioRows.length === 0) return;

  const survivingRefs = await loadSurvivingDocumentAssetRefs();
  if (survivingRefs === null) return;
  const removable = audioRows.map((row) => row.id).filter((id) => !survivingRefs.has(id));
  if (removable.length > 0) {
    await db.audioFiles.bulkDelete(removable);
  }
}
