/**
 * What a run's steps call: the shared step functions, with what their API
 * routes resolve for them (the owner's slot models, the web-search and tts
 * connections, the material bytes) resolved for the run's owner instead.
 *
 * The engine depends on this interface only, so a test runs the engine with
 * its own step outputs and checks the inputs each step received.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';
import type { MediaGenerationRequest } from '@/lib/media/types';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { resolveOwnedAsset } from '@/lib/persistence/resolve-server-asset';
import type { VisionPromptImage } from '@/lib/persistence/resolve-vision-images';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  DownloadByteBudget,
  MAX_REMOTE_IMAGE_BATCH_BYTES,
  MAX_REMOTE_IMAGE_BYTES,
  readResponseBodyWithLimit,
} from '@/lib/server/bounded-download';
import { MAX_GENERATED_VIDEO_BYTES } from '@/lib/server/agent-runtime/generate-video';
import { generateImageStep } from '@/lib/server/generation/steps/image';
import { generateVideoStep, type VideoProviderTask } from '@/lib/server/generation/steps/video';
import { decodeDataUrl, fetchProviderResultUrl } from '@/lib/server/provider-result-fetch';
import type { PdfImage } from '@/lib/types/generation';

import { TTS_PROVIDERS } from '@/lib/audio/constants';
import type { BuiltInTTSProviderId, TTSProviderId } from '@/lib/audio/types';
import { buildDocumentBundle, type ParsedDocumentPart } from '@/lib/document/bundle';
import { normalizeDocumentMimeType } from '@/lib/document/mime';
import { resolveAgentsForOwner } from '@/lib/server/agents/registry';
import { resolveClassroomMaterials } from '@/lib/server/classroom-materials';
import { classroomMediaMimeType } from '@/lib/server/classroom-storage';
import { resolveServerGenerationCapabilities } from '@/lib/server/generation-capabilities';
import {
  generateAgentProfiles,
  type AgentProfilesInput,
  type GeneratedAgentProfile,
} from '@/lib/server/generation/steps/agent-profiles';
import type { StepContext, VisionImageResolver } from '@/lib/server/generation/steps/context';
import { analyzeMaterial } from '@/lib/server/generation/steps/material-analysis';
import { synthesizeNarration } from '@/lib/server/generation/steps/narration';
import {
  generateOutlines,
  type OutlineEvent,
  type OutlineInput,
  type OutlineResult,
} from '@/lib/server/generation/steps/outline';
import { research, type ResearchResult } from '@/lib/server/generation/steps/research';
import {
  generateSceneActions,
  type SceneActionsInput,
  type SceneActionsResult,
} from '@/lib/server/generation/steps/scene-actions';
import {
  generateSceneContent,
  type SceneContentInput,
  type SceneContentResult,
} from '@/lib/server/generation/steps/scene-content';
import { resolveExtractionServices } from '@/lib/server/material-extraction/services';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';
import {
  resolveMediaSlot,
  WorkspaceEndpointError,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import { InvalidOwnerCredentialError } from '@/lib/server/identity/resolve';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { LLM_STAGES, type LlmStage } from '@/lib/server/model-routes';
import { getParallelSceneConcurrency } from '@/lib/server/provider-config';
import { resolveModel, type ResolvedModel } from '@/lib/server/resolve-model';
import { storeGeneratedAsset } from '@/lib/server/store-generated-asset';
import { DEFAULT_WEB_SEARCH_PROVIDER_ID } from '@/lib/web-search/constants';
import { resolveWebSearchConnection } from '@/lib/server/web-search-config';

import { ownerAssetExists } from './media';
import type { RunNarrationTarget } from './narration-voice';

export interface NarrateClipInput {
  target: RunNarrationTarget;
  stageId: string;
  text: string;
  /** The request label (`tts_s<order>_<actionId>`); the stored clip gets an allocated id. */
  audioId: string;
  voice: string;
  speed: number;
  /** The voice's provider options (a VoxCPM voice prompt, say). */
  providerOptions?: Record<string, unknown>;
  /** The run's lease check, on the clip's asset allocation. */
  fence: (tx: Queryable) => Promise<void>;
}

/** Generated or extracted bytes and their media type. */
export interface RunMediaBytes {
  bytes: Uint8Array;
  mimeType: string;
}

/** One image of the owner's materials, as the document bundle numbers it, with its bytes. */
export type RunMaterialImage = Omit<PdfImage, 'src' | 'storageId' | 'assetId'> & RunMediaBytes;

export interface AnalyzedMaterials {
  /** The bundle's text: the outline's source text. */
  text: string;
  /** The bundle's images, in its order (the engine stores them as course assets). */
  images: RunMaterialImage[];
}

/**
 * One media slot as the media pass reads it: a connection, `off` (turned off
 * or unassigned: the kind is not generated), or `refused` with what the
 * browser's generation route answers for it (an endpoint or a credential it
 * refuses), which each item of the kind fails with.
 */
export type RunMediaSlot =
  | { status: 'ready'; connection: MediaConnection }
  | { status: 'off' }
  | { status: 'refused'; message: string; errorCode: string };

export interface RunMediaConnections {
  image: RunMediaSlot;
  video: RunMediaSlot;
}

export interface GenerateRunImageInput {
  request: MediaGenerationRequest;
  stageId: string;
  connection: MediaConnection;
}

export interface GenerateRunVideoInput {
  request: MediaGenerationRequest;
  connection: MediaConnection;
  /** Wait on this task (submitted before a takeover) instead of submitting one. */
  resume?: VideoProviderTask;
  /** Told the provider task once it is submitted, before the wait. */
  onProviderTask: (task: VideoProviderTask) => Promise<void>;
}

export interface RunStepServices {
  /** Extract and bundle the owner's materials: the outline's source text and the images. */
  analyzeMaterials(
    ownerId: string,
    materialIds: string[],
    ctx: StepContext,
  ): Promise<AnalyzedMaterials>;
  /** Research the requirement; null when the webSearch slot resolves to nothing. */
  research(
    ownerId: string,
    input: { query: string; pdfText?: string },
    ctx: StepContext,
  ): Promise<ResearchResult | null>;
  outline(
    ownerId: string,
    input: Omit<OutlineInput, 'model'>,
    ctx: StepContext<OutlineEvent>,
  ): Promise<OutlineResult>;
  agentProfiles(
    ownerId: string,
    input: Omit<AgentProfilesInput, 'model'>,
    ctx: StepContext,
  ): Promise<GeneratedAgentProfile[]>;
  presetAgents(ownerId: string, agentIds: readonly string[]): Promise<AgentConfig[]>;
  sceneContent(
    ownerId: string,
    input: Omit<SceneContentInput, 'model'>,
    ctx: StepContext,
  ): Promise<SceneContentResult>;
  sceneActions(
    ownerId: string,
    input: Omit<SceneActionsInput, 'model'>,
    ctx: StepContext,
  ): Promise<SceneActionsResult>;
  /** The tts slot when it narrates on the server; null when it is off or browser speech. */
  narrationTarget(ownerId: string): Promise<RunNarrationTarget | null>;
  /** Synthesize and store one clip; its asset id, or null when the asset store had no room. */
  narrateClip(ownerId: string, input: NarrateClipInput, ctx: StepContext): Promise<string | null>;
  /** Release allocations no commit names (a narration attempt's clips, unused material images). */
  releaseAssets(ownerId: string, assetIds: readonly string[], ctx: StepContext): Promise<void>;
  /** The slots the media pass generates with, read once per pass. */
  mediaConnections(ownerId: string): Promise<RunMediaConnections>;
  /** Generate one image and download its bytes. */
  generateImage(
    ownerId: string,
    input: GenerateRunImageInput,
    ctx: StepContext,
  ): Promise<RunMediaBytes>;
  /** Generate (or resume waiting on) one video, and download it and its poster. */
  generateVideo(
    ownerId: string,
    input: GenerateRunVideoInput,
    ctx: StepContext,
  ): Promise<{ video: RunMediaBytes; poster?: RunMediaBytes }>;
  /** How many scenes (and clips) may generate at once; 0 or 1 is serial. */
  parallelSceneConcurrency(): number;
  /** The wait between retries. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * The media type of a narration clip in `format`: the classroom media types
 * that are audio, and the containers that are audio when TTS returns them
 * (webm), which the shared map types as video. Undefined for any other.
 */
function narrationMimeType(format: string): string | undefined {
  if (format.toLowerCase() === 'webm') return 'audio/webm';
  const mimeType = classroomMediaMimeType(`.${format}`);
  return mimeType?.startsWith('audio/') ? mimeType : undefined;
}

/** The model of `stage` for the owner the run works for now (a claim may have moved it). */
async function stageModel(ownerId: string, stage: LlmStage): Promise<ResolvedModel> {
  return resolveModel({ stage, workspaceId: await backgroundWorkspaceId(ownerId) });
}

/**
 * Vision images for the owner the run works for: the material images are
 * course assets, resolved to data URLs for the prompt. The run keeps them
 * alive until it ends, so one that is gone is a fault, and the step fails
 * loud instead of generating without it; one over the size limit is dropped,
 * as the routes drop it.
 */
function ownerVisionImages(ownerId: string, log: StepContext['log']): VisionImageResolver {
  return async (images) => {
    const resolved: VisionPromptImage[] = [];
    for (const image of images) {
      if (!image.src) continue;
      if (/^(?:data:|https?:)/i.test(image.src)) {
        resolved.push(image);
        continue;
      }
      const resolution = await resolveOwnedAsset(
        image.src,
        ownerId,
        process.env.DATABASE_URL ?? '',
        MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES,
      );
      if (resolution.status === 'missing') throw new MaterialImageMissingError(image.id);
      if (resolution.status !== 'resolved') {
        log.warn(`Vision image "${image.id}" does not resolve (${resolution.status}); dropping it`);
        continue;
      }
      resolved.push({
        id: image.id,
        src: `data:${resolution.mimeType};base64,${resolution.buffer.toString('base64')}`,
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
      });
    }
    return resolved;
  };
}

/** The media type of downloaded bytes: what the response declares, else `fallback`. */
function declaredType(response: Response, fallback: string): string {
  const declared = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  return declared && declared !== 'application/octet-stream' ? declared : fallback;
}

/** Download a provider's result URL (or decode its data URL) under a byte limit. */
async function downloadResult(
  url: string,
  options: {
    maxBytes: number;
    fallbackType: string;
    signal?: AbortSignal;
    budget?: DownloadByteBudget;
  },
): Promise<RunMediaBytes> {
  if (url.startsWith('data:')) {
    const decoded = decodeDataUrl(url, options.maxBytes);
    return {
      bytes: decoded.bytes,
      mimeType:
        decoded.mimeType && decoded.mimeType !== 'application/octet-stream'
          ? decoded.mimeType
          : options.fallbackType,
    };
  }
  const response = await fetchProviderResultUrl(url, {
    maxBytes: options.maxBytes,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const mimeType = declaredType(response, options.fallbackType);
  const bytes = await readResponseBodyWithLimit(response, {
    maxBytes: options.maxBytes,
    ...(options.budget ? { aggregateBudget: options.budget } : {}),
  });
  return { bytes, mimeType };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const defaultRunStepServices: RunStepServices = {
  async analyzeMaterials(ownerId, materialIds, ctx) {
    const records = await resolveClassroomMaterials(ownerId, materialIds);
    const workspaceId = await backgroundWorkspaceId(ownerId);
    const services = await resolveExtractionServices(workspaceId);
    const byteStore = getMaterialByteStore();
    const parts: ParsedDocumentPart[] = [];
    for (const [order, record] of records.entries()) {
      const fileName = record.originalName ?? record.id;
      const buffer = await byteStore.get(record.ossKey);
      const parsed = await analyzeMaterial(
        {
          source: {
            fileName,
            fileSize: record.bytes,
            mimeType: normalizeDocumentMimeType({ mimeType: record.mime, fileName }),
            buffer,
          },
          services,
          request: {},
          redactCallerInput: false,
        },
        ctx,
      );
      parts.push({
        source: {
          id: record.id,
          name: fileName,
          size: record.bytes,
          ...(record.mime ? { mimeType: record.mime } : {}),
          order,
        },
        text: parsed.text,
        rawTextLength: parsed.text.length,
        ...(parsed.metadata?.pageCount !== undefined
          ? { pageCount: parsed.metadata.pageCount }
          : {}),
        // The images as the generation preview reads them off the
        // extraction: the extractor's own list, else its bare data URLs.
        images: parsed.metadata?.pdfImages
          ? parsed.metadata.pdfImages.map((image) => ({
              id: image.id,
              src: image.src || '',
              pageNumber: image.pageNumber ?? 1,
              description: image.description,
              width: image.width,
              height: image.height,
            }))
          : (parsed.images ?? []).map((src, index) => ({
              id: `img_${index + 1}`,
              src,
              pageNumber: 1,
            })),
      });
    }
    const bundle = buildDocumentBundle(parts);
    return {
      text: bundle.text,
      images: bundle.images.map(({ src, ...image }) => {
        // The browser stores every image's bytes or fails the analysis.
        if (!src.startsWith('data:')) {
          throw new Error(`Material image ${image.id} has no inline bytes`);
        }
        const decoded = decodeDataUrl(src, MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES);
        return {
          ...image,
          bytes: decoded.bytes,
          mimeType:
            decoded.mimeType && decoded.mimeType.startsWith('image/')
              ? decoded.mimeType
              : 'image/png',
        };
      }),
    };
  },

  async research(ownerId, input, ctx) {
    const workspaceId = await backgroundWorkspaceId(ownerId);
    const capabilities = await resolveServerGenerationCapabilities(workspaceId);
    if (!capabilities.webSearch) return null;
    const config = await resolveWebSearchConnection(
      workspaceId,
      {},
      {
        refuseDisabled: true,
        preferServerProvider: true,
        fallbackProviderId: DEFAULT_WEB_SEARCH_PROVIDER_ID,
      },
    );
    let rewriteModel: ResolvedModel | undefined;
    try {
      rewriteModel = await stageModel(ownerId, 'web-search-query-rewrite');
    } catch (error) {
      ctx.log.warn(
        'Search query rewrite model unavailable, falling back to raw requirement:',
        error,
      );
    }
    return research({ ...input, config, rewriteModel }, ctx);
  },

  async outline(ownerId, input, ctx) {
    return generateOutlines(
      { ...input, model: await stageModel(ownerId, 'scene-outlines-stream') },
      {
        ...ctx,
        workspaceId: await backgroundWorkspaceId(ownerId),
        resolveVisionImages: ownerVisionImages(ownerId, ctx.log),
      },
    );
  },

  async agentProfiles(ownerId, input, ctx) {
    return generateAgentProfiles(
      { ...input, model: await stageModel(ownerId, 'agent-profiles') },
      ctx,
    );
  },

  presetAgents: resolveAgentsForOwner,

  async sceneContent(ownerId, input, ctx) {
    // A type with a content slot of its own resolves through it; any other
    // (a type no content path supports) through plain course.content, so it
    // reaches the content step's own refusal.
    const typed = `scene-content:${input.outline.type}`;
    const stage = (LLM_STAGES as readonly string[]).includes(typed)
      ? (typed as LlmStage)
      : 'scene-content';
    return generateSceneContent(
      {
        ...input,
        ...(input.imageMapping
          ? { imageMapping: await storedImageMapping(ownerId, input.outline, input.imageMapping) }
          : {}),
        model: await stageModel(ownerId, stage),
      },
      { ...ctx, resolveVisionImages: ownerVisionImages(ownerId, ctx.log) },
    );
  },

  async sceneActions(ownerId, input, ctx) {
    return generateSceneActions(
      { ...input, model: await stageModel(ownerId, 'scene-actions') },
      ctx,
    );
  },

  async narrationTarget(ownerId) {
    let connection;
    try {
      connection = await resolveMediaSlot('tts', {
        workspaceId: await backgroundWorkspaceId(ownerId),
      });
    } catch (error) {
      if (error instanceof SlotDisabledError || error instanceof SlotUnassignedError) return null;
      throw error;
    }
    if (connection.providerId === 'browser-native-tts') return null;
    const providerId = connection.providerId as TTSProviderId;
    const modelId =
      connection.modelId ||
      TTS_PROVIDERS[providerId as BuiltInTTSProviderId]?.defaultModelId ||
      undefined;
    return { connection, providerId, ...(modelId ? { modelId } : {}) };
  },

  async narrateClip(ownerId, input, ctx) {
    const narration = await synthesizeNarration(
      {
        text: input.text,
        audioId: input.audioId,
        connection: input.target.connection,
        requestedVoice: input.voice,
        speed: input.speed,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      },
      ctx,
    );
    // The clip's real media type (mp3 is audio/mpeg), so it is served inline.
    const mimeType = narrationMimeType(narration.format);
    if (!mimeType) {
      throw new Error(`The TTS provider returned audio in an unknown format: ${narration.format}`);
    }
    const stored = await storeGeneratedAsset({
      ownerId,
      stageId: input.stageId,
      bytes: narration.audio,
      mimeType,
      kind: 'audio',
      fence: input.fence,
    });
    if (stored.status === 'refused') {
      // A clip the store has no room for leaves its line unvoiced, as the
      // browser does when storing narration fails; the scene goes on.
      ctx.log.warn(`Asset storage is full; leaving ${input.audioId} unvoiced`);
      return null;
    }
    return stored.assetId;
  },

  async releaseAssets(ownerId, assetIds, ctx) {
    if (assetIds.length === 0) return;
    const { assetStore } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    for (const assetId of assetIds) {
      try {
        await assetStore.releasePending(assetPrincipalForOwner(ownerId), assetId);
      } catch (error) {
        // Still pending: the collector reclaims it once its deadline passes.
        ctx.log.warn(`Could not release asset ${assetId}:`, error);
      }
    }
  },

  async mediaConnections(ownerId) {
    const workspaceId = await backgroundWorkspaceId(ownerId);
    // As the generation routes map a resolution failure
    // (`mediaResolutionResponse`); anything else is a fault, not an answer.
    const slot = async (kind: 'image' | 'video'): Promise<RunMediaSlot> => {
      try {
        return { status: 'ready', connection: await resolveMediaSlot(kind, { workspaceId }) };
      } catch (error) {
        if (error instanceof SlotDisabledError || error instanceof SlotUnassignedError) {
          return { status: 'off' };
        }
        if (error instanceof WorkspaceEndpointError) {
          return { status: 'refused', message: error.message, errorCode: 'INVALID_URL' };
        }
        if (error instanceof InvalidOwnerCredentialError) {
          return { status: 'refused', message: 'invalid owner credential', errorCode: error.code };
        }
        throw error;
      }
    };
    const [image, video] = await Promise.all([slot('image'), slot('video')]);
    return { image, video };
  },

  async generateImage(_ownerId, input, ctx) {
    // What the browser's media pass sends POST /api/generate/image.
    const result = await generateImageStep(
      {
        options: {
          prompt: input.request.prompt,
          ...(input.request.aspectRatio ? { aspectRatio: input.request.aspectRatio } : {}),
          ...(input.request.style ? { style: input.request.style } : {}),
          stageId: input.stageId,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
        connection: input.connection,
      },
      ctx,
    );
    if (result.base64) {
      const bytes = Buffer.from(result.base64, 'base64');
      if (bytes.byteLength === 0) throw new Error('The image provider returned empty image data');
      if (bytes.byteLength > MAX_REMOTE_IMAGE_BYTES) {
        throw new Error(`The generated image exceeds the ${MAX_REMOTE_IMAGE_BYTES}-byte limit`);
      }
      return { bytes, mimeType: result.mimeType || 'image/png' };
    }
    if (!result.url) throw new Error('No image URL in response');
    return downloadResult(result.url, {
      maxBytes: MAX_REMOTE_IMAGE_BYTES,
      fallbackType: 'image/png',
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  },

  async generateVideo(_ownerId, input, ctx) {
    // What the browser's media pass sends POST /api/generate/video.
    const result = await generateVideoStep(
      {
        options: {
          prompt: input.request.prompt,
          ...(input.request.aspectRatio ? { aspectRatio: input.request.aspectRatio } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
        connection: input.connection,
        onProviderTask: input.onProviderTask,
        ...(input.resume ? { resume: input.resume } : {}),
      },
      ctx,
    );
    if (!result.url) throw new Error('No video URL in response');
    const video = await downloadResult(result.url, {
      maxBytes: MAX_GENERATED_VIDEO_BYTES,
      fallbackType: 'video/mp4',
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    // A poster that cannot be fetched costs the poster only.
    const poster = result.poster
      ? await downloadResult(result.poster, {
          maxBytes: MAX_REMOTE_IMAGE_BYTES,
          fallbackType: 'image/jpeg',
          budget: new DownloadByteBudget(MAX_REMOTE_IMAGE_BATCH_BYTES),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        }).catch((error) => {
          ctx.log.warn('The video poster could not be downloaded:', error);
          return undefined;
        })
      : undefined;
    return { video, ...(poster ? { poster } : {}) };
  },

  parallelSceneConcurrency: getParallelSceneConcurrency,
  sleep,
};

/** A material image the run stored is no longer in the owner's pool. */
export class MaterialImageMissingError extends Error {
  constructor(imageId: string) {
    super(`The material image ${imageId} is no longer stored`);
    this.name = 'MaterialImageMissingError';
  }
}

/**
 * The image mapping, once the images the outline is assigned are known to be
 * stored: an image element must never name bytes that are gone, and the run
 * keeps its material images alive, so a missing one fails the step.
 */
async function storedImageMapping(
  ownerId: string,
  outline: { suggestedImageIds?: string[] },
  imageMapping: Record<string, string>,
): Promise<Record<string, string>> {
  for (const imageId of outline.suggestedImageIds ?? []) {
    const assetId = imageMapping[imageId];
    if (assetId && !(await ownerAssetExists(ownerId, assetId))) {
      throw new MaterialImageMissingError(imageId);
    }
  }
  return imageMapping;
}
