import {
  collectStageAssetRefs,
  loadSurvivingDocumentAssetRefs,
  type StageAssetDocument,
  type StageAssetRefs,
  type StageAudioRow,
  type StageMediaRow,
} from './collect-stage-asset-refs';
import { db, type AudioFileRecord, type MediaFileRecord } from '@/lib/utils/database';

/**
 * Transitional reclamation policy until document-truth mark-and-sweep lands:
 * stage deletion is the only deletion-triggered reclamation entry point.
 * Generation, TTS, and import transactions may still remove their own fresh
 * allocations while rolling back an uncommitted write. Other edits and partial
 * deletions deliberately leave bounded transitional garbage in the asset pool.
 */

export interface StageAssetInventory {
  readonly refs: StageAssetRefs;
  readonly mediaRows: readonly MediaFileRecord[];
  readonly audioRows: readonly AudioFileRecord[];
}

export interface StageAssetReclamationPlan {
  readonly stageId: string;
  readonly poolRefs: readonly string[];
  readonly mediaRowIds: readonly string[];
  readonly audioRowIds: readonly string[];
}

/** Load rows explicitly indexed to the stage being deleted. */
export async function loadStageAssetInventory(
  document: StageAssetDocument,
): Promise<StageAssetInventory> {
  const stageId = document.stage.id;
  const mediaRows = await db.mediaFiles.where('stageId').equals(stageId).toArray();
  const audioRows = await db.audioFiles.where('stageId').equals(stageId).toArray();
  return {
    refs: collectStageAssetRefs(document, { mediaRows, audioRows }),
    mediaRows,
    audioRows,
  };
}

/** Build the only supported reclamation plan: deletion of an entire stage. */
export function buildStageAssetReclamationPlan(
  stageId: string,
  before: StageAssetRefs,
  mediaRows: readonly StageMediaRow[],
  audioRows: readonly StageAudioRow[],
): StageAssetReclamationPlan {
  const candidates = new Set(before.all);
  const poolRefs = [...candidates].filter((ref) => before.poolOwned.has(ref));
  const mediaRowIds = mediaRows
    .filter((row) => row.stageId === stageId)
    .filter((row) => {
      const prefix = `${stageId}:`;
      const ref = row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
      return candidates.has(ref);
    })
    .map((row) => row.id);
  const audioRowIds = audioRows
    // Stage-less legacy ids are derived from scene order and action id, so the
    // same value can occur in unrelated documents. Never attribute such a row
    // to this stage merely because its document happens to reference the id.
    .filter((row) => row.stageId === stageId)
    .filter((row) => candidates.has(row.id))
    .map((row) => row.id);
  return {
    stageId,
    poolRefs: [...new Set(poolRefs)],
    mediaRowIds: [...new Set(mediaRowIds)],
    audioRowIds: [...new Set(audioRowIds)],
  };
}

/**
 * Execute a prepared plan only after the authoritative document was deleted.
 * The explicit `null` makes the destructive scope visible at every call site.
 * Edits and partial deletions must never call this function.
 */
export async function executeStageAssetReclamation(
  plan: StageAssetReclamationPlan,
  deletedDocument: null,
): Promise<StageAssetReclamationPlan> {
  void deletedDocument;

  const liveRefs = await loadSurvivingDocumentAssetRefs();

  // Registry reclamation is intentionally unwired. Only stage-owned local
  // compatibility rows are removed.
  if (plan.mediaRowIds.length > 0) {
    await db.mediaFiles.bulkDelete([...plan.mediaRowIds]);
  }
  // `audioFiles` rows are keyed globally by audioId, so a row shared with a
  // surviving document must stay: playback, classroom export and video export
  // read this table directly and cannot fall back to the preserved pool blob.
  // Losing one is therefore as irreversible for those consumers as removing the
  // pool entry, so unknown liveness (`null`) preserves every row here as well,
  // leaving bounded garbage for a later pass that can prove exclusivity. Rows no
  // survivor references are still removed, including legacy/imported ones that
  // never had a pool entry.
  if (plan.audioRowIds.length > 0 && liveRefs !== null) {
    const removableAudioRowIds = plan.audioRowIds.filter((id) => !liveRefs.has(id));
    if (removableAudioRowIds.length > 0) {
      await db.audioFiles.bulkDelete(removableAudioRowIds);
    }
  }
  return plan;
}
