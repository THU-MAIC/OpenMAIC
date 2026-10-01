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
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

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
import type { StepContext } from '@/lib/server/generation/steps/context';
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
import { resolveMediaSlot } from '@/lib/server/model-config/media';
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

export interface RunStepServices {
  /** Extract and bundle the owner's materials into the outline's source text. */
  analyzeMaterials(ownerId: string, materialIds: string[], ctx: StepContext): Promise<string>;
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
  /** Release clips allocated for a narration attempt that did not commit. */
  releaseClips(ownerId: string, assetIds: readonly string[], ctx: StepContext): Promise<void>;
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

/** Vision images are material images, which runs attach from their own assets (not yet). */
const noVisionImages = async () => [];

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
        // Material images are stored as course assets in a later step of
        // this design; until then the run generates from the text.
        images: [],
      });
    }
    return buildDocumentBundle(parts).text;
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
        resolveVisionImages: noVisionImages,
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
      { ...input, model: await stageModel(ownerId, stage) },
      { ...ctx, resolveVisionImages: noVisionImages },
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

  async releaseClips(ownerId, assetIds, ctx) {
    if (assetIds.length === 0) return;
    const { assetStore } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    for (const assetId of assetIds) {
      try {
        await assetStore.releasePending(assetPrincipalForOwner(ownerId), assetId);
      } catch (error) {
        // Still pending: the collector reclaims it once its deadline passes.
        ctx.log.warn(`Could not release narration asset ${assetId}:`, error);
      }
    }
  },

  parallelSceneConcurrency: getParallelSceneConcurrency,
  sleep,
};
