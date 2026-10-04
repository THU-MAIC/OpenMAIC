import { callLLM } from '@/lib/ai/llm';
import { backgroundWorkspaceId } from '@/lib/server/model-config/runtime';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
  generateSceneActions,
  generateSceneContent,
  isAbortError,
  PBLGenerationError,
  withGenerationRetry,
  type AICallFn,
  type AgentInfo,
} from '@openmaic/generation';
import { createSceneWithActions } from '@/lib/server/scene-generation';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { resolveServerGenerationCapabilities } from '@/lib/server/generation-capabilities';
import { loadClassroomMaterialText } from '@/lib/server/classroom-materials';
import { resolveModel } from '@/lib/server/resolve-model';
import type { LlmStage } from '@/lib/server/model-routes';
import type { LanguageModel } from 'ai';
import type { ThinkingConfig } from '@/lib/types/provider';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import { generateClassroomId, saveGeneratedClassroom } from '@/lib/server/classroom-persistence';
import {
  classroomTtsSummary,
  countNarratableSpeechActions,
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
  type ClassroomTtsCoverage,
} from '@/lib/server/classroom-media-generation';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import type { UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';

const log = createLogger('Classroom');

export function containPBLGenerationError(error: unknown, sceneTitle: string): null {
  if (!(error instanceof PBLGenerationError)) throw error;
  log.warn(`PBL generation failed for scene "${sceneTitle}": ${error.message}`);
  return null;
}

/**
 * The generation request. Optional capabilities (web search, image and video
 * generation, TTS) are not request fields: they follow the server's provider
 * configuration (`resolveServerGenerationCapabilities`).
 */
export interface GenerateClassroomInput {
  requirement: string;
  /** Owner-library uploads (`POST /api/materials`) to generate from, in order. */
  materialIds?: string[];
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
  /**
   * Present when TTS ran (the server has a TTS provider). Omitted otherwise.
   * `written` is 0 when synthesis saved no clips.
   */
  ttsCoverage?: ClassroomTtsCoverage;
  /**
   * Set when narration is incomplete (`written` < `total`) or the TTS phase failed.
   * A TTS run with no narratable speech (`total` 0) has coverage and no warning.
   */
  warning?: string;
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

async function generateAgentProfiles(
  requirement: string,
  languageDirective: string,
  aiCall: AICallFn,
): Promise<AgentInfo[]> {
  const systemPrompt =
    'You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Return ONLY valid JSON, no markdown or explanation.';

  const userPrompt = `Generate agent profiles for a course with this requirement:
${requirement}

Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Language directive for this course: ${languageDirective}
  Agent names and personas must follow this language directive.

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)"
    }
  ]
}`;

  const response = await aiCall(systemPrompt, userPrompt);
  const rawText = stripCodeFences(response);
  const parsed = JSON.parse(rawText) as {
    agents: Array<{ name: string; role: string; persona: string }>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((a, i) => ({
    id: `gen-server-${i}`,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

const TTS_PHASE_FAILED_WARNING = 'TTS generation phase failed';
const ASSET_STORAGE_FULL_WARNING = 'Asset storage is full; stopped storing';

function classroomTtsHeartbeatProgress(written: number, total: number): number {
  if (total <= 0) return 94;
  const ratio = Math.min(1, Math.max(0, written / total));
  return 94 + Math.floor(ratio * 3);
}

function ttsResultWarning(
  coverage: ClassroomTtsCoverage | undefined,
  fallback?: string,
): string | undefined {
  if (coverage && coverage.written < coverage.total) {
    return classroomTtsSummary(coverage.written, coverage.total);
  }
  return fallback;
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    /**
     * The request owner: `materialIds` resolve against this owner's library,
     * its media are allocated in this owner's asset partition, and the
     * finished course is saved into this owner's library.
     */
    ownerId: string;
    signal?: AbortSignal;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  },
): Promise<GenerateClassroomResult> {
  const { requirement } = input;
  const capabilities = await resolveServerGenerationCapabilities(
    await backgroundWorkspaceId(options.ownerId),
  );

  await options.onProgress?.({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  // Every stage resolves through its capability slot for this owner: what the
  // owner's settings or openmaic.yml assign, else the deployment's defaults. A
  // slot without a model of its own inherits its parent's, so a deployment
  // with one default model uses it throughout, as the browser UI does through
  // /api/generate/*. Outlines resolve through course.outline like the UI's.

  interface StageModel {
    model: LanguageModel;
    outputWindow?: number;
    thinking: ThinkingConfig | undefined;
    serverManaged: boolean;
    modelString: string;
  }
  const stageModels = new Map<LlmStage, Promise<StageModel>>();
  const resolveStageModel = (stage: LlmStage): Promise<StageModel> => {
    let pending = stageModels.get(stage);
    if (!pending) {
      // The owner the job works for now, per stage: a claim during the job
      // moves the settings, and later stages follow them.
      pending = backgroundWorkspaceId(options.ownerId)
        .then((workspaceId) => resolveModel({ stage, workspaceId }))
        .then((resolved) => {
          if (isProviderKeyRequired(resolved.providerId) && !resolved.apiKey) {
            throw new Error(
              `No API key configured for the ${stage} model (provider "${resolved.providerId}").`,
            );
          }
          return {
            model: resolved.model,
            outputWindow: resolved.modelInfo?.outputWindow,
            thinking: resolved.thinkingConfig,
            serverManaged: resolved.serverManaged,
            modelString: resolved.modelString,
          };
        });
      stageModels.set(stage, pending);
    }
    return pending;
  };
  /**
   * An AICallFn on `stage`'s model, logged under `source` (the labels this
   * path has always used). Scene calls leave retries to the scene loop.
   */
  const stageAiCall =
    (
      stage: LlmStage,
      source: string,
      { maxOutputTokens, sceneRetries }: { maxOutputTokens?: number; sceneRetries?: boolean } = {},
    ): AICallFn =>
    async (systemPrompt, userPrompt, _images) => {
      const { model, outputWindow, thinking, serverManaged } = await resolveStageModel(stage);
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: maxOutputTokens ?? outputWindow,
          ...(sceneRetries ? { maxRetries: 0 } : {}),
        },
        source,
        undefined,
        thinking,
        { serverManaged },
      );
      return result.text;
    };

  // Fail fast, before any other work, when the first model cannot be built.
  const outlineModel = await resolveStageModel('scene-outlines-stream');
  log.info(`Outline model: ${outlineModel.modelString}`);
  const outlineAiCall = stageAiCall('scene-outlines-stream', 'generate-classroom');
  const searchQueryAiCall = stageAiCall('web-search-query-rewrite', 'web-search-query-rewrite', {
    maxOutputTokens: 256,
  });

  // scene-content resolves per outline type (course.content.<type>, which
  // inherits course.content). Returns the aiCall plus the resolved model and
  // thinking config, because PBL scene generation drives its own LLM calls
  // through the model object (generatePBLSceneContent) rather than the aiCall
  // closure.
  const resolveSceneContentCall = async (outlineType?: string) => {
    const stage = (outlineType ? `scene-content:${outlineType}` : 'scene-content') as LlmStage;
    const { model, thinking } = await resolveStageModel(stage);
    return {
      aiCall: stageAiCall(stage, 'generate-classroom-scene', { sceneRetries: true }),
      model,
      thinking,
    };
  };
  const agentProfilesCall = stageAiCall('agent-profiles', 'generate-classroom');
  const sceneActionsCall = stageAiCall('scene-actions', 'generate-classroom-scene', {
    sceneRetries: true,
  });

  const requirements: UserRequirements = {
    requirement,
  };
  const vocationalActive = resolveVocationalActive(requirements);

  let pdfText: string | undefined;
  if (input.materialIds?.length) {
    await options.onProgress?.({
      step: 'initializing',
      progress: 7,
      message: `Extracting ${input.materialIds.length} uploaded material(s)`,
      scenesGenerated: 0,
    });
    pdfText = await loadClassroomMaterialText(options.ownerId, input.materialIds);
  }

  await options.onProgress?.({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (capabilities.webSearch) {
    // The server's default provider; requests carry no provider choice or key.
    const webSearchConfig = await resolveClassroomWebSearchConfig(
      await backgroundWorkspaceId(options.ownerId),
    );
    if (webSearchConfig) {
      // A rewrite that fails (its model included) skips the search context below.
      try {
        const searchQuery = await buildSearchQuery(requirement, pdfText, searchQueryAiCall);

        log.info('Running web search for classroom generation', {
          hasPdfContext: searchQuery.hasPdfContext,
          rawRequirementLength: searchQuery.rawRequirementLength,
          rewriteAttempted: searchQuery.rewriteAttempted,
          finalQueryLength: searchQuery.finalQueryLength,
        });

        const searchResult = await searchWeb({
          providerId: webSearchConfig.providerId,
          query: searchQuery.query,
          apiKey: webSearchConfig.apiKey,
          baseUrl: webSearchConfig.baseUrl,
          baiduSubSources: webSearchConfig.baiduSubSources,
          claudeModelId: webSearchConfig.claudeModelId,
        });
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        log.warn('Web search failed, continuing without search context:', e);
      }
    } else {
      log.warn('No usable web search provider configuration, skipping web search');
    }
  }

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 15,
    message: 'Generating scene outlines',
    scenesGenerated: 0,
  });

  const outlinesResult = await generateSceneOutlinesFromRequirements(
    requirements,
    pdfText,
    undefined,
    outlineAiCall,
    {
      imageGenerationEnabled: capabilities.imageGeneration,
      videoGenerationEnabled: capabilities.videoGeneration,
      researchContext,
      // NO teacherContext — agents haven't been generated yet
    },
  );

  if (!outlinesResult.success || !outlinesResult.data) {
    log.error('Failed to generate outlines:', outlinesResult.error);
    throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
  }

  const { languageDirective, courseTitle, outlines } = outlinesResult.data;
  log.info(
    `Generated ${outlines.length} scene outlines (languageDirective: ${languageDirective}, courseTitle: ${courseTitle ?? 'n/a'})`,
  );

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  // Generate course-specific agent profiles, the default a fresh browser
  // install uses (settings `agentMode: 'auto'`). Runs AFTER outlines so it can
  // follow languageDirective; a failure falls back to the built-in agents.
  let agents: AgentInfo[];
  let agentsGenerated = false;
  log.info('Generating custom agent profiles via LLM...');
  try {
    agents = await generateAgentProfiles(requirement, languageDirective, agentProfilesCall);
    agentsGenerated = true;
    log.info(`Generated ${agents.length} agent profiles`);
  } catch (e) {
    log.warn('Agent profile generation failed, falling back to defaults:', e);
    agents = getDefaultAgents();
  }

  // The id is only a name until the finished course is saved: nothing is
  // written under it before then, so there is nothing to reserve or release.
  const stageId = generateClassroomId();
  const stage: Stage = {
    id: stageId,
    name: courseTitle || outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    languageDirective,
    videoManifest: buildVideoManifestFromOutlines(outlines),
    style: 'interactive',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // For LLM-generated agents, embed full configs so the client can
    // hydrate the agent registry from the document alone.
    // For default agents, just record IDs — the client already has them.
    ...(agentsGenerated
      ? {
          generatedAgentConfigs: agents.map((a, i) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            persona: a.persona || '',
            avatar: AGENT_DEFAULT_AVATARS[i % AGENT_DEFAULT_AVATARS.length],
            color: AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length],
            priority: a.role === 'teacher' ? 10 : a.role === 'assistant' ? 7 : 5,
          })),
        }
      : {
          agentIds: agents.map((a) => a.id),
        }),
  };

  // Scoped so the in-memory scene store does not outlive the pipeline.
  {
    const store = createInMemoryStore(stage);
    const api = createStageAPI(store);

    log.info('Stage 2: Generating scene content and actions...');
    let generatedScenes = 0;

    for (const [index, outline] of outlines.entries()) {
      const safeOutline = applyOutlineFallbacks(outline, true, {
        allowProceduralSkill: vocationalActive,
      });
      const progressStart = 30 + Math.floor((index / Math.max(outlines.length, 1)) * 60);

      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.max(progressStart, 31),
        message: `Generating scene ${index + 1}/${outlines.length}: ${safeOutline.title}`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });

      const reportSceneRetry = async (
        phase: 'content' | 'actions',
        event: { attempt: number; maxAttempts: number; reason: string },
      ) => {
        const nextAttempt = Math.min(event.attempt + 1, event.maxAttempts);
        const message = `Retrying scene ${index + 1}/${outlines.length} ${phase} (${nextAttempt}/${event.maxAttempts}): ${safeOutline.title}`;
        log.warn(`${message} — ${event.reason}`);
        await options.onProgress?.({
          step: 'generating_scenes',
          progress: Math.max(progressStart, 31),
          message,
          scenesGenerated: generatedScenes,
          totalScenes: outlines.length,
        });
      };

      // Resolve this scene's content model lazily, per outline type. The package
      // gets the provider-bound AICallFn and the app injects its agentic PBL loop
      // as the classified fallback, preserving single-call → loop routing.
      const contentCall = await resolveSceneContentCall(safeOutline.type);
      const content = await (async () => {
        try {
          return await withGenerationRetry(
            () =>
              generateSceneContent(safeOutline, contentCall.aiCall, {
                agents,
                languageDirective,
                allowProceduralSkill: vocationalActive,
                ...(safeOutline.type === 'pbl'
                  ? {
                      pblLoopFallback: (input) =>
                        generatePBLV2Project(
                          input,
                          contentCall.model,
                          callLLM,
                          { logger: log },
                          contentCall.thinking,
                        ),
                    }
                  : {}),
              }),
            {
              label: `scene ${index + 1}/${outlines.length} content`,
              shouldRetryResult: (result) => result === null,
              onRetry: (event) => reportSceneRetry('content', event),
            },
          );
        } catch (error) {
          return containPBLGenerationError(error, safeOutline.title);
        }
      })();
      if (!content) {
        log.warn(`Skipping scene "${safeOutline.title}" — content generation failed`);
        continue;
      }

      const actionsAiCall = sceneActionsCall;
      const actions = await withGenerationRetry(
        () =>
          generateSceneActions(safeOutline, content, actionsAiCall, {
            agents,
            languageDirective,
          }),
        {
          label: `scene ${index + 1}/${outlines.length} actions`,
          onRetry: (event) => reportSceneRetry('actions', event),
        },
      );
      log.info(`Scene "${safeOutline.title}": ${actions.length} actions`);

      const sceneId = createSceneWithActions(safeOutline, content, actions, api);
      if (!sceneId) {
        log.warn(`Skipping scene "${safeOutline.title}" — scene creation failed`);
        continue;
      }

      generatedScenes += 1;
      const progressEnd = 30 + Math.floor(((index + 1) / Math.max(outlines.length, 1)) * 60);
      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.min(progressEnd, 90),
        message: `Generated ${generatedScenes}/${outlines.length} scenes`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });
    }

    const scenes = store.getState().scenes;
    log.info(`Pipeline complete: ${scenes.length} scenes generated`);

    if (scenes.length === 0) {
      throw new Error('No scenes were generated');
    }

    // The phases the owner's asset store refused for room. Each stopped at its
    // first refusal rather than keep paying a provider for bytes it would
    // refuse; the others went on.
    const storageFullPhases: string[] = [];

    // Phase: Media generation (after all scenes generated)
    if (capabilities.imageGeneration || capabilities.videoGeneration) {
      await options.onProgress?.({
        step: 'generating_media',
        progress: 90,
        message: 'Generating media files',
        scenesGenerated: scenes.length,
        totalScenes: outlines.length,
      });

      try {
        const media = await generateMediaForClassroom(outlines, stageId, options.ownerId);
        replaceMediaPlaceholders(scenes, media.assets);
        if (media.storageFull.images) storageFullPhases.push('images');
        if (media.storageFull.video) storageFullPhases.push('video');
        log.info(`Media generation complete: ${Object.keys(media.assets).length} files`);
      } catch (err) {
        log.warn('Media generation phase failed, continuing:', err);
      }
    }

    // Phase: TTS generation
    let ttsCoverage: ClassroomTtsCoverage | undefined;
    let ttsFailureWarning: string | undefined;
    if (capabilities.tts) {
      await options.onProgress?.({
        step: 'generating_tts',
        progress: 94,
        message: 'Generating TTS audio',
        scenesGenerated: scenes.length,
        totalScenes: outlines.length,
      });

      try {
        const { storageFull: ttsStorageFull, ...coverage } = await generateTTSForClassroom(
          scenes,
          stageId,
          options.ownerId,
          options.signal,
          async ({ written, total }) => {
            await options.onProgress?.({
              step: 'generating_tts',
              progress: classroomTtsHeartbeatProgress(written, total),
              message: `Generating TTS audio (${written}/${total})`,
              scenesGenerated: scenes.length,
              totalScenes: outlines.length,
            });
          },
        );
        ttsCoverage = coverage;
        if (ttsStorageFull) storageFullPhases.push('narration');
      } catch (err) {
        if (isAbortError(err)) throw err;
        log.warn('TTS generation phase failed, continuing:', err);
        ttsCoverage = { written: 0, total: countNarratableSpeechActions(scenes) };
        ttsFailureWarning = TTS_PHASE_FAILED_WARNING;
      }
    }
    const ttsWarning =
      [
        ttsResultWarning(ttsCoverage, ttsFailureWarning),
        storageFullPhases.length > 0
          ? `${ASSET_STORAGE_FULL_WARNING}: ${storageFullPhases.join(', ')}`
          : undefined,
      ]
        .filter(Boolean)
        .join('; ') || undefined;

    await options.onProgress?.({
      step: 'persisting',
      progress: 98,
      message: 'Persisting classroom data',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    // Saved once, complete and create-only: the course and the ownership of
    // every asset allocated above are committed by this one document write.
    const persisted = await saveGeneratedClassroom(options.ownerId, { stage, scenes, outlines });
    const classroomId = persisted.stage.id;
    const url = `${options.baseUrl}/classroom/${classroomId}`;

    log.info(`Classroom persisted: ${classroomId}, URL: ${url}`);

    await options.onProgress?.({
      step: 'completed',
      progress: 100,
      message: ttsWarning ?? 'Classroom generation completed',
      scenesGenerated: persisted.scenes.length,
      totalScenes: outlines.length,
    });

    return {
      id: classroomId,
      url,
      stage: persisted.stage,
      scenes: persisted.scenes,
      scenesCount: persisted.scenes.length,
      createdAt: new Date(stage.createdAt ?? Date.now()).toISOString(),
      ...(ttsCoverage ? { ttsCoverage } : {}),
      ...(ttsWarning ? { warning: ttsWarning } : {}),
    };
  }
}
