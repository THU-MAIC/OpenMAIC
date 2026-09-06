/**
 * Media Generation Orchestrator
 *
 * Dispatches media generation API calls for all mediaGenerations across outlines.
 * Runs entirely on the frontend — calls /api/generate/image and /api/generate/video,
 * fetches result blobs and updates the Zustand store.
 *
 * Where the bytes land, and what the document ends up pointing at, depends on
 * how durable the document is:
 *
 * - Browser-only: bytes go to the local `mediaFiles` table and the document
 *   keeps its `gen_img_*` / `gen_vid_*` placeholder. Document and media share
 *   one lifetime, so the placeholder is a complete address.
 * - Server-backed: the document outlives this browser, so the bytes go to the
 *   asset pool first and the id the pool allocated is written back into the
 *   document. Only then is the task done. The local table becomes a cache for
 *   this tab, never the source of truth, and "already generated?" is answered
 *   by the document instead of by that cache.
 */

import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useSettingsStore } from '@/lib/store/settings';
import { useStageStore } from '@/lib/store/stage';
import { mayGenerateForStage } from '@/lib/classroom/generation-permission';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { SceneOutline } from '@/lib/types/generation';
import type { MediaGenerationRequest } from '@/lib/media/types';
import { putAsset, removeAsset } from '@/lib/media/asset-pool';
import {
  indexGeneratedMediaReferences,
  isGeneratedMediaSatisfied,
  type GeneratedMediaDocumentIndex,
} from '@/lib/media/generated-media-references';
import {
  MediaReferenceWriteBackError,
  persistGeneratedMediaReference,
  type MediaReferenceWriteBackResult,
} from '@/lib/media/persist-media-reference';
import {
  pendingMediaAllocation,
  recordPendingMediaAllocation,
} from '@/lib/media/pending-media-allocations';
import { fetchProxiedMediaUrl } from '@/lib/media/proxy-media-cache';
import { isServerBackedMediaPersistence } from '@/lib/persistence/media-persistence';
import { createLogger } from '@/lib/logger';

const log = createLogger('MediaOrchestrator');

/** Error with a structured errorCode from the API */
class MediaApiError extends Error {
  errorCode?: string;
  constructor(message: string, errorCode?: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('Aborted', 'AbortError');
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
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
  // Under server-backed persistence the document, not this browser's task
  // table, decides what still needs generating: the table is per-browser, so
  // reading it is exactly how every new browser re-ran (and re-billed) an
  // already-generated course.
  const documentIndex = documentSkipIndex(stageId);

  // Collect all media requests
  const allRequests: MediaGenerationRequest[] = [];
  for (const outline of outlines) {
    if (!outline.mediaGenerations) continue;
    for (const mg of outline.mediaGenerations) {
      // Filter by enabled flags
      if (mg.type === 'image' && !settings.imageGenerationEnabled) continue;
      if (mg.type === 'video' && !settings.videoGenerationEnabled) continue;
      const existing = store.getTask(mg.elementId);
      if (documentIndex) {
        // The document is the authority. A permanently failed task (content
        // policy, generation disabled) is still honoured: it is a refusal to
        // call the provider again, never a claim that media exists.
        if (isGeneratedMediaSatisfied(documentIndex, outline.order, mg.elementId)) continue;
        // Stored, waiting for its slide to exist. Asking the provider again
        // would pay twice for bytes this session already holds.
        if (pendingMediaAllocation(stageId, mg.elementId)) continue;
        if (existing?.status === 'failed') continue;
      } else {
        // Skip already completed or permanently failed (restored from DB)
        if (existing?.status === 'done' || existing?.status === 'failed') continue;
      }
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
  _target?: { readonly elementId: string; readonly sceneId?: string; readonly slideId?: string },
): Promise<void> {
  const store = useMediaGenerationStore.getState();
  const task = store.getTask(elementId);
  if (!task || task.status !== 'failed') return;

  // The affordance that calls this is already hidden when generation is not
  // permitted; refusing here too is what makes the render condition and the
  // action precondition the same rule rather than two that can drift.
  if (!mayGenerateForStage(task.stageId)) return;

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

  // Remove persisted failure record from DB so a fresh result can be written
  const dbKey = mediaFileKey(task.stageId, elementId);
  await db.mediaFiles.delete(dbKey).catch(() => {});

  store.markPendingForRetry(elementId);
  await generateSingleMedia(
    {
      type: task.type,
      prompt: task.prompt,
      elementId: task.elementId,
      aspectRatio: task.params.aspectRatio as MediaGenerationRequest['aspectRatio'],
      style: task.params.style,
    },
    task.stageId,
  );
}

/** Build the renderer retry scope while classic retries remain placeholder-keyed. */
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

/**
 * The document's answer to "what still needs generating", or `undefined` in
 * browser-only mode, where the local task table remains the only answer there
 * is.
 */
function documentSkipIndex(stageId: string): GeneratedMediaDocumentIndex | undefined {
  if (!isServerBackedMediaPersistence()) return undefined;
  const { stage, scenes, generationComplete } = useStageStore.getState();
  // Another course's scenes would answer for slides this stage does not own,
  // and a wrong "already generated" is a slide that never gets its media.
  if (stage?.id !== stageId) return undefined;
  return indexGeneratedMediaReferences({ stage, scenes, generationComplete });
}

/**
 * Commit generated bytes under server-backed persistence: pool first, then the
 * document, then the local cache, and only then the task.
 *
 * Order is the contract. A reference reaches the document only after `put`
 * returned an id, so the document can never name bytes that were not stored;
 * and a failure anywhere before the write-back leaves the placeholder in place
 * with the provider called exactly once, so the retry happens on the next
 * owner load rather than inside this run.
 */
async function commitPooledMedia(args: {
  req: MediaGenerationRequest;
  stageId: string;
  paramsJson: string;
  blob: Blob;
  mimeType: string;
  posterBlob?: Blob;
  posterMimeType?: string;
}): Promise<void> {
  const { req, stageId, paramsJson, blob, mimeType, posterBlob, posterMimeType } = args;

  const assetId = await putAsset(blob, { contentType: mimeType });
  // A poster is decorative: it is written only into a slot that has none of its
  // own. Letting its upload fail the commit would discard a stored video and
  // send the retry to submit the most expensive job in the system a second
  // time, so a poster failure costs the poster and nothing else.
  let posterAssetId: string | undefined;
  if (posterBlob) {
    try {
      posterAssetId = await putAsset(posterBlob, {
        contentType: posterMimeType ?? posterBlob.type,
      });
    } catch (error) {
      log.warn(`Poster allocation failed for ${req.elementId}; keeping the video:`, error);
    }
  }

  let outcome: MediaReferenceWriteBackResult;
  try {
    outcome = await persistGeneratedMediaReference(stageId, {
      placeholderRef: req.elementId,
      assetId,
      ...(posterAssetId ? { posterAssetId } : {}),
    });
  } catch (error) {
    // Nothing reached the document: the ids this commit allocated are named by
    // nobody and would otherwise sit in the registry forever, where the byte
    // collector cannot see them. A partial write is left alone — the document
    // already names them.
    if (!(error instanceof MediaReferenceWriteBackError) || !error.documentWritten) {
      await removeAsset(assetId).catch(() => undefined);
      if (posterAssetId) await removeAsset(posterAssetId).catch(() => undefined);
    }
    throw error;
  }

  // Local cache for this tab only. The document already points at the pool, so
  // a failed cache write costs a re-download, never the media.
  await db.mediaFiles
    .put({
      id: mediaFileKey(stageId, assetId),
      stageId,
      type: req.type,
      blob,
      mimeType,
      size: blob.size,
      poster: posterBlob,
      placeholderRef: req.elementId,
      prompt: req.prompt,
      params: paramsJson,
      createdAt: Date.now(),
    })
    .catch((error: unknown) => {
      log.warn(`Local media cache write failed for ${assetId}:`, error);
    });

  const objectUrl = URL.createObjectURL(blob);
  const posterObjectUrl = posterBlob ? URL.createObjectURL(posterBlob) : undefined;

  if (outcome === 'unmatched') {
    // The slide this media belongs to has not been built yet, which during a
    // first pass is the ordinary case rather than an edge one. The allocation
    // is held under the placeholder and applied when that scene is committed;
    // until then the task stays keyed by the placeholder so the request is
    // recognisably answered and the provider is not asked a second time.
    recordPendingMediaAllocation({
      stageId,
      placeholderRef: req.elementId,
      assetId,
      posterAssetId,
      objectUrl,
      posterObjectUrl,
    });
    useMediaGenerationStore.getState().markDone(req.elementId, objectUrl, posterObjectUrl);
    return;
  }

  useMediaGenerationStore
    .getState()
    .rekeyDone(req.elementId, assetId, objectUrl, posterObjectUrl, posterAssetId);
}

/**
 * The content type to record for stored bytes.
 *
 * The generation routes declare no media type, so the only signal is whatever
 * the transfer reported. A generic or empty value carries no information and
 * must not become the asset's recorded type: the pool mints its object URL from
 * it, and `<video>` will not play a source it is told is an octet stream.
 */
function storedMediaType(blob: Blob, fallback: string): string {
  const declared = blob.type.trim();
  return declared && declared !== 'application/octet-stream' ? declared : fallback;
}

async function generateSingleMedia(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const store = useMediaGenerationStore.getState();
  store.markGenerating(req.elementId);

  try {
    const paramsJson = JSON.stringify({
      aspectRatio: req.aspectRatio,
      style: req.style,
    });

    const serverBacked = isServerBackedMediaPersistence();

    if (req.type === 'image') {
      const result = await callImageApi(req, stageId, abortSignal);

      if (serverBacked) {
        // A hosted URL is the provider's address, not a durable reference the
        // document may hold, so the bytes are fetched and put to the pool.
        throwIfAborted(abortSignal);
        const blob = await fetchAsBlob(result.ossUrl || result.url);
        throwIfAborted(abortSignal);
        await commitPooledMedia({
          req,
          stageId,
          paramsJson,
          blob,
          mimeType: storedMediaType(blob, 'image/png'),
        });
        return;
      }

      // CDN path: server already uploaded to OSS
      if (result.ossUrl) {
        throwIfAborted(abortSignal);
        await db.mediaFiles.put({
          id: mediaFileKey(stageId, req.elementId),
          stageId,
          type: 'image',
          blob: new Blob([]),
          mimeType: 'image/png',
          size: 0,
          ossKey: result.ossUrl,
          prompt: req.prompt,
          params: paramsJson,
          createdAt: Date.now(),
        });
        useMediaGenerationStore.getState().markDone(req.elementId, result.ossUrl);
        return;
      }

      // Fallback: fetch blob via proxy-media
      throwIfAborted(abortSignal);
      const blob = await fetchAsBlob(result.url);
      await db.mediaFiles.put({
        id: mediaFileKey(stageId, req.elementId),
        stageId,
        type: 'image',
        blob,
        mimeType: 'image/png',
        size: blob.size,
        prompt: req.prompt,
        params: paramsJson,
        createdAt: Date.now(),
      });
      const objectUrl = URL.createObjectURL(blob);
      useMediaGenerationStore.getState().markDone(req.elementId, objectUrl);
    } else {
      const result = await callVideoApi(req, abortSignal);

      if (serverBacked) {
        throwIfAborted(abortSignal);
        const blob = await fetchAsBlob(result.ossUrl || result.url);
        const posterSource = result.posterOssUrl || result.poster;
        const posterBlob = posterSource
          ? await fetchAsBlob(posterSource).catch(() => undefined)
          : undefined;
        throwIfAborted(abortSignal);
        await commitPooledMedia({
          req,
          stageId,
          paramsJson,
          blob,
          mimeType: storedMediaType(blob, 'video/mp4'),
          posterBlob,
          ...(posterBlob ? { posterMimeType: storedMediaType(posterBlob, 'image/jpeg') } : {}),
        });
        return;
      }

      // CDN path: server already uploaded to OSS
      if (result.ossUrl) {
        throwIfAborted(abortSignal);
        await db.mediaFiles.put({
          id: mediaFileKey(stageId, req.elementId),
          stageId,
          type: 'video',
          blob: new Blob([]),
          mimeType: 'video/mp4',
          size: 0,
          ossKey: result.ossUrl,
          posterOssKey: result.posterOssUrl,
          prompt: req.prompt,
          params: paramsJson,
          createdAt: Date.now(),
        });
        useMediaGenerationStore
          .getState()
          .markDone(req.elementId, result.ossUrl, result.posterOssUrl);
        return;
      }

      // Fallback: fetch blob via proxy-media
      throwIfAborted(abortSignal);
      const blob = await fetchAsBlob(result.url);
      const posterBlob = result.poster
        ? await fetchAsBlob(result.poster).catch(() => undefined)
        : undefined;
      await db.mediaFiles.put({
        id: mediaFileKey(stageId, req.elementId),
        stageId,
        type: 'video',
        blob,
        mimeType: 'video/mp4',
        size: blob.size,
        poster: posterBlob,
        prompt: req.prompt,
        params: paramsJson,
        createdAt: Date.now(),
      });
      const objectUrl = URL.createObjectURL(blob);
      const posterObjectUrl = posterBlob ? URL.createObjectURL(posterBlob) : undefined;
      useMediaGenerationStore.getState().markDone(req.elementId, objectUrl, posterObjectUrl);
    }
  } catch (err) {
    if (abortSignal?.aborted) {
      // A submitted video MaaS task keeps running to a billable terminal state
      // server-side even after this client stops polling. Mark either media
      // task retryable instead of leaving it stuck in `generating`; note that
      // retrying a video submits a second job rather than resuming the first.
      const abortedMessage =
        req.type === 'video'
          ? 'Video generation polling was aborted; retry to submit a new job'
          : 'Image generation was aborted; retry to submit a new request';
      useMediaGenerationStore.getState().markFailed(req.elementId, abortedMessage);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof MediaApiError ? err.errorCode : undefined;
    log.error(`Failed ${req.elementId}:`, message);
    useMediaGenerationStore.getState().markFailed(req.elementId, message, errorCode);

    // Persist non-retryable failures to IndexedDB so they survive page refresh
    if (errorCode) {
      await db.mediaFiles
        .put({
          id: mediaFileKey(stageId, req.elementId),
          stageId,
          type: req.type,
          blob: new Blob(), // empty placeholder
          mimeType: req.type === 'image' ? 'image/png' : 'video/mp4',
          size: 0,
          prompt: req.prompt,
          params: JSON.stringify({ aspectRatio: req.aspectRatio, style: req.style }),
          error: message,
          errorCode,
          createdAt: Date.now(),
        })
        .catch(() => {}); // best-effort
    }
  }
}

async function callImageApi(
  req: MediaGenerationRequest,
  stageId: string,
  abortSignal?: AbortSignal,
): Promise<{ url: string; ossUrl?: string }> {
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
      stageId,
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

  // Result may have ossUrl (CDN direct), url, or base64
  const ossUrl = data.result?.ossUrl as string | undefined;
  const url =
    data.result?.url || (data.result?.base64 ? `data:image/png;base64,${data.result.base64}` : '');
  if (!ossUrl && !url) throw new Error('No image URL in response');
  return { url, ossUrl };
}

async function callVideoApi(
  req: MediaGenerationRequest,
  abortSignal?: AbortSignal,
): Promise<{
  url: string;
  poster?: string;
  ossUrl?: string;
  posterOssUrl?: string;
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
    ossUrl: data.result?.ossUrl,
    posterOssUrl: data.result?.posterOssUrl,
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
  // For remote URLs, proxy through our server to bypass CORS restrictions.
  // Routed through the shared proxy-media negative cache so a permanently
  // failed URL (4xx) is not re-fetched by retries or later generation passes.
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetchProxiedMediaUrl(url);
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
