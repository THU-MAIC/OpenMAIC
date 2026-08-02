import { removeAsset } from './asset-pool';
import {
  collectStageAssetRefs,
  type StageAssetDocument,
  type StageAssetRefs,
  type StageAudioRow,
  type StageMediaRow,
} from './collect-stage-asset-refs';
import { createLogger } from '@/lib/logger';
import { db, type AudioFileRecord, type MediaFileRecord } from '@/lib/utils/database';
import { accessDocument } from '@/lib/document-store';

const log = createLogger('StageAssetReclamation');

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

function mediaRefFromRowId(stageId: string, rowId: string): string {
  const prefix = `${stageId}:`;
  return rowId.startsWith(prefix) ? rowId.slice(prefix.length) : rowId;
}

function emptyPlan(stageId: string): StageAssetReclamationPlan {
  return { stageId, poolRefs: [], mediaRowIds: [], audioRowIds: [] };
}

function protectCurrentDocumentRefs(
  plan: StageAssetReclamationPlan,
  document: StageAssetDocument,
): StageAssetReclamationPlan {
  const current = collectStageAssetRefs(document, { mediaRows: [], audioRows: [] }).document;
  return {
    stageId: plan.stageId,
    poolRefs: plan.poolRefs.filter((ref) => !current.has(ref)),
    mediaRowIds: plan.mediaRowIds.filter(
      (rowId) => !current.has(mediaRefFromRowId(plan.stageId, rowId)),
    ),
    audioRowIds: plan.audioRowIds.filter((rowId) => !current.has(rowId)),
  };
}

function uniqueRowsById<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

/** Load the indexed safety nets plus legacy audio rows found by the document walker. */
export async function loadStageAssetInventory(
  document: StageAssetDocument,
): Promise<StageAssetInventory> {
  const stageId = document.stage.id;
  const mediaRows = await db.mediaFiles.where('stageId').equals(stageId).toArray();
  const documentOnly = collectStageAssetRefs(document, { mediaRows, audioRows: [] });
  const indexedAudioRows = await db.audioFiles.where('stageId').equals(stageId).toArray();
  const walkedAudioRows =
    documentOnly.speechAudioId.size === 0
      ? []
      : (await db.audioFiles.bulkGet([...documentOnly.speechAudioId])).filter(
          (row): row is AudioFileRecord => row !== undefined,
        );
  const audioRows = uniqueRowsById([...indexedAudioRows, ...walkedAudioRows]);
  return {
    refs: collectStageAssetRefs(document, { mediaRows, audioRows }),
    mediaRows,
    audioRows,
  };
}

/** Pure reclamation matrix used by every deletion/discard entry point. */
export function buildStageAssetReclamationPlan(
  stageId: string,
  before: StageAssetRefs,
  after: StageAssetRefs | null,
  mediaRows: readonly StageMediaRow[],
  audioRows: readonly StageAudioRow[],
): StageAssetReclamationPlan {
  const candidates = after
    ? new Set([...before.referenced].filter((ref) => !after.referenced.has(ref)))
    : new Set(before.all);
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
    .filter((row) => row.stageId === undefined || row.stageId === stageId)
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
 * Execute a prepared plan against document truth at execution time. A caller
 * that just deleted the whole document can pass `null`; every partial cleanup
 * re-reads the latest document and drops refs that have since been restored.
 */
export async function executeStageAssetReclamation(
  plan: StageAssetReclamationPlan,
  latestDocument?: StageAssetDocument | null,
): Promise<StageAssetReclamationPlan> {
  let executable = plan;
  if (latestDocument === undefined) {
    try {
      const latest = (await accessDocument(plan.stageId)).document;
      if (latest) executable = protectCurrentDocumentRefs(plan, latest);
    } catch (error) {
      log.warn(`Skipping reclamation for ${plan.stageId}; current document is unreadable:`, error);
      return emptyPlan(plan.stageId);
    }
  } else if (latestDocument) {
    executable = protectCurrentDocumentRefs(plan, latestDocument);
  }

  for (const ref of executable.poolRefs) {
    try {
      await removeAsset(ref);
    } catch (error) {
      log.warn(`Failed to reclaim asset ${ref} for stage ${plan.stageId}:`, error);
    }
  }
  if (executable.mediaRowIds.length > 0) {
    await db.mediaFiles.bulkDelete([...executable.mediaRowIds]);
  }
  // Audio deletion is unconditional: a legacy/imported row may have no pool entry.
  if (executable.audioRowIds.length > 0) {
    await db.audioFiles.bulkDelete([...executable.audioRowIds]);
  }
  return executable;
}

/** Reclaim a whole stage, or only refs detached between two document snapshots. */
export async function reclaimStageDocumentAssets(
  beforeDocument: StageAssetDocument,
  afterDocument: StageAssetDocument | null,
): Promise<StageAssetReclamationPlan> {
  const inventory = await loadStageAssetInventory(beforeDocument);
  const after = afterDocument
    ? collectStageAssetRefs(afterDocument, {
        mediaRows: inventory.mediaRows,
        audioRows: inventory.audioRows,
      })
    : null;
  const plan = buildStageAssetReclamationPlan(
    beforeDocument.stage.id,
    inventory.refs,
    after,
    inventory.mediaRows,
    inventory.audioRows,
  );
  return executeStageAssetReclamation(plan);
}

/** Reclaim explicit candidates only when the latest document no longer owns them. */
export async function reclaimUnreferencedStageAssets(
  document: StageAssetDocument,
  candidates: readonly string[],
): Promise<StageAssetReclamationPlan> {
  const inventory = await loadStageAssetInventory(document);
  const detached = new Set(candidates.filter((ref) => !inventory.refs.referenced.has(ref)));
  const syntheticBefore: StageAssetRefs = {
    ...inventory.refs,
    referenced: detached,
    all: detached,
  };
  const plan = buildStageAssetReclamationPlan(
    document.stage.id,
    syntheticBefore,
    null,
    inventory.mediaRows,
    inventory.audioRows,
  );
  return executeStageAssetReclamation(plan);
}

/** Resolve the latest stage document before planning explicit-candidate cleanup. */
export async function reclaimUnreferencedStageAssetsForStage(
  stageId: string,
  candidates: readonly string[],
): Promise<StageAssetReclamationPlan> {
  let document: StageAssetDocument | null;
  try {
    document = (await accessDocument(stageId)).document;
  } catch (error) {
    log.warn(`Skipping reclamation for ${stageId}; current document is unreadable:`, error);
    return emptyPlan(stageId);
  }
  if (!document) return emptyPlan(stageId);
  return reclaimUnreferencedStageAssets(document, candidates);
}
