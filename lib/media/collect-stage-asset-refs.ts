import type { Slide } from '@openmaic/dsl';
import { getDocumentStore } from '@/lib/document-store';
import { createLogger } from '@/lib/logger';
import type { Scene, Stage } from '@/lib/types/stage';
import { useStageStore } from '@/lib/store/stage';
import { slideMediaReferenceSlots } from './slide-media-slots';
import { probeStageRealmPresence } from './stage-realm-presence';

const log = createLogger('PersistedAssetRefs');

export interface StageAssetDocument {
  readonly stage: Stage;
  readonly scenes: readonly Scene[];
}

export interface StageMediaRow {
  readonly id: string;
  readonly stageId: string;
}

export interface StageAudioRow {
  readonly id: string;
  /** Missing on rows written before the per-stage audio index existed. */
  readonly stageId?: string;
}

export interface StageAssetRefs {
  readonly imageSrc: ReadonlySet<string>;
  readonly videoSrc: ReadonlySet<string>;
  readonly videoMediaRef: ReadonlySet<string>;
  readonly poster: ReadonlySet<string>;
  readonly backgroundImage: ReadonlySet<string>;
  readonly stageWhiteboard: ReadonlySet<string>;
  readonly sceneWhiteboard: ReadonlySet<string>;
  readonly speechAudioId: ReadonlySet<string>;
  readonly videoManifestKey: ReadonlySet<string>;
  readonly mediaRow: ReadonlySet<string>;
  readonly audioRow: ReadonlySet<string>;
  readonly mediaOrphans: ReadonlySet<string>;
  readonly audioOrphans: ReadonlySet<string>;
  /** Refs held by renderable elements or speech cues (manifest metadata excluded). */
  readonly referenced: ReadonlySet<string>;
  /** Every document ref, including video-manifest metadata. */
  readonly document: ReadonlySet<string>;
  /** Document refs plus stage-owned Dexie-only orphan rows. */
  readonly all: ReadonlySet<string>;
  /** Refs with a stage-owned compatibility row and therefore safe to remove from the pool. */
  readonly poolOwned: ReadonlySet<string>;
  /** Logical owners per ref; video src+mediaRef on one element count once. */
  readonly referenceCounts: ReadonlyMap<string, number>;
}

export interface PersistedDocumentAssetRefs {
  /** Logical-owner totals across every supplied persisted document. */
  readonly referenceCounts: ReadonlyMap<string, number>;
  /** Per-document results from the same stage enumerator used by deletion. */
  readonly byDocument: ReadonlyMap<string, StageAssetRefs>;
}

function addValue(target: Set<string>, value: string | undefined): value is string {
  if (!value) return false;
  target.add(value);
  return true;
}

function mediaRefFromRow(stageId: string, rowId: string): string {
  const prefix = `${stageId}:`;
  return rowId.startsWith(prefix) ? rowId.slice(prefix.length) : rowId;
}

/**
 * Enumerate the complete stage asset reference space without performing I/O.
 *
 * Categories intentionally overlap: a whiteboard image belongs to both
 * `imageSrc` and its whiteboard category. `referenceCounts` counts the logical
 * owning element/action only once, which is what duplication-safe replacement
 * needs when a video repeats the same ref in both `src` and `mediaRef`.
 */
export function collectStageAssetRefs(
  document: StageAssetDocument | null,
  {
    mediaRows,
    audioRows,
  }: {
    readonly mediaRows: readonly StageMediaRow[];
    readonly audioRows: readonly StageAudioRow[];
  },
): StageAssetRefs {
  const imageSrc = new Set<string>();
  const videoSrc = new Set<string>();
  const videoMediaRef = new Set<string>();
  const poster = new Set<string>();
  const backgroundImage = new Set<string>();
  const stageWhiteboard = new Set<string>();
  const sceneWhiteboard = new Set<string>();
  const speechAudioId = new Set<string>();
  const videoManifestKey = new Set<string>();
  const referenced = new Set<string>();
  const ownerKeysByRef = new Map<string, Set<string>>();

  const own = (ref: string | undefined, ownerKey: string) => {
    if (!ref) return;
    referenced.add(ref);
    let owners = ownerKeysByRef.get(ref);
    if (!owners) {
      owners = new Set<string>();
      ownerKeysByRef.set(ref, owners);
    }
    owners.add(ownerKey);
  };

  const visitSlide = (
    slide: Pick<Slide, 'id' | 'elements' | 'background'>,
    scope: 'scene' | 'stage-whiteboard' | 'scene-whiteboard',
    scopeId: string,
  ) => {
    for (const slot of slideMediaReferenceSlots(slide)) {
      const ref = slot.read();
      if (!ref) continue;
      const whiteboardCategory =
        scope === 'stage-whiteboard'
          ? stageWhiteboard
          : scope === 'scene-whiteboard'
            ? sceneWhiteboard
            : undefined;

      const ownerKey = slot.element
        ? `${scope}:${scopeId}:${slot.element.id || slot.elementIndex}`
        : `${scope}:${scopeId}:background`;
      if (slot.kind === 'background-image') addValue(backgroundImage, ref);
      else if (slot.kind === 'image-src') addValue(imageSrc, ref);
      else if (slot.kind === 'video-src') addValue(videoSrc, ref);
      else if (slot.kind === 'video-media-ref') addValue(videoMediaRef, ref);
      else addValue(poster, ref);
      own(ref, slot.kind === 'video-poster' ? `${ownerKey}:poster` : ownerKey);
      whiteboardCategory?.add(ref);
    }
  };

  if (document) {
    for (let index = 0; index < (document.stage.whiteboard ?? []).length; index += 1) {
      const slide = document.stage.whiteboard![index];
      visitSlide(slide, 'stage-whiteboard', slide.id || String(index));
    }

    for (const scene of document.scenes) {
      if (scene.content.type === 'slide') {
        visitSlide(scene.content.canvas, 'scene', scene.id);
      }
      for (let index = 0; index < (scene.whiteboards ?? []).length; index += 1) {
        const slide = scene.whiteboards![index];
        visitSlide(slide, 'scene-whiteboard', `${scene.id}:${slide.id || index}`);
      }
      for (let index = 0; index < (scene.actions ?? []).length; index += 1) {
        const action = scene.actions![index];
        if (action.type !== 'speech' || !action.audioId) continue;
        speechAudioId.add(action.audioId);
        own(action.audioId, `speech:${scene.id}:${action.id || index}`);
      }
    }

    for (const ref of Object.keys(document.stage.videoManifest ?? {})) {
      videoManifestKey.add(ref);
    }
  }

  const stageId = document?.stage.id;
  const mediaRow = new Set(
    mediaRows
      .filter((row) => !stageId || row.stageId === stageId)
      .map((row) => mediaRefFromRow(row.stageId, row.id)),
  );
  const audioRow = new Set(
    audioRows
      .filter((row) => (stageId ? row.stageId === stageId : row.stageId !== undefined))
      .map((row) => row.id),
  );
  const documentRefs = new Set([...referenced, ...videoManifestKey]);
  const mediaOrphans = new Set([...mediaRow].filter((ref) => !documentRefs.has(ref)));
  const audioOrphans = new Set([...audioRow].filter((ref) => !documentRefs.has(ref)));
  const all = new Set([...documentRefs, ...mediaRow, ...audioRow]);
  const poolOwned = new Set([...mediaRow, ...audioRow]);
  const referenceCounts = new Map(
    [...ownerKeysByRef].map(([ref, owners]) => [ref, owners.size] as const),
  );

  return {
    imageSrc,
    videoSrc,
    videoMediaRef,
    poster,
    backgroundImage,
    stageWhiteboard,
    sceneWhiteboard,
    speechAudioId,
    videoManifestKey,
    mediaRow,
    audioRow,
    mediaOrphans,
    audioOrphans,
    referenced,
    document: documentRefs,
    all,
    poolOwned,
    referenceCounts,
  };
}

/** Aggregate logical asset owners without introducing a second ref heuristic. */
export function collectPersistedDocumentAssetRefs(
  documents: readonly StageAssetDocument[],
): PersistedDocumentAssetRefs {
  const referenceCounts = new Map<string, number>();
  const byDocument = new Map<string, StageAssetRefs>();

  for (const document of documents) {
    const refs = collectStageAssetRefs(document, { mediaRows: [], audioRows: [] });
    byDocument.set(document.stage.id, refs);
    for (const [ref, count] of refs.referenceCounts) {
      referenceCounts.set(ref, (referenceCounts.get(ref) ?? 0) + count);
    }
  }

  return { referenceCounts, byDocument };
}

/**
 * Return whether an allocated ref remains live in any persisted document other
 * than the optional document being replaced or deleted. Repository enumeration
 * is authoritative and fail-closed: an unavailable listing, an unreadable
 * listed document, or any other enumeration failure returns `true`.
 */
export async function isAllocatedAssetRefReferencedBySurvivingDocument(
  ref: string,
  excludedDocumentId?: string,
): Promise<boolean> {
  const liveRefs = await loadSurvivingDocumentAssetRefs(excludedDocumentId);
  return liveRefs === null || liveRefs.has(ref);
}

/**
 * Owners the editor holds but has not flushed yet. Slide duplication updates the
 * Zustand aggregate synchronously and schedules persistence behind a debounce, so
 * the persisted document can still report a single owner while the live stage
 * already has two. An in-place replacement decided from the persisted copy alone
 * would rewrite bytes both slides reference. Returns undefined when the live
 * snapshot represents a different stage and therefore has nothing to say.
 */
function unflushedStageOwnerCount(assetId: string, stageId: string): number | undefined {
  const { stage, scenes } = useStageStore.getState();
  if (!stage || stage.id !== stageId) return undefined;
  return collectStageAssetRefs(
    { stage, scenes },
    { mediaRows: [], audioRows: [] },
  ).referenceCounts.get(assetId);
}

/**
 * Whether an allocated ref may have its bytes replaced in place. Every writer
 * that mutates a globally keyed asset — media retry, poster replacement, speech
 * regeneration — clears this first, so the rule lives here once instead of being
 * restated per call site.
 */
export async function proveExclusiveAssetOwnership(
  assetId: string,
  stageId: string,
): Promise<{ readonly exclusive: boolean; readonly activePersistedRefs?: StageAssetRefs }> {
  let activePersistedRefs: StageAssetRefs | undefined;
  try {
    const document = await getDocumentStore().loadDocument(stageId);
    if (!document) throw new Error(`Document ${stageId} could not be loaded`);
    activePersistedRefs = collectStageAssetRefs(document, { mediaRows: [], audioRows: [] });
  } catch (error) {
    log.warn(`Could not prove exclusive ownership of asset ${assetId}:`, error);
  }
  const referencedByAnotherDocument = await isAllocatedAssetRefReferencedBySurvivingDocument(
    assetId,
    stageId,
  );
  // The live snapshot only participates when it represents this stage; when it
  // does, an owner it knows about counts even though persistence is pending.
  const liveOwners = unflushedStageOwnerCount(assetId, stageId);
  // Another realm's unflushed edits are unobservable — its Zustand state lives
  // in a different realm and leaves no persisted trace during its debounce — so
  // a peer editing this stage forces the fork path rather than a global mutation
  // decided from state we cannot see. A probe we could not carry out is treated
  // exactly like a peer: proving nothing is not the same as proving absence.
  const peerRealmEditing = (await probeStageRealmPresence(stageId)) !== 'absent';
  return {
    exclusive:
      (activePersistedRefs?.referenceCounts.get(assetId) ?? 0) === 1 &&
      (liveOwners === undefined || liveOwners === 1) &&
      !peerRealmEditing &&
      !referencedByAnotherDocument,
    activePersistedRefs,
  };
}

/** Load complete document refs once; null means enumeration failed and callers must fail closed. */
export async function loadSurvivingDocumentAssetRefs(
  excludedDocumentId?: string,
): Promise<ReadonlySet<string> | null> {
  try {
    const store = getDocumentStore();
    const summaries = await store.listDocuments();
    const documents = await Promise.all(
      summaries
        .filter(({ id }) => id !== excludedDocumentId)
        .map(async ({ id }) => {
          const document = await store.loadDocument(id);
          if (!document) throw new Error(`Listed document ${id} could not be loaded`);
          return document;
        }),
    );
    const liveRefs = new Set<string>();
    for (const refs of collectPersistedDocumentAssetRefs(documents).byDocument.values()) {
      for (const ref of refs.document) liveRefs.add(ref);
    }
    return liveRefs;
  } catch (error) {
    log.warn('Could not enumerate persisted asset liveness:', error);
    return null;
  }
}
