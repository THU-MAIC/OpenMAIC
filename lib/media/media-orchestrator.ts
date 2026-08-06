/**
 * Media Generation Orchestrator
 *
 * Dispatches media generation API calls for all mediaGenerations across outlines.
 * Runs entirely on the frontend — calls /api/generate/image and /api/generate/video,
 * fetches result blobs, stores in IndexedDB, and updates the Zustand store.
 */

import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { markStagePersistenceDirty, useStageStore } from '@/lib/store/stage';
import { db, mediaFileKey } from '@/lib/utils/database';
import { accessDocument, mutateDocument, type AppDocument } from '@/lib/document-store';
import type { SceneOutline } from '@/lib/types/generation';
import { makeScene, type Scene, type Stage, type Whiteboard } from '@/lib/types/stage';
import type { MediaGenerationRequest } from '@/lib/media/types';
import type { AssetMeta, PPTElement, Slide } from '@openmaic/dsl';
import { putAsset, removeAsset, replaceAsset } from '@/lib/media/asset-pool';
import { assetRefExists } from '@/lib/media/use-asset-url';
import { createLogger } from '@/lib/logger';
import { isStageWriteStale, stageDeletionEpoch } from '@/lib/utils/deleted-stages';
import type { MediaTask } from '@/lib/store/media-generation';
import {
  collectStageAssetRefs,
  isAllocatedAssetRefReferencedBySurvivingDocument,
  proveExclusiveAssetOwnership,
  type StageAssetRefs,
} from './collect-stage-asset-refs';
import { isGeneratedMediaPlaceholder } from './media-ref';
import { slideMediaReferenceSlots } from './slide-media-slots';

const log = createLogger('MediaOrchestrator');

/** Error with a structured errorCode from the API */
class MediaApiError extends Error {
  errorCode?: string;
  constructor(message: string, errorCode?: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

/**
 * Launch media generation for all mediaGenerations declared in outlines.
 * Runs in parallel with content/action generation — does not block.
 */
export async function generateMediaForOutlines(
  outlines: SceneOutline[],
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const settings = useSettingsStore.getState();
  const store = useMediaGenerationStore.getState();
  let currentDocument: AppDocument | null = null;
  try {
    currentDocument = (await accessDocument(stageId)).document;
  } catch (error) {
    // Resume filtering is an optimization. If document truth is temporarily
    // unreadable, fall back to the original task-only skip logic and generate
    // the batch instead of silently dropping it.
    log.warn(`Could not read document ${stageId} while resuming media generation:`, error);
  }
  const currentRefs = collectStageAssetRefs(currentDocument, { mediaRows: [], audioRows: [] });

  // Collect all media requests
  const allRequests: MediaGenerationRequest[] = [];
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) {
      // Filter by enabled flags
      if (mg.type === 'image' && !settings.imageGenerationEnabled) continue;
      if (mg.type === 'video' && !settings.videoGenerationEnabled) continue;
      // A restored success task is keyed by its allocated id, so match its
      // persisted placeholder as well as the direct task key.
      const existing =
        store.getTask(mg.elementId) ??
        Object.values(store.tasks).find(
          (task) => task.stageId === stageId && task.placeholderRef === mg.elementId,
        );
      if (existing?.status === 'done' || existing?.status === 'failed') continue;
      const owningSceneExists =
        currentDocument?.scenes.some(
          (scene) => scene.outlineId === outline.id || scene.order === outline.order,
        ) ?? false;
      // A generated scene that no longer references the placeholder has already
      // been reconciled. A not-yet-generated scene still needs its media work.
      if (owningSceneExists && !currentRefs.referenced.has(mg.elementId)) continue;
      allRequests.push(mg);
    }
  }

  if (allRequests.length === 0) return;

  // Enqueue all as pending
  useMediaGenerationStore.getState().enqueueTasks(stageId, allRequests);

  // Process requests serially — image/video APIs have limited concurrency
  for (const req of allRequests) {
    if (abortSignal?.aborted) break;
    await generateSingleMedia(req, stageId, abortSignal);
  }
}

/**
 * Retry a single failed media task.
 */
export async function retryMediaTask(
  elementId: string,
  target:
    | {
        readonly elementId: string;
        readonly sceneId?: string;
        readonly slideId?: string;
      }
    | undefined = undefined,
): Promise<void> {
  const store = useMediaGenerationStore.getState();
  const task = store.getTask(elementId);
  if (!task || (task.status !== 'failed' && task.status !== 'done')) return;

  // Check if the corresponding generation type is still enabled in global settings
  const settings = useSettingsStore.getState();
  if (task.type === 'image' && !settings.imageGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }
  if (task.type === 'video' && !settings.videoGenerationEnabled) {
    store.markFailed(elementId, 'Generation disabled', 'GENERATION_DISABLED');
    return;
  }

  const stageState = useStageStore.getState();
  const scopedTarget = target
    ? {
        ...target,
        sceneId: target.sceneId ?? stageState.currentSceneId ?? undefined,
      }
    : undefined;

  const allocated = await assetRefExists(elementId);
  const ownership = allocated
    ? await proveExclusiveAssetOwnership(elementId, task.stageId)
    : undefined;
  const activePersistedRefs = ownership?.activePersistedRefs;
  const exclusive = ownership?.exclusive ?? false;
  const replaceAssetId = allocated && exclusive ? elementId : undefined;
  const targetedFork = allocated ? !replaceAssetId : !!target;
  if (targetedFork && (!scopedTarget?.sceneId || !scopedTarget.slideId)) {
    log.warn(`Cannot fork media ${elementId} without a scene-and-slide target`);
    return;
  }
  const posterAssetIds =
    replaceAssetId && task.type === 'video'
      ? await replaceablePosterRefs(
          task.stageId,
          currentPosterRefs(task.stageId, replaceAssetId),
          activePersistedRefs!,
        )
      : [];

  // Only legacy/failure placeholders are disposable. Keep them durable while
  // the retry is in flight, then remove them after a successful allocation.
  const failureRefs = !replaceAssetId
    ? new Set([elementId, target?.elementId].filter(Boolean) as string[])
    : undefined;

  const progressKey = targetedFork ? scopedTarget!.elementId : elementId;
  if (targetedFork) {
    useMediaGenerationStore.setState((state) => {
      const previousFork = state.tasks[progressKey];
      return {
        tasks: {
          ...state.tasks,
          [progressKey]: {
            ...task,
            elementId: progressKey,
            placeholderRef: undefined,
            status: 'pending',
            objectUrl: undefined,
            poster: undefined,
            posterAssetId: undefined,
            error: undefined,
            errorCode: undefined,
            retryCount: (previousFork?.retryCount ?? task.retryCount) + 1,
          },
        },
      };
    });
  } else {
    store.markPendingForRetry(elementId);
  }
  const generatedAssetId = await generateSingleMedia(
    {
      type: task.type,
      prompt: task.prompt,
      elementId: progressKey,
      aspectRatio: task.params.aspectRatio as MediaGenerationRequest['aspectRatio'],
      style: task.params.style,
    },
    task.stageId,
    undefined,
    {
      replaceAssetId,
      replacePosterAssetIds: posterAssetIds,
      target: targetedFork ? scopedTarget : undefined,
      sourceRef: targetedFork ? elementId : undefined,
      forkIfShared:
        replaceAssetId && scopedTarget
          ? { sourceRef: elementId, target: scopedTarget, sourceTask: task }
          : undefined,
    },
  );
  if (generatedAssetId && failureRefs) {
    for (const ref of failureRefs) {
      const key = mediaFileKey(task.stageId, ref);
      const row = await db.mediaFiles.get(key).catch(() => undefined);
      if (row && (row.error || row.blob.size === 0)) {
        await db.mediaFiles.delete(key).catch(() => {});
      }
    }
  }
}

/** Build a retry target without assuming the active scene owns a slide canvas. */
export function mediaRetryTarget(
  elementId: string,
  sceneId: string | undefined,
  sceneData: unknown,
): { elementId: string; sceneId?: string; slideId?: string } {
  const slideId =
    sceneData && typeof sceneData === 'object' && 'canvas' in sceneData
      ? (sceneData as { canvas?: { id?: string } }).canvas?.id
      : undefined;
  return { elementId, ...(sceneId ? { sceneId } : {}), ...(slideId ? { slideId } : {}) };
}

// ==================== Internal ====================

function rewriteSlideMediaRefs<T extends Slide | Whiteboard>(
  slide: T,
  oldRef: string,
  assetId: string,
  posterAssetId?: string,
  target?: { readonly elementId: string },
): { slide: T; changed: boolean } {
  const rewritten = structuredClone(slide);
  let changed = false;
  const matchedVideos = new Set<PPTElement>();
  const slots = [...slideMediaReferenceSlots(rewritten)];
  for (const slot of slots) {
    if (target && slot.element?.id !== target.elementId) continue;
    if (slot.kind === 'video-poster' || slot.read() !== oldRef) continue;
    if (slot.kind === 'background-image' || slot.kind === 'image-src') {
      changed = true;
      slot.write(assetId);
      continue;
    }
    if (slot.element?.type === 'video') {
      changed = true;
      slot.write(assetId);
      matchedVideos.add(slot.element);
    }
  }
  if (posterAssetId && matchedVideos.size > 0) {
    for (const slot of slots) {
      if (slot.kind === 'video-poster' && slot.element && matchedVideos.has(slot.element)) {
        slot.write(posterAssetId);
      }
    }
  }
  return changed ? { slide: rewritten, changed } : { slide, changed };
}

function posterRefsInSlide(slide: Slide | Whiteboard, mediaRef: string): string[] {
  const refs: string[] = [];
  const seen = new Set<PPTElement>();
  for (const slot of slideMediaReferenceSlots(slide)) {
    const element = slot.element;
    if (!element || element.type !== 'video' || seen.has(element)) continue;
    seen.add(element);
    if ((element.src === mediaRef || element.mediaRef === mediaRef) && element.poster) {
      refs.push(element.poster);
    }
  }
  return refs;
}

function currentPosterRefs(stageId: string, mediaRef: string): string[] {
  const state = useStageStore.getState();
  if (state.stage?.id !== stageId) return [];
  const refs = new Set<string>();
  for (const scene of state.scenes) {
    if (scene.content.type === 'slide') {
      for (const ref of posterRefsInSlide(scene.content.canvas, mediaRef)) refs.add(ref);
    }
    for (const whiteboard of scene.whiteboards ?? []) {
      for (const ref of posterRefsInSlide(whiteboard, mediaRef)) refs.add(ref);
    }
  }
  for (const slide of state.stage.whiteboard ?? []) {
    for (const ref of posterRefsInSlide(slide, mediaRef)) refs.add(ref);
  }
  return [...refs];
}

function rewriteStageAndScenes(
  stage: Stage,
  scenes: Scene[],
  oldRef: string,
  assetId: string,
  posterAssetId?: string,
  options: {
    readonly target?: {
      readonly elementId: string;
      readonly sceneId?: string;
      readonly slideId?: string;
    };
    readonly preserveManifestSource?: boolean;
  } = {},
): { stage: Stage; scenes: Scene[]; changed: boolean } {
  let changed = false;
  let targetSceneChanged = false;
  const rewrittenScenes = scenes.map((scene): Scene => {
    if (options.target?.sceneId && scene.id !== options.target.sceneId) return scene;
    let nextScene = scene;
    let matchedTarget = false;
    const contentIsTargetSlide =
      scene.content.type === 'slide' &&
      (!options.target?.slideId || scene.content.canvas.id === options.target.slideId);
    if (scene.content.type === 'slide' && contentIsTargetSlide) {
      const rewritten = rewriteSlideMediaRefs(
        scene.content.canvas,
        oldRef,
        assetId,
        posterAssetId,
        options.target ? { elementId: options.target.elementId } : undefined,
      );
      if (rewritten.changed) {
        changed = true;
        matchedTarget = true;
        const { type: _type, content: _content, ...core } = nextScene;
        void _type;
        void _content;
        nextScene = makeScene(core, { ...scene.content, canvas: rewritten.slide });
      }
    }
    if (scene.whiteboards) {
      let sceneWhiteboardsChanged = false;
      const hasExactWhiteboard =
        !!options.target?.slideId &&
        scene.whiteboards.some((slide) => slide.id === options.target!.slideId);
      const whiteboards = scene.whiteboards.map((slide) => {
        if (options.target && matchedTarget) return slide;
        if (hasExactWhiteboard && slide.id !== options.target!.slideId) return slide;
        const rewritten = rewriteSlideMediaRefs(
          slide,
          oldRef,
          assetId,
          posterAssetId,
          options.target ? { elementId: options.target.elementId } : undefined,
        );
        sceneWhiteboardsChanged ||= rewritten.changed;
        matchedTarget ||= rewritten.changed;
        return rewritten.slide;
      });
      if (sceneWhiteboardsChanged) {
        changed = true;
        nextScene = { ...nextScene, whiteboards } as Scene;
      }
    }
    targetSceneChanged ||= matchedTarget;
    return nextScene;
  });

  let stageWhiteboardChanged = false;
  let matchedStageWhiteboard = false;
  const hasExactStageWhiteboard =
    !!options.target?.slideId &&
    !!stage.whiteboard?.some((slide) => slide.id === options.target!.slideId);
  // A missed scene target is not permission to match a stage-whiteboard
  // element by id alone. Targeted retries may fall through only when they name
  // the exact stage-whiteboard slide; untargeted reconciliation still scans all.
  const maySearchStageWhiteboard =
    !options.target || (!targetSceneChanged && hasExactStageWhiteboard);
  const whiteboard = stage.whiteboard?.map((slide) => {
    if (!maySearchStageWhiteboard || (options.target && matchedStageWhiteboard)) return slide;
    if (hasExactStageWhiteboard && slide.id !== options.target!.slideId) return slide;
    const rewritten = rewriteSlideMediaRefs(
      slide,
      oldRef,
      assetId,
      posterAssetId,
      options.target ? { elementId: options.target.elementId } : undefined,
    );
    stageWhiteboardChanged ||= rewritten.changed;
    matchedStageWhiteboard ||= rewritten.changed;
    changed ||= rewritten.changed;
    return rewritten.slide;
  });

  let videoManifest = stage.videoManifest;
  const manifestEntry = videoManifest?.[oldRef];
  if (manifestEntry && videoManifest && (!options.target || changed)) {
    if (options.preserveManifestSource) {
      videoManifest = { ...videoManifest, [assetId]: manifestEntry };
    } else {
      const { [oldRef]: _oldEntry, ...remaining } = videoManifest;
      void _oldEntry;
      videoManifest = { ...remaining, [assetId]: manifestEntry };
    }
    changed = true;
  }

  const stageChanged = stageWhiteboardChanged || videoManifest !== stage.videoManifest;
  return {
    stage: stageChanged
      ? { ...stage, ...(whiteboard ? { whiteboard } : {}), videoManifest }
      : stage,
    scenes: rewrittenScenes,
    changed,
  };
}

function rewriteDocumentMediaRef(
  document: AppDocument,
  oldRef: string,
  assetId: string,
  posterAssetId?: string,
  options: {
    readonly target?: {
      readonly elementId: string;
      readonly sceneId?: string;
      readonly slideId?: string;
    };
    readonly preserveManifestSource?: boolean;
  } = {},
): AppDocument {
  const rewritten = rewriteStageAndScenes(
    document.stage,
    document.scenes,
    oldRef,
    assetId,
    posterAssetId,
    options,
  );
  return rewritten.changed
    ? { ...document, stage: rewritten.stage, scenes: rewritten.scenes }
    : document;
}

/**
 * Reconcile media that completed before its generated scene was inserted.
 * Re-keyed tasks retain the placeholder they replaced, so insertion can make
 * the scene and video manifest point at the already-durable allocated ids.
 */
export function reconcileCompletedMediaForScene(
  scene: Scene,
  stage: Stage,
  tasks: Record<string, MediaTask> = useMediaGenerationStore.getState().tasks,
): { scene: Scene; stage: Stage } {
  let nextScene = scene;
  let nextStage = stage;
  for (const task of Object.values(tasks)) {
    if (
      task.stageId !== stage.id ||
      task.status !== 'done' ||
      !isGeneratedMediaPlaceholder(task.placeholderRef)
    ) {
      continue;
    }
    const rewritten = rewriteStageAndScenes(
      nextStage,
      [nextScene],
      task.placeholderRef,
      task.elementId,
      task.posterAssetId,
    );
    nextStage = rewritten.stage;
    nextScene = rewritten.scenes[0];
  }
  return { scene: nextScene, stage: nextStage };
}

async function persistDocumentMediaRef(
  stageId: string,
  oldRef: string,
  assetId: string,
  posterAssetId?: string,
  options: {
    readonly target?: {
      readonly elementId: string;
      readonly sceneId?: string;
      readonly slideId?: string;
    };
    readonly preserveManifestSource?: boolean;
  } = {},
): Promise<ReadonlySet<string>> {
  const capturedEpoch = stageDeletionEpoch(stageId);
  const committed = new Set<string>();
  await mutateDocument(stageId, async (document, store) => {
    if (!document) throw new Error(`Cannot rewrite media in missing document ${stageId}`);
    const rewritten = rewriteDocumentMediaRef(document, oldRef, assetId, posterAssetId, options);
    if (isStageWriteStale(stageId, capturedEpoch)) return;
    if (rewritten !== document) await store.saveDocument(rewritten);
    const refs = collectStageAssetRefs(rewritten, { mediaRows: [], audioRows: [] }).document;
    if (refs.has(assetId)) committed.add(assetId);
    if (posterAssetId && refs.has(posterAssetId)) committed.add(posterAssetId);
  });

  if (isStageWriteStale(stageId, capturedEpoch)) return committed;

  // The document store is authoritative, but the active editor has a separate
  // in-memory aggregate. Mirror the committed rewrite and queue it as dirty so
  // an older debounced snapshot cannot later restore the placeholder.
  const state = useStageStore.getState();
  if (state.stage?.id !== stageId) return committed;
  const rewritten = rewriteStageAndScenes(
    state.stage,
    state.scenes,
    oldRef,
    assetId,
    posterAssetId,
    options,
  );
  if (!rewritten.changed) return committed;
  useStageStore.setState({ stage: rewritten.stage, scenes: rewritten.scenes });
  markStagePersistenceDirty([
    { kind: 'stage' },
    ...rewritten.scenes
      .filter((scene, index) => scene !== state.scenes[index])
      .map((scene) => ({ kind: 'scene' as const, sceneId: scene.id })),
  ]);
  return committed;
}

interface GeneratedMediaDetails {
  width?: number;
  height?: number;
  duration?: number;
}

async function replaceablePosterRefs(
  stageId: string,
  refs: string[],
  activePersistedRefs: StageAssetRefs,
): Promise<string[]> {
  if (refs.length === 0) return [];
  if (refs.some((ref) => (activePersistedRefs.referenceCounts.get(ref) ?? 0) !== 1)) return [];
  const shared = await Promise.all(
    refs.map((ref) => isAllocatedAssetRefReferencedBySurvivingDocument(ref, stageId)),
  );
  if (shared.some(Boolean)) return [];
  const found = await Promise.all(refs.map((ref) => assetRefExists(ref)));
  return found.every(Boolean) ? refs : [];
}

function generationMeta(
  req: MediaGenerationRequest,
  contentType: string,
  details: GeneratedMediaDetails,
): AssetMeta {
  const settings = useSettingsStore.getState();
  const providerId = req.type === 'image' ? settings.imageProviderId : settings.videoProviderId;
  const modelId = req.type === 'image' ? settings.imageModelId : settings.videoModelId;
  return {
    contentType,
    mediaType: req.type,
    prompt: req.prompt,
    params: {
      aspectRatio: req.aspectRatio,
      style: req.style,
    },
    ...(details.width !== undefined && details.height !== undefined
      ? { dimensions: { width: details.width, height: details.height } }
      : {}),
    ...(details.duration !== undefined ? { duration: details.duration } : {}),
    provider: { id: providerId, model: modelId },
  };
}

async function generateSingleMedia(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
  replacement: {
    readonly replaceAssetId?: string;
    readonly replacePosterAssetIds?: readonly string[];
    readonly target?: {
      readonly elementId: string;
      readonly sceneId?: string;
      readonly slideId?: string;
    };
    readonly sourceRef?: string;
    readonly forkIfShared?: {
      readonly sourceRef: string;
      readonly target: {
        readonly elementId: string;
        readonly sceneId?: string;
        readonly slideId?: string;
      };
      readonly sourceTask: MediaTask;
    };
  } = {},
): Promise<string | undefined> {
  const { forkIfShared } = replacement;
  let activeReplaceAssetId = replacement.replaceAssetId;
  let activeReplacePosterAssetIds = replacement.replacePosterAssetIds ?? [];
  let activeTarget = replacement.target;
  let activeSourceRef = replacement.sourceRef;
  let progressElementId = req.elementId;
  const store = useMediaGenerationStore.getState();
  store.markGenerating(req.elementId);
  const placeholderRef =
    activeSourceRef === undefined
      ? (store.getTask(req.elementId)?.placeholderRef ??
        (isGeneratedMediaPlaceholder(req.elementId) ? req.elementId : undefined))
      : undefined;
  const documentRef = activeSourceRef ?? req.elementId;
  let poolReplacementCommitted = false;
  const freshAllocations = new Set<string>();

  try {
    let resultUrl: string;
    let posterUrl: string | undefined;
    let mimeType: string;
    let details: GeneratedMediaDetails;

    if (req.type === 'image') {
      const result = await callImageApi(req, abortSignal);
      resultUrl = result.url;
      mimeType = 'image/png';
      details = { width: result.width, height: result.height };
    } else {
      const result = await callVideoApi(req, abortSignal);
      resultUrl = result.url;
      posterUrl = result.poster;
      mimeType = 'video/mp4';
      details = { width: result.width, height: result.height, duration: result.duration };
    }

    if (abortSignal?.aborted) return;

    // Fetch blob from URL
    const blob = await fetchAsBlob(resultUrl);
    const posterBlob = posterUrl ? await fetchAsBlob(posterUrl).catch(() => undefined) : undefined;

    const contentType = blob.type || mimeType;
    const meta = generationMeta(req, contentType, details);

    // The generation request is asynchronous, so the start-time ownership
    // proof may be stale. Re-run the repository-wide proof immediately before
    // the first pool write and fail closed into the target-scoped fork path.
    if (activeReplaceAssetId) {
      const ownership = await proveExclusiveAssetOwnership(activeReplaceAssetId, stageId);
      if (!ownership.exclusive) {
        if (!forkIfShared?.target.sceneId || !forkIfShared.target.slideId) {
          throw new MediaApiError(
            'Media ownership changed and the retry target is no longer safely scoped',
            'TARGET_MISSING',
          );
        }
        const generatingTask = useMediaGenerationStore.getState().tasks[req.elementId];
        activeSourceRef = forkIfShared.sourceRef;
        activeTarget = forkIfShared.target;
        progressElementId = forkIfShared.target.elementId;
        activeReplaceAssetId = undefined;
        activeReplacePosterAssetIds = [];
        useMediaGenerationStore.setState((state) => ({
          tasks: {
            ...state.tasks,
            [forkIfShared.sourceRef]: forkIfShared.sourceTask,
            ...(generatingTask
              ? {
                  [progressElementId]: {
                    ...generatingTask,
                    elementId: progressElementId,
                    placeholderRef: undefined,
                    objectUrl: undefined,
                    poster: undefined,
                    posterAssetId: undefined,
                  },
                }
              : {}),
          },
        }));
      } else if (req.type === 'video' && ownership.activePersistedRefs) {
        activeReplacePosterAssetIds = await replaceablePosterRefs(
          stageId,
          currentPosterRefs(stageId, activeReplaceAssetId),
          ownership.activePersistedRefs,
        );
      }
    }

    // Crash-safety invariant: pool bytes first, the Part 2 compatibility
    // double-write second, and the document rewrite last. A failed step leaves
    // the document on its old reference, never pointing at missing bytes.
    const assetId = activeReplaceAssetId ?? (await putAsset(blob, meta));
    if (!activeReplaceAssetId) freshAllocations.add(assetId);
    if (activeReplaceAssetId) {
      await replaceAsset(activeReplaceAssetId, blob, meta);
      poolReplacementCommitted = true;
    }
    const posterMeta: AssetMeta | undefined = posterBlob
      ? {
          ...meta,
          contentType: posterBlob.type || 'image/jpeg',
          mediaType: 'video-poster',
          parentRef: assetId,
        }
      : undefined;
    let posterAssetId: string | undefined;
    if (posterBlob && posterMeta) {
      if (activeReplaceAssetId && activeReplacePosterAssetIds.length > 0) {
        await Promise.all(
          activeReplacePosterAssetIds.map((ref) => replaceAsset(ref, posterBlob, posterMeta)),
        );
      } else {
        posterAssetId = await putAsset(posterBlob, posterMeta);
        freshAllocations.add(posterAssetId);
      }
    }

    // Dexie remains a deliberate double-write until Part 3 converges the three
    // export paths, thumbnail restoration, and import/export onto the pool.
    const createdAt = Date.now();
    const params = JSON.stringify({
      aspectRatio: req.aspectRatio,
      style: req.style,
    });
    try {
      await db.mediaFiles.put({
        id: mediaFileKey(stageId, assetId),
        stageId,
        type: req.type,
        blob,
        mimeType: contentType,
        size: blob.size,
        poster: posterBlob,
        prompt: req.prompt,
        params,
        placeholderRef,
        createdAt,
      });

      // Posters are independently allocated assets. Keep a compatibility row
      // under each poster's own id as well as the legacy copy on the video row.
      if (posterBlob) {
        const posterIds = posterAssetId ? [posterAssetId] : activeReplacePosterAssetIds;
        await Promise.all(
          posterIds.map((posterId) =>
            db.mediaFiles.put({
              id: mediaFileKey(stageId, posterId),
              stageId,
              type: 'image',
              blob: posterBlob,
              mimeType: posterBlob.type || 'image/jpeg',
              size: posterBlob.size,
              prompt: req.prompt,
              params,
              createdAt,
            }),
          ),
        );
      }
    } catch (error) {
      if (activeReplaceAssetId && poolReplacementCommitted) {
        throw new MediaApiError(
          `Asset pool replacement succeeded but the compatibility media store lagged: ${error instanceof Error ? error.message : String(error)}`,
          'MEDIA_COMPATIBILITY_STORE_LAGGED',
        );
      }
      throw error;
    }

    if (!activeReplaceAssetId || posterAssetId) {
      const committed = await persistDocumentMediaRef(
        stageId,
        documentRef,
        assetId,
        posterAssetId,
        {
          target: activeTarget,
          preserveManifestSource: activeSourceRef !== undefined,
        },
      );
      for (const ref of committed) freshAllocations.delete(ref);
      if (activeSourceRef !== undefined && !committed.has(assetId)) {
        throw new MediaApiError(
          'The selected media retry target no longer exists',
          'TARGET_MISSING',
        );
      }
    }

    if (!activeReplaceAssetId && activeSourceRef === undefined) {
      // Close the late-scene window: a scene inserted after the first rewrite
      // is reconciled under the same document lock. Do not re-key the task
      // until this final rewrite succeeds: rollback must retain the placeholder
      // task and leave no completed task capable of resurrecting removed bytes.
      const committed = await persistDocumentMediaRef(
        stageId,
        documentRef,
        assetId,
        posterAssetId,
        {
          target: activeTarget,
          preserveManifestSource: false,
        },
      );
      for (const ref of committed) freshAllocations.delete(ref);
    }

    // Publish completion only after every document reconciliation succeeds.
    const objectUrl = URL.createObjectURL(blob);
    const posterObjectUrl = posterBlob ? URL.createObjectURL(posterBlob) : undefined;
    if (activeReplaceAssetId) {
      useMediaGenerationStore.getState().markDone(assetId, objectUrl, posterObjectUrl);
    } else if (activeSourceRef !== undefined) {
      useMediaGenerationStore.setState((state) => {
        const progress = state.tasks[progressElementId];
        if (!progress) return state;
        const tasks = { ...state.tasks };
        delete tasks[progressElementId];
        tasks[assetId] = {
          ...progress,
          elementId: assetId,
          placeholderRef: undefined,
          status: 'done',
          objectUrl,
          poster: posterObjectUrl,
          posterAssetId,
          error: undefined,
          errorCode: undefined,
        };
        return {
          tasks,
        };
      });
    } else {
      useMediaGenerationStore
        .getState()
        .rekeyDone(req.elementId, assetId, objectUrl, posterObjectUrl, posterAssetId);
    }
    return assetId;
  } catch (err) {
    // A document commit can succeed before a later reconciliation fails. Treat
    // those refs as committed even if the failure interrupted the return path.
    const latest = await accessDocument(stageId).catch(() => undefined);
    const protectedRefs = latest?.document
      ? collectStageAssetRefs(latest.document, { mediaRows: [], audioRows: [] }).document
      : new Set<string>();
    for (const ref of freshAllocations) {
      if (protectedRefs.has(ref)) continue;
      await removeAsset(ref).catch(() => undefined);
      await db.mediaFiles.delete(mediaFileKey(stageId, ref)).catch(() => undefined);
    }
    if (abortSignal?.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof MediaApiError ? err.errorCode : undefined;
    log.error(`Failed ${req.elementId}:`, message);
    const failedRef = activeReplaceAssetId ?? progressElementId;
    useMediaGenerationStore.getState().markFailed(failedRef, message, errorCode);

    // Never overwrite a usable same-id compatibility row with an empty failure
    // marker. The live task still carries the retryable error while last-good
    // bytes remain available through Dexie/the pool.
    if (errorCode || activeReplaceAssetId) {
      const key = mediaFileKey(stageId, failedRef);
      const existing = await db.mediaFiles.get(key).catch(() => undefined);
      if (!existing || existing.error || existing.blob.size === 0) {
        await db.mediaFiles
          .put({
            id: key,
            stageId,
            type: req.type,
            blob: new Blob(), // empty placeholder
            mimeType: req.type === 'image' ? 'image/png' : 'video/mp4',
            size: 0,
            prompt: req.prompt,
            params: JSON.stringify({
              aspectRatio: req.aspectRatio,
              style: req.style,
            }),
            error: message,
            errorCode,
            placeholderRef,
            createdAt: Date.now(),
          })
          .catch(() => {}); // best-effort
      }
    }
  }
}

async function callImageApi(
  req: MediaGenerationRequest,
  abortSignal?: AbortSignal,
): Promise<{ url: string; width?: number; height?: number }> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.imageProvidersConfig?.[settings.imageProviderId];

  const response = await fetch('/api/generate/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-image-provider': settings.imageProviderId || '',
      'x-image-model': settings.imageModelId || '',
      'x-api-key': providerConfig?.apiKey || '',
      'x-base-url': providerConfig?.baseUrl || '',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      aspectRatio: req.aspectRatio,
      style: req.style,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new MediaApiError(data.error || `Image API returned ${response.status}`, data.errorCode);
  }

  const data = await response.json();
  if (!data.success)
    throw new MediaApiError(data.error || 'Image generation failed', data.errorCode);

  // Result may have url or base64
  const url =
    data.result?.url || (data.result?.base64 ? `data:image/png;base64,${data.result.base64}` : '');
  if (!url) throw new Error('No image URL in response');
  return { url, width: data.result?.width, height: data.result?.height };
}

async function callVideoApi(
  req: MediaGenerationRequest,
  abortSignal?: AbortSignal,
): Promise<{
  url: string;
  poster?: string;
  width?: number;
  height?: number;
  duration?: number;
}> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  const response = await fetch('/api/generate/video', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-video-provider': settings.videoProviderId || '',
      'x-video-model': settings.videoModelId || '',
      'x-api-key': providerConfig?.apiKey || '',
      'x-base-url': providerConfig?.baseUrl || '',
    },
    body: JSON.stringify({
      prompt: req.prompt,
      aspectRatio: req.aspectRatio,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new MediaApiError(data.error || `Video API returned ${response.status}`, data.errorCode);
  }

  const data = await response.json();
  if (!data.success)
    throw new MediaApiError(data.error || 'Video generation failed', data.errorCode);

  const url = data.result?.url;
  if (!url) throw new Error('No video URL in response');
  return {
    url,
    poster: data.result?.poster,
    width: data.result?.width,
    height: data.result?.height,
    duration: data.result?.duration,
  };
}

async function fetchAsBlob(url: string): Promise<Blob> {
  // For data URLs, convert directly
  if (url.startsWith('data:')) {
    const res = await fetch(url);
    return res.blob();
  }
  // For remote URLs, proxy through our server to bypass CORS restrictions
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetch('/api/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Proxy fetch failed: ${res.status}`);
    }
    return res.blob();
  }
  // Relative URLs (shouldn't happen, but handle gracefully)
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch blob: ${res.status}`);
  return res.blob();
}
