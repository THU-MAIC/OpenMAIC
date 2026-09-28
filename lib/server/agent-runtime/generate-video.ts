import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssetStore } from '@openmaic/storage';
import { nanoid } from 'nanoid';
import { Type, type Static } from 'typebox';

import { generateVideo, normalizeVideoOptions, VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
  VideoProviderId,
} from '@/lib/media/types';
import {
  enabledProviderIds,
  getServerVideoProviders,
  isServerProviderDisabled,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
} from '@/lib/server/provider-config';
import { createLogger } from '@/lib/logger';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import {
  DownloadByteBudget,
  MAX_REMOTE_IMAGE_BATCH_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  readResponseBodyWithLimit,
} from '@/lib/server/bounded-download';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import {
  AssetStorageFullError,
  storeGeneratedAssetOrThrow,
} from '@/lib/server/store-generated-asset';
import {
  HOST_AGENT_LIFECYCLE as LIFECYCLE,
  type MediaReadyLifecycleData,
} from '@/lib/agent-runtime/lifecycle';
import type { Scene } from '@/lib/types/stage';
import type { CourseStore, CourseToolDeps } from './course-tools';
import { COURSE_STAGE_ID_DESCRIPTION } from './course-stage';
import { errorResult, MEDIA_TOOL_ERROR_REASONS } from './media-tool-result';
import { runStageMutation } from './mutation-fence';
import { registerPendingMedia, setPendingMediaStage, settlePendingMedia } from './pending-media';
import { getAgentSessionStore } from './store';

const log = createLogger('AgentGenerateVideo');

export const GENERATE_VIDEO_TOOL_NAME = 'generate_video';
// The longest provider poll budget is 15 minutes.
export const GENERATE_VIDEO_TIMEOUT_MS = 15 * 60_000;
/** The completion patch is a handful of document writes; a minute is ample. */
export const GENERATE_VIDEO_PATCH_TIMEOUT_MS = 60_000;
export const MAX_GENERATED_VIDEO_BYTES = 200 * 1024 * 1024;

export const GenerateVideoParams = Type.Object({
  stageId: Type.String({ description: COURSE_STAGE_ID_DESCRIPTION }),
  prompt: Type.String({
    minLength: 1,
    description: 'A concrete visual and motion description of the video to create.',
  }),
  aspectRatio: Type.Optional(
    Type.Union(
      [
        Type.Literal('16:9'),
        Type.Literal('4:3'),
        Type.Literal('1:1'),
        Type.Literal('9:16'),
        Type.Literal('3:4'),
        Type.Literal('21:9'),
      ],
      { description: 'Requested output aspect ratio. Provider capabilities may normalize it.' },
    ),
  ),
  durationSec: Type.Optional(
    Type.Number({
      minimum: 1,
      description: 'Requested duration in seconds. Provider capabilities may normalize it.',
    }),
  ),
  resolution: Type.Optional(
    Type.Union([Type.Literal('480p'), Type.Literal('720p'), Type.Literal('1080p')], {
      description: 'Requested output resolution. Provider capabilities may normalize it.',
    }),
  ),
});

type GenerateConfiguredVideo = (
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
) => Promise<VideoGenerationResult>;

interface PersistVideoInput {
  result: VideoGenerationResult;
  stageId: string;
  signal: AbortSignal;
  /** The run's owner; the bytes are allocated in its asset partition. */
  ownerId?: string;
}

interface PersistedVideo {
  /** The allocated asset id for the video bytes. */
  src: string;
  mime: string;
  /**
   * The allocated asset id for the provider's poster image, when it offered
   * one and storing it succeeded. Absent otherwise: a poster is an
   * optimization, and losing it must never cost the video.
   */
  poster?: string;
}

type PersistGeneratedVideo = (input: PersistVideoInput) => Promise<PersistedVideo>;

/** The stored ids the completion patch writes onto the element. */
type PersistedMedia = Pick<PersistedVideo, 'src' | 'poster'>;

export interface GenerateVideoToolDeps extends Pick<
  CourseToolDeps,
  'sessionId' | 'abortSignal' | 'ownerId'
> {
  /**
   * The document store for the detached background job's completion patch.
   * It must be owner-bound but NOT fenced by the run lease: the job
   * legitimately writes minutes after its run ended, when the lease is
   * already released, so the runner wires a dedicated lease-free store here.
   * Passing the shared run-fenced `store` would throw
   * AgentSessionLeaseLostError on every post-run patch. Without it the job
   * still generates and emits, but skips the patch.
   */
  backgroundStore?: CourseStore;
  getConfiguredVideoProviders?: () => Record<string, { models?: string[]; disabled?: boolean }>;
  resolveVideoProviderConfig?: (providerId: VideoProviderId) => VideoGenerationConfig;
  generateConfiguredVideo?: GenerateConfiguredVideo;
  persistGeneratedVideo?: PersistGeneratedVideo;
  /**
   * Completion channel for the background job. Defaults to appending the
   * `media_ready` lifecycle event to the session's durable log through the
   * session-level control channel (valid post-run, unlike the runner's
   * lease-guarded `emit`).
   */
  emitMediaReady?: (sessionId: string, data: MediaReadyLifecycleData) => Promise<void> | void;
  timeoutMs?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

function isTimeout(signal: AbortSignal): boolean {
  return (
    signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
  );
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** SSRF-guarded, redirect-following fetch for a provider's video or poster. */
async function fetchGeneratedMedia(url: string, signal: AbortSignal): Promise<Response> {
  const maxRedirects = 5;
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    throwIfAborted(signal);
    const ssrfError = await validateUrlForSSRF(currentUrl);
    throwIfAborted(signal);
    if (ssrfError) throw new Error(ssrfError);

    const response = await fetch(currentUrl, { redirect: 'manual', signal });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) throw new Error('Video download redirect has no Location header');
    if (hop >= maxRedirects) throw new Error('Video download exceeded 5 redirects');
    currentUrl = new URL(location, currentUrl).href;
  }
}

/**
 * Download the provider's poster and store it, or give up on it.
 *
 * A poster is a convenience the provider may or may not offer, so every
 * failure here — a bad URL, a download error, a full store — costs the poster
 * and nothing else. The video is the deliverable, and it is already stored by
 * the time this runs.
 */
async function storeGeneratedPoster(
  posterUrl: string,
  ownerId: string,
  stageId: string,
  signal: AbortSignal,
  assetStore?: AssetStore,
): Promise<string | undefined> {
  try {
    const response = await fetchGeneratedMedia(posterUrl, signal);
    if (!response.ok) throw new Error(`Generated poster download failed: HTTP ${response.status}`);
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
    if (!mime.startsWith('image/')) {
      throw new Error(`Generated poster download returned unexpected content type: ${mime}`);
    }
    // A poster is a still frame, so the image caps apply to it rather than the
    // video's.
    const bytes = await readResponseBodyWithLimit(response, {
      maxBytes: MAX_REMOTE_IMAGE_BYTES,
      aggregateBudget: new DownloadByteBudget(MAX_REMOTE_IMAGE_BATCH_BYTES),
    });
    throwIfAborted(signal);
    return await storeGeneratedAssetOrThrow({
      ownerId,
      stageId,
      bytes,
      mimeType: mime,
      kind: 'poster',
      assetStore,
    });
  } catch (error) {
    log.warn(
      `Generated poster for stage ${stageId} was not stored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * Video providers return hosted URLs that may expire. Materialize those bytes
 * into the asset pool and return the ids it allocated.
 *
 * `src` is an `ast_` id rather than a serving path. The completion patch names
 * it (and the poster's id) on the video element, and that document write is
 * what commits both allocations and records their references (#1473). A video
 * the store has no room for fails the job: there is no local-disk fallback,
 * because a fallback would restore the two-model situation this path removes.
 *
 * `assetStore` is a test seam — the historical shape of this function before
 * #1242 replaced the pool with a local file.
 */
export async function defaultPersistGeneratedVideo(
  { result, stageId, signal, ownerId }: PersistVideoInput,
  assetStore?: AssetStore,
): Promise<PersistedVideo> {
  if (!ownerId) throw new Error('Generated media cannot be stored without the run owner');
  throwIfAborted(signal);
  let parsed: URL;
  try {
    parsed = new URL(result.url);
  } catch {
    throw new Error('Video provider returned an invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Video provider returned an unsupported URL protocol: ${parsed.protocol}`);
  }

  const response = await fetchGeneratedMedia(result.url, signal);
  if (!response.ok) throw new Error(`Generated video download failed: HTTP ${response.status}`);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || 'video/mp4';
  if (!mime.startsWith('video/')) {
    throw new Error(`Generated video download returned unexpected content type: ${mime}`);
  }
  const bytes = await readResponseBodyWithLimit(response, { maxBytes: MAX_GENERATED_VIDEO_BYTES });
  throwIfAborted(signal);

  const src = await storeGeneratedAssetOrThrow({
    ownerId,
    stageId,
    bytes,
    mimeType: mime,
    kind: 'video',
    assetStore,
  });
  throwIfAborted(signal);

  const poster = result.poster
    ? await storeGeneratedPoster(result.poster, ownerId, stageId, signal, assetStore)
    : undefined;
  throwIfAborted(signal);
  return { src, mime, ...(poster ? { poster } : {}) };
}

/**
 * Enabled video provider ids from the listing: configured and not
 * force-disabled (#665). The gate and the selector both resolve enabledness
 * through {@link enabledProviderIds}, so an operator force-off is never
 * registered or selected.
 */
function configuredProviderIds(
  configured: Record<string, { models?: string[]; disabled?: boolean }>,
): VideoProviderId[] {
  return enabledProviderIds(configured).filter(
    (id): id is VideoProviderId => id in VIDEO_PROVIDERS,
  );
}

/** Server-side config resolution; the server `_MODELS` pin is authoritative. */
function defaultResolveVideoProviderConfig(providerId: VideoProviderId): VideoGenerationConfig {
  return {
    providerId,
    apiKey: resolveVideoApiKey(providerId),
    baseUrl: resolveVideoBaseUrl(providerId),
    model: resolveVideoModel(providerId),
  };
}

/** Capability gate used before the tool enters a session's registered toolset. */
export function hasConfiguredVideoGeneration(deps: Partial<GenerateVideoToolDeps> = {}): boolean {
  const getConfigured = deps.getConfiguredVideoProviders ?? getServerVideoProviders;
  const resolveConfig = deps.resolveVideoProviderConfig ?? defaultResolveVideoProviderConfig;
  return configuredProviderIds(getConfigured()).some((providerId) => {
    const provider = VIDEO_PROVIDERS[providerId];
    const config = resolveConfig(providerId);
    return !provider.requiresApiKey || !!config.apiKey;
  });
}

/**
 * Default completion channel: append `media_ready` to the session's durable
 * event log through the session-level control channel. This deliberately does
 * NOT go through the runner's `emit`: `appendRunEvent` is lease-guarded to a
 * live run, while the background job routinely settles after its run ended.
 * `appendControlEvent` writes the same log the SSE route replays and fires the
 * transactional NOTIFY that wakes attached streams.
 */
async function defaultEmitMediaReady(
  sessionId: string,
  data: MediaReadyLifecycleData,
): Promise<void> {
  const store = await getAgentSessionStore();
  const appended = await store.appendControlEvent(sessionId, {
    ts: Date.now(),
    type: LIFECYCLE.mediaReady,
    data,
  });
  // appendControlEvent resolves null when the session row is gone: the frame
  // is dropped silently by the store, so say so here.
  if (appended === null) {
    log.warn(`media_ready dropped for ${data.ref}: session ${sessionId} no longer exists`);
  }
}

/**
 * Emit one `media_ready` frame through the injected or default channel. A
 * failed emit must never take the detached job down as an unhandled
 * rejection; the registry entry and the document patch still stand.
 */
async function emitMediaReadyFrame(
  deps: GenerateVideoToolDeps,
  toolCallId: string,
  data: MediaReadyLifecycleData,
): Promise<void> {
  const sessionId = deps.sessionId;
  if (!sessionId) {
    log.warn(`[${toolCallId}] media_ready skipped: the tool has no session id`);
    return;
  }
  try {
    await (deps.emitMediaReady ?? defaultEmitMediaReady)(sessionId, data);
  } catch (error) {
    log.error(`[${toolCallId}] media_ready emit failed for ${data.ref}`, error);
  }
}

/**
 * Swap a video placeholder for the stored asset ids on the stored document.
 *
 * THE BINDING MOVES WITH THE BYTES. Every slot that holds the placeholder is
 * rewritten, `mediaRef` included, exactly as the classic chain's
 * `rewriteSlideMediaReference` does. This is not cosmetic: every resolver
 * reads `mediaRef` first — `getVideoMediaRefForElement`
 * (`lib/media/video-manifest.ts:23`), then `sourceRef = concreteSrc ?? mediaRef
 * ?? src` (`lib/media/media-task-resolution.ts:127`), and
 * `poolLeasableSlideRefs` leases only that `sourceRef`. An allocated id in
 * `src` is not a concrete address, so leaving `mediaRef` on `gen_vid_…` would
 * leave the pool never asked about the id, and the documented flow (the tool
 * tells the model to put the ref on `mediaRef`) would store, reference and
 * commit a video that never renders — live or after reload.
 *
 * THE INVARIANT, stated once rather than grown case by case. An element is
 * MATCHED when `src` or `mediaRef` holds `P`, this job's placeholder; `N` is
 * the video id just allocated and `NP` the poster id. For a matched element:
 *
 *   1. every REPLACEABLE slot takes the new id. Replaceable is decided by the
 *      two policies below, not by this list: `isReplaceableSrc` — `P` itself,
 *      absent, empty, or a legacy `/api/classroom-media/<this stage>/` URL —
 *      takes `N`; `isReplaceablePoster` — `P` itself, absent, empty, or any
 *      `gen_*` placeholder — takes `NP`; and a `mediaRef` holding `P` takes
 *      `N`. The two policies predate this invariant and are the reason an
 *      absent `src` is filled rather than left alone.
 *   2. once `src` holds `N`, `mediaRef` holds `N` or nothing. Anything else
 *      there is retired, generated or not: `sourceRef` prefers `mediaRef`, so
 *      whatever else sits there hides a video this element was deliberately
 *      bound to. A concrete URL is retired too — the importer round-trips one
 *      into `mediaRef` (`lib/import/use-import-classroom.ts:58-63`) and
 *      `patch_stage` accepts any string there
 *      (`course-edit/element-schema.ts:406`), so "no writer produces that
 *      shape" was simply false, and the shape hid the finished job.
 *   3. a choice is preserved: a concrete `src`, an allocated `src`, and an
 *      allocated or author-chosen `poster`. Rule 2 never fires against these,
 *      because it is conditioned on `src` having taken `N`.
 *
 * The space the rules cover, and what `sourceRef` resolves to after the patch
 * (`A` = a previous allocated id, `U` = a user's URL in `src`, `MU` = a
 * concrete URL in `mediaRef`, `O` = another job's placeholder, `L` = a legacy
 * `/api/classroom-media/<this stage>/` URL):
 *
 *   src \ mediaRef │  P        A        O        MU       (absent)
 *   ───────────────┼────────────────────────────────────────────────
 *   P              │  N        N¹       N¹       N¹       N
 *   A              │  N²       –        –        –        –
 *   U              │  U³       –        –        –        –
 *   L              │  N        –        –        –        –
 *   (absent)       │  N        –        –        –        –
 *
 *   ¹ rule 2: `src` took `N`, so whatever else `mediaRef` held is removed and
 *     `N` is what `sourceRef` selects through the `src` fallback.
 *   ² rule 1 only: `src` keeps `A` (an allocated id is a choice, not a
 *     placeholder), `mediaRef` takes `N`, and `sourceRef` prefers `mediaRef`
 *     over a `src` that is not a concrete address — so `N` renders.
 *   ³ the user's pick is `concreteSrc`, which beats `mediaRef`; `mediaRef`
 *     still takes `N` so no finished job is left named on the page.
 *   – unmatched: neither slot holds `P`, so the element is not touched.
 *
 * This `putScene` is also the write that commits both allocations and records
 * their rows in `document_asset_refs` — the store does that inside the write's
 * own transaction, so there is no reference bookkeeping here. Same mutation
 * discipline as the generation tools (`runStageMutation` + putScene). When no
 * element references the placeholder anymore — the agent or the user changed
 * or removed it meanwhile — the patch is skipped silently; the completion
 * event still carries the src.
 *
 * Each candidate scene is re-read immediately before its write: the job runs
 * minutes after the tool call, exactly when the user or a resumed run may be
 * editing the same page, so the swap is always applied to the freshest scene
 * rather than the candidate-list snapshot. The residual read→write window
 * matches the stage edit API's own read-modify-write discipline.
 */
export async function patchStageVideoPlaceholder(
  store: CourseStore,
  stageId: string,
  ref: string,
  media: PersistedMedia,
  signal?: AbortSignal,
): Promise<number> {
  const doc = await store.loadDocument(stageId);
  if (!doc) return 0;
  // A `src` this patch may overwrite: the placeholder itself, nothing at all,
  // or a previously generated src of THIS stage (regeneration through the
  // legacy local-disk shape, in both the relative form that flow wrote and the
  // absolute form the classic pipeline persists). Scoped to the stage's own
  // media root so a user's pick copied from another stage is preserved.
  //
  // An allocated `ast_` id is deliberately NOT replaceable. It is a concrete
  // choice — a pick from the shared library, or the previous generation — and
  // the pre-#1522 rule preserved exactly such a value. Regeneration still
  // works without overwriting it: `mediaRef` takes the new id, and
  // `sourceRef = concreteSrc ?? mediaRef ?? src` prefers `mediaRef` over a
  // non-concrete `src`, so the new video is what renders.
  const generatedPrefix = `/api/classroom-media/${stageId}/`;
  const isReplaceableSrc = (value: unknown): boolean => {
    if (value === undefined || value === '' || value === ref) return true;
    if (typeof value !== 'string') return false;
    if (value.startsWith(generatedPrefix)) return true;
    try {
      return new URL(value).pathname.startsWith(generatedPrefix);
    } catch {
      return false;
    }
  };
  // A poster this patch may write over: none of its own, or a generation
  // placeholder. An author-chosen poster and an already-allocated one are
  // never overwritten by a generated one — the same rule as the classic
  // chain's `rewriteSlideMediaReference`.
  const isReplaceablePoster = (value: unknown): boolean => {
    if (value === undefined || value === '' || value === ref) return true;
    return typeof value === 'string' && isGeneratedMediaPlaceholder(value);
  };
  let patched = 0;
  for (const candidate of doc.scenes) {
    if (candidate.type !== 'slide') continue;
    const scene = await store.getScene(stageId, candidate.id);
    if (!scene || scene.type !== 'slide' || scene.content.type !== 'slide') continue;
    const canvas = scene.content.canvas;
    let touched = false;
    const elements = canvas.elements.map((element) => {
      if (element.type !== 'video') return element;
      if (element.mediaRef !== ref && element.src !== ref) return element;

      // RULE 1 — every replaceable slot takes the new id (see the two
      // policies above for what that means per slot). The `mediaRef` rewrite
      // is safe even when the user has swapped in their own concrete `src`: a
      // concrete src still wins in `resolveVideoMediaForElement`, so their
      // pick renders and `mediaRef` merely stops being a dangling placeholder.
      let nextMediaRef = element.mediaRef === ref ? media.src : element.mediaRef;
      const nextSrc = isReplaceableSrc(element.src) ? media.src : element.src;
      const nextPoster =
        media.poster && isReplaceablePoster(element.poster) ? media.poster : element.poster;

      // RULE 2 — nothing may shadow the id we just wrote into `src`. Once
      // `src` holds this job's allocated id, `mediaRef` holds that same id or
      // nothing at all: whatever else sits there wins in `sourceRef` and would
      // render the previous video, another job's skeleton, or an imported URL
      // forever. It applies whether or not that value is a generated
      // reference — a concrete URL reaches `mediaRef` through the importer and
      // through `patch_stage`, and hid the finished job just as effectively.
      // The element was bound to THIS job on purpose, so its result is what
      // has to resolve. This is the classic chain's
      // `normalizeGeneratedVideoRefs`
      // (`packages/@openmaic/generation/src/scene-generator.ts:437-440`, which
      // deletes `mediaRef` whenever a non-generated `src` is set) expressed for
      // the one transition this patch performs; that function is private to the
      // generation package and keyed on outline vocabulary, so the rule is
      // mirrored rather than imported.
      if (nextSrc === media.src && nextMediaRef !== media.src) {
        nextMediaRef = undefined;
      }

      if (
        nextMediaRef === element.mediaRef &&
        nextSrc === element.src &&
        nextPoster === element.poster
      ) {
        return element;
      }
      touched = true;
      // Every id lands in the one write: `putScene` is what commits a freshly
      // allocated entry, so an id named by a second write would be a second
      // chance to lose it.
      const next = { ...element } as Record<string, unknown>;
      if (nextMediaRef === undefined) delete next.mediaRef;
      else next.mediaRef = nextMediaRef;
      if (nextSrc !== undefined) next.src = nextSrc;
      if (nextPoster !== undefined) next.poster = nextPoster;
      return next as unknown as typeof element;
    });
    if (!touched) continue;
    const next = {
      ...scene,
      content: { ...scene.content, canvas: { ...canvas, elements } },
    } as Scene;
    await runStageMutation(signal, () => store.putScene(stageId, next));
    patched += 1;
  }
  return patched;
}

interface VideoJobInput {
  toolCallId: string;
  ref: string;
  stageId: string;
  providerId: VideoProviderId;
  providerConfig: VideoGenerationConfig;
  model: string | undefined;
  options: VideoGenerationOptions;
  timeoutMs: number;
  deps: GenerateVideoToolDeps;
  callProvider: GenerateConfiguredVideo;
  persist: PersistGeneratedVideo;
}

/**
 * The detached submit → poll → download → persist → patch cycle.
 *
 * The job runs on its OWN timeout signal, deliberately NOT tied to the tool
 * call's abortSignal anymore: a cancelled chat must not silently orphan a
 * billable provider job (the classic orchestrator accepts the same caveat —
 * a provider-side submit that already happened is never recalled). The cost
 * is that a cancelled session's video still lands and patches the page.
 */
async function runVideoGenerationJob(input: VideoJobInput): Promise<void> {
  const { deps, ref, stageId, toolCallId } = input;
  const signal = AbortSignal.timeout(input.timeoutMs);
  const emit = (data: MediaReadyLifecycleData): Promise<void> =>
    emitMediaReadyFrame(deps, toolCallId, data);

  try {
    setPendingMediaStage(ref, 'submit');
    const result = await awaitWithSignal(
      input.callProvider(input.providerConfig, { ...input.options, signal }),
      signal,
    );
    throwIfAborted(signal);
    setPendingMediaStage(ref, 'persist');
    const stored = await input.persist({
      result,
      stageId,
      signal,
      ...(deps.ownerId ? { ownerId: deps.ownerId } : {}),
    });
    throwIfAborted(signal);

    void recordGenerationUsage({
      kind: 'video',
      unit: 'second',
      providerId: input.providerId,
      modelId: input.model,
      quantity: result.duration,
    });
    log.info(
      `[${toolCallId}] Video generated: provider=${input.providerId}, model=${input.model ?? 'default'}, ${result.width}x${result.height}, ${result.duration}s`,
    );

    if (deps.backgroundStore) {
      setPendingMediaStage(ref, 'patch');
      try {
        // The patch runs on its own short budget: the shared job signal may
        // be nearly exhausted by the provider cycle, and a patch failure must
        // not rebrand a persisted, downloadable asset as failed — the done
        // frame's src still lets connected clients render it.
        const patched = await patchStageVideoPlaceholder(
          deps.backgroundStore,
          stageId,
          ref,
          { src: stored.src, ...(stored.poster ? { poster: stored.poster } : {}) },
          AbortSignal.timeout(GENERATE_VIDEO_PATCH_TIMEOUT_MS),
        );
        if (patched > 0) {
          log.info(`[${toolCallId}] Patched ${ref} onto ${patched} page(s) of stage ${stageId}`);
        }
      } catch (error) {
        log.error(`[${toolCallId}] Document patch failed for ${ref}`, error);
      }
    }

    settlePendingMedia(ref, { status: 'done', src: stored.src, mime: stored.mime });
    await emit({
      ref,
      stageId,
      status: 'done',
      src: stored.src,
      mime: stored.mime,
      ...(result.duration ? { durationSec: result.duration } : {}),
    });
  } catch (error) {
    // A full store is its own outcome, not a provider failure: nothing was
    // written, the document was not patched, and the condition is one an
    // operator clears rather than one a retry outlasts. The code is the same
    // one the browser's media-failure table already understands, so the
    // workbench says why instead of showing a generic failure.
    const reason =
      error instanceof AssetStorageFullError
        ? MEDIA_TOOL_ERROR_REASONS.storageFull
        : isTimeout(signal)
          ? MEDIA_TOOL_ERROR_REASONS.timeout
          : MEDIA_TOOL_ERROR_REASONS.generationFailed;
    const message = error instanceof Error ? error.message : String(error);
    if (reason === MEDIA_TOOL_ERROR_REASONS.storageFull) {
      log.warn(
        `[${toolCallId}] Video generation refused: the asset store is full, ${ref} was not stored`,
      );
    } else if (reason === MEDIA_TOOL_ERROR_REASONS.timeout) {
      log.warn(
        `[${toolCallId}] Video generation timed out: provider=${input.providerId}, model=${input.model ?? 'default'}, timeoutMs=${input.timeoutMs}`,
      );
    } else {
      log.error(
        `[${toolCallId}] Video generation failed: provider=${input.providerId}, model=${input.model ?? 'default'}, error=${message}`,
        error,
      );
    }
    settlePendingMedia(ref, { status: 'failed', errorCode: reason });
    await emit({ ref, stageId, status: 'failed', errorCode: reason });
  }
}

export function buildGenerateVideoTool(
  deps: GenerateVideoToolDeps,
): AgentTool<typeof GenerateVideoParams, unknown> {
  const getConfigured = deps.getConfiguredVideoProviders ?? getServerVideoProviders;
  const resolveConfig = deps.resolveVideoProviderConfig ?? defaultResolveVideoProviderConfig;
  const callProvider = deps.generateConfiguredVideo ?? generateVideo;
  const persist = deps.persistGeneratedVideo ?? defaultPersistGeneratedVideo;

  return {
    name: GENERATE_VIDEO_TOOL_NAME,
    label: 'Generate video',
    description:
      'Start creating a new video from a prompt for the explicitly targeted course. Returns IMMEDIATELY with a placeholder ref (gen_vid_...): the video generates in the background (this can take minutes) and the page updates itself when it is ready. Right after this call, put the returned ref on a video element — patch_stage set mediaRef (or src) of an existing element, or add a new video element carrying it. Video elements also support autoplay and poster. Do not wait for the video and do not retry while a ref is pending. This tool never edits a page itself.',
    parameters: GenerateVideoParams,
    async execute(toolCallId, params: Static<typeof GenerateVideoParams>, signal) {
      const callerSignal = signal ?? deps.abortSignal;
      throwIfAborted(callerSignal);

      const prompt = params.prompt.trim();
      if (!prompt) return errorResult('Video generation failed: prompt must not be empty.');
      const stageId = params.stageId;

      const configured = getConfigured();
      const providerId = configuredProviderIds(configured).find((id) => {
        const provider = VIDEO_PROVIDERS[id];
        return !provider.requiresApiKey || !!resolveConfig(id).apiKey;
      });
      if (!providerId) {
        log.warn(`[${toolCallId}] Video generation unavailable: no enabled server video provider`);
        return errorResult(
          'Video generation is unavailable: no server video provider is available.',
          {
            stageId,
            sessionId: deps.sessionId,
            reason: MEDIA_TOOL_ERROR_REASONS.noProvider,
          },
        );
      }

      // Defense in depth: the operator force-off is authoritative at the call
      // boundary — even if a caller explicitly selects a disabled provider id,
      // the call fails before any provider I/O (#665).
      if (isServerProviderDisabled('video', providerId)) {
        log.warn(
          `[${toolCallId}] Video generation rejected: provider ${providerId} is force-disabled`,
        );
        return errorResult('Video generation is unavailable.', {
          stageId,
          reason: MEDIA_TOOL_ERROR_REASONS.providerDisabled,
        });
      }

      const providerConfig = resolveConfig(providerId);
      const model = providerConfig.model;
      // Same fail-loud discipline as generate_image: the server-side model
      // resolution is authoritative, and a provider that expects an explicit
      // model errors here instead of silently defaulting.
      if ((VIDEO_PROVIDERS[providerId]?.models?.length ?? 0) > 0 && !model) {
        log.warn(
          `[${toolCallId}] Video generation unavailable: no model configured for provider ${providerId}`,
        );
        return errorResult(
          'Video generation is unavailable: no model is configured for the selected video provider on this server.',
          {
            stageId,
            reason: MEDIA_TOOL_ERROR_REASONS.missingModel,
          },
        );
      }
      const normalized = normalizeVideoOptions(providerId, {
        prompt,
        ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
        ...(params.durationSec ? { duration: params.durationSec } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
        stageId,
      });

      // All validation passed: mint the placeholder (same `gen_vid_<id>`
      // scheme the outline flow uses), register the job, detach it, and
      // return. The provider cycle runs in the background; `media_ready`
      // reports the outcome and the background job patches the persisted page.
      const ref = `gen_vid_${nanoid(8)}`;
      registerPendingMedia({
        ref,
        type: 'video',
        stageId,
        ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
        provider: providerId,
      });
      void runVideoGenerationJob({
        toolCallId,
        ref,
        stageId,
        providerId,
        providerConfig,
        model,
        options: normalized,
        timeoutMs: deps.timeoutMs ?? GENERATE_VIDEO_TIMEOUT_MS,
        deps,
        callProvider,
        persist,
      }).catch((error) => {
        // runVideoGenerationJob handles every expected failure itself; this is
        // the last-resort guard against an unhandled rejection from a bug.
        // Keep the handler synchronous and only call never-rejecting helpers
        // (emitMediaReadyFrame catches internally): a throw here would become
        // the very unhandled rejection this guard exists to contain.
        log.error(`[${toolCallId}] Video generation job crashed for ${ref}`, error);
        settlePendingMedia(ref, {
          status: 'failed',
          errorCode: MEDIA_TOOL_ERROR_REASONS.generationFailed,
        });
        // A crashed job never lands in the document, so without this frame
        // the client would keep rendering the placeholder skeleton forever.
        void emitMediaReadyFrame(deps, toolCallId, {
          ref,
          stageId,
          status: 'failed',
          errorCode: MEDIA_TOOL_ERROR_REASONS.generationFailed,
        });
      });

      return {
        content: [
          {
            type: 'text',
            text: `Video generation started in the background (ref=${ref}). Patch this ref onto a video element's mediaRef (or src) with patch_stage NOW so the page shows a placeholder; the element updates automatically when the video is ready (a media_ready event reports the outcome). Do not block on it.`,
          },
        ],
        details: {
          ref,
          stageId,
          status: 'generating',
        },
      };
    },
  };
}
