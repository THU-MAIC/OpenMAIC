import { nanoid } from 'nanoid';
import { callLLM, getGlobalThinkingConfig } from '@/lib/ai/llm';
import {
  getClassroomContentOutputOptions,
  getClassroomContentThinkingConfig,
} from '@/lib/server/classroom-content-transport';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
  generateSceneActions,
  generateSceneContent,
  PBLGenerationError,
  withGenerationRetry,
  validateSourceRequirements,
  type CodemateClassroomSource,
  type AICallFn,
  type AgentInfo,
  type SceneOutline,
} from '@openmaic/generation';
import { createSceneWithActions } from '@/lib/server/scene-generation';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { getStageModel, type LlmStage } from '@/lib/server/model-routes';
import type { LanguageModel } from 'ai';
import type { ThinkingConfig } from '@/lib/types/provider';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import { persistClassroom } from '@/lib/server/classroom-storage';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
  prepareClassroomSpeechForTTS,
} from '@/lib/server/classroom-media-generation';
import {
  CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS,
  createClassroomContentCallbacks,
  reviewClassroomContentScoped,
  matchesClassroomContentProof,
  ClassroomContentReviewError,
  type ClassroomContentProof,
  type ClassroomContentStructuredCall,
} from '@/lib/server/classroom-content-review';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import type { UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';

const log = createLogger('Classroom');

/** Server-owned task shells, never a diagnosis or a factual content pass. */
function createCorrectionPlan(requirements: UserRequirements): {
  languageDirective: string;
  courseTitle: string;
  outlines: SceneOutline[];
} {
  validateSourceRequirements(requirements);
  if (requirements.codeContextRequired !== true || !requirements.codemateSource) {
    throw new Error('Complete code source context is required');
  }
  return {
    languageDirective:
      '本 AIOJ 编程纠错课的新授课文字统一使用简体中文，包括讲义、教师讲解与字幕、互动控件标签与提示、练习题干、选项和解析。代码与标识符、原题原文引用、程序输入输出必须逐字保留，不翻译、不改写。',
    courseTitle: requirements.codemateSource.title,
    outlines: [
      {
        id: 'correction-source-analysis',
        type: 'slide',
        title: '源码分析与修复核对',
        description:
          '核对完整题意、合法输入与原始提交，只列有源码证据支持的缺陷；原码无错时明确说明，不强制改写。',
        teachingObjective: '核对全部独立根因、必要原值及原位置上的完整修复；不预设原码必错。',
        keyPoints: [
          '从完整原题和原码逐项验证独立根因及触发条件，不以早期诊断代替源码证据。',
          '有缺陷时覆盖全部必要原值与完整原位置修复；没有缺陷时说明依据，允许等价正确实现。',
        ],
        order: 1,
      },
      {
        id: 'correction-interactive-demo',
        type: 'interactive',
        title: '互动验证',
        description:
          '依据完整源码选择合法输入与初态，制作可操作演示，提供输入操作、分步观察与重置，并显示有依据的状态变化。',
        teachingObjective:
          '操作完整演示，并区分原始提交、参考修正与实际 HTML/JS 手算实现的证据边界。',
        keyPoints: [
          '提供合法输入、明确初态、实际可用的操作控件与重置，状态和显示必须一致。',
          '分别标明原码、参考码与 HTML/JS 手算；只说明有依据且有定义的变化，不伪造执行或评测结论。',
        ],
        widgetType: 'simulation',
        widgetOutline: { concept: '源码行为与修复核对' },
        order: 2,
      },
      {
        id: 'correction-understanding-check',
        type: 'quiz',
        title: '理解检测',
        description: '依据完整题意和源码核对结果生成理解检测，答案、判分与解释必须一致。',
        teachingObjective: '判断有证据支持的源码结论与完整修复，而非记忆预设答案。',
        keyPoints: [
          '使用可明确判分的单选题，覆盖源码核对中的必要条件与完整修复或无需修复的依据。',
          '正确选项及解释须有源码依据；错误干扰项应明确作为选项，不当作事实主张。',
        ],
        quizConfig: { questionCount: 2, difficulty: 'easy', questionTypes: ['single'] },
        order: 3,
      },
    ],
  };
}

export function containPBLGenerationError(error: unknown, sceneTitle: string): null {
  if (!(error instanceof PBLGenerationError)) throw error;
  log.warn(`PBL generation failed for scene "${sceneTitle}": ${error.message}`);
  return null;
}

export interface GenerateClassroomInput {
  requirement: string;
  codeContextRequired?: boolean;
  codemateSource?: CodemateClassroomSource;
  pdfContent?: { text: string; images: string[] };
  enableWebSearch?: boolean;
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  webSearchModelId?: string;
  baiduSubSources?: BaiduSubSources;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'reviewing_content'
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
  contentReview?: ClassroomContentProof;
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

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    signal?: AbortSignal;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  },
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;
  // These bounds cancel the real transport; a late result cannot start paid
  // follow-up stages or reach persistence after this job has expired.
  const generationDeadline = Date.now() + 720_000;
  const generationSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(720_000)])
    : AbortSignal.timeout(720_000);
  generationSignal.throwIfAborted();
  const reportProgress = async (progress: ClassroomGenerationProgress) => {
    generationSignal.throwIfAborted();
    await options.onProgress?.(progress);
    generationSignal.throwIfAborted();
  };
  const callWithBudget =
    (deadlineMs: number): typeof callLLM =>
    async (params, source, retryOptions, thinking) => {
      generationSignal.throwIfAborted();
      const abortSignal = AbortSignal.any([
        generationSignal,
        AbortSignal.timeout(deadlineMs),
        ...(params.abortSignal ? [params.abortSignal] : []),
      ]);
      const result = await callLLM(
        { ...params, abortSignal, maxRetries: 0 },
        source,
        retryOptions ? { ...retryOptions, retries: 0 } : undefined,
        thinking,
      );
      abortSignal.throwIfAborted();
      generationSignal.throwIfAborted();
      return result;
    };
  const boundedLLM = callWithBudget(75_000);
  const contentReviewLLM = callWithBudget(CLASSROOM_CONTENT_REQUEST_TIMEOUT_MS);
  // Capture the full host material once; model output/outline never replaces it.
  const requirements: UserRequirements = Object.freeze({
    requirement,
    ...(input.codeContextRequired !== undefined
      ? { codeContextRequired: input.codeContextRequired }
      : {}),
    ...(input.codemateSource !== undefined
      ? { codemateSource: structuredClone(input.codemateSource) }
      : {}),
  });
  validateSourceRequirements(requirements);
  const codeBound = requirements.codeContextRequired === true;

  await reportProgress({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const {
    model: languageModel,
    modelInfo,
    modelString,
    providerId,
    apiKey,
    thinkingConfig: classroomThinking,
  } = await resolveModel({ stage: 'generate-classroom' });
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  if (isProviderKeyRequired(providerId) && !apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  // The web-search query rewrite is a light, separable stage operators may route
  // to a cheaper model. It defaults to the classroom model and is only
  // re-resolved lazily (inside the web-search branch, and only when a route is
  // configured). This keeps a misconfigured optional route from aborting all
  // classroom generation, and skips the extra resolution when web search is off.
  let searchQueryModel = languageModel;
  let searchQueryThinking = classroomThinking;

  const createAiCall =
    (
      llm: typeof callLLM,
      outputOptions?: ReturnType<typeof getClassroomContentOutputOptions>,
      thinking: ThinkingConfig | undefined = classroomThinking,
      reviewSignal?: AbortSignal,
    ): AICallFn =>
    async (systemPrompt, userPrompt, _images) => {
      const result = await llm(
        {
          model: languageModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: modelInfo?.outputWindow,
          ...outputOptions,
          ...(reviewSignal ? { abortSignal: reviewSignal } : {}),
        },
        'generate-classroom',
        undefined,
        thinking,
      );
      return result.text;
    };

  const aiCall = createAiCall(boundedLLM);
  // Only complete-content review/repair uses the bounded JSON/reasoning options.
  // Keep raw text for the strict schema, hash, JSON Pointer and quote checks.
  const contentReviewAiCall = createAiCall(
    contentReviewLLM,
    getClassroomContentOutputOptions(languageModel),
    getClassroomContentThinkingConfig(languageModel, classroomThinking),
  );
  // The response schema is generated only from the helper's immutable server packet.
  // Keep this separate from AICallFn's optional images argument and ordinary calls.
  const contentReviewStructuredCall: ClassroomContentStructuredCall = (
    system,
    user,
    schema,
    context,
  ) =>
    createAiCall(
      contentReviewLLM,
      getClassroomContentOutputOptions(languageModel, schema),
      getClassroomContentThinkingConfig(languageModel, classroomThinking),
      context?.signal,
    )(system, user);

  // Per-stage model resolution for the scene pipeline. The classroom used to
  // bind a single `languageModel` (from the `generate-classroom` stage) into one
  // `sceneAiCall` closure shared by scene-content and scene-actions. That made
  // every `MODEL_ROUTES` entry for `scene-content` / `scene-content:<type>` /
  // `scene-actions` a no-op on this path — the browser UI already routes each
  // stage independently via /api/generate/*, but the one-shot skill API did not.
  //
  // Each stage is resolved lazily and only when a route is actually configured
  // (getStageModel returns undefined), so unrouted deployments pay zero extra
  // cost and reuse the classroom model. Resolution failure (e.g. an unknown
  // provider in the route) degrades to the classroom model with a warn, mirroring
  // the existing web-search-query-rewrite handling below — a misconfigured
  // optional route never aborts classroom generation.
  const stageModelCache = new Map<
    LlmStage,
    {
      model: LanguageModel;
      outputWindow?: number;
      thinking: ThinkingConfig | undefined;
    }
  >();

  const resolveStageModel = async (
    stage: LlmStage,
  ): Promise<{
    model: LanguageModel;
    outputWindow?: number;
    thinking: ThinkingConfig | undefined;
  }> => {
    const cached = stageModelCache.get(stage);
    if (cached) return cached;

    // No route configured → reuse the classroom model, no extra resolution.
    if (!getStageModel(stage)) {
      const fallback = {
        model: languageModel,
        outputWindow: modelInfo?.outputWindow,
        thinking: classroomThinking,
      };
      stageModelCache.set(stage, fallback);
      return fallback;
    }

    try {
      const resolved = await resolveModel({ stage });
      const entry = {
        model: resolved.model,
        outputWindow: resolved.modelInfo?.outputWindow,
        thinking: resolved.thinkingConfig,
      };
      log.info(`Stage "${stage}" routed to model: ${resolved.modelString}`);
      stageModelCache.set(stage, entry);
      return entry;
    } catch (err) {
      log.warn(
        `Stage "${stage}" route "${getStageModel(stage)}" could not be resolved; ` +
          `falling back to the generate-classroom model.`,
        err,
      );
      const fallback = {
        model: languageModel,
        outputWindow: modelInfo?.outputWindow,
        thinking: classroomThinking,
      };
      stageModelCache.set(stage, fallback);
      return fallback;
    }
  };

  // A scene default only: explicit stage/classroom and shared global settings win.
  const resolveSceneThinkingConfig = (
    model: LanguageModel,
    configured: ThinkingConfig | undefined,
  ): ThinkingConfig | undefined => {
    if (
      !codeBound ||
      configured !== undefined ||
      typeof model !== 'object' ||
      model === null ||
      !('provider' in model) ||
      model.provider !== 'openai.chat' ||
      !('modelId' in model) ||
      model.modelId !== 'deepseek-ai/DeepSeek-V4-Flash'
    )
      return configured;
    return getGlobalThinkingConfig() ?? { mode: 'disabled', enabled: false };
  };

  // scene-content routes per outline type via the composite key
  // `scene-content:<type>` (slide/quiz/interactive/pbl), falling back to the
  // base `scene-content` route — same resolution the browser UI uses at
  // /api/generate/scene-content. Returns the aiCall plus the resolved model
  // and thinking config, because PBL scene generation drives its own LLM
  // calls through the model object (generatePBLSceneContent) rather than the
  // aiCall closure, and consumes the route's thinking config separately.
  const resolveSceneContentCall = async (outlineType?: string) => {
    const stage = (outlineType ? `scene-content:${outlineType}` : 'scene-content') as LlmStage;
    const { model, outputWindow, thinking } = await resolveStageModel(stage);
    const contentLLM =
      codeBound && outlineType === 'interactive' ? callWithBudget(180_000) : boundedLLM;
    const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
      const result = await contentLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
          maxRetries: 0,
        },
        'generate-classroom-scene',
        undefined,
        resolveSceneThinkingConfig(model, thinking),
      );
      return result.text;
    };
    return { aiCall, model, thinking };
  };

  // agent-profiles routes via the `agent-profiles` stage (matches the browser
  // UI's /api/generate/agent-profiles). Lazy + cached like the scene stages.
  let agentProfilesAiCall: AICallFn | undefined;
  const getAgentProfilesAiCall = async (): Promise<AICallFn> => {
    if (agentProfilesAiCall) return agentProfilesAiCall;
    const { model, outputWindow, thinking } = await resolveStageModel('agent-profiles');
    agentProfilesAiCall = async (systemPrompt, userPrompt, _images) => {
      const result = await boundedLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
        },
        'generate-classroom',
        undefined,
        thinking,
      );
      return result.text;
    };
    return agentProfilesAiCall;
  };

  // scene-actions routes via the `scene-actions` stage.
  let sceneActionsAiCall: AICallFn | undefined;
  const getSceneActionsAiCall = async (): Promise<AICallFn> => {
    if (sceneActionsAiCall) return sceneActionsAiCall;
    const { model, outputWindow, thinking } = await resolveStageModel('scene-actions');
    sceneActionsAiCall = async (systemPrompt, userPrompt, _images) => {
      const result = await boundedLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
          maxRetries: 0,
        },
        'generate-classroom-scene',
        undefined,
        resolveSceneThinkingConfig(model, thinking),
      );
      return result.text;
    };
    return sceneActionsAiCall;
  };

  const searchQueryAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await boundedLLM(
      {
        model: searchQueryModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: 256,
      },
      'web-search-query-rewrite',
      undefined,
      searchQueryThinking,
    );
    return result.text;
  };

  const vocationalActive = resolveVocationalActive(requirements);
  const pdfText = pdfContent?.text || undefined;

  await reportProgress({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (input.enableWebSearch && !codeBound) {
    const webSearchConfig = resolveClassroomWebSearchConfig(input);
    if (webSearchConfig) {
      // Re-resolve the query-rewrite model only when explicitly routed. If
      // resolution itself fails (e.g. unknown provider in the route), fall back
      // to the classroom model here; a route with a missing key resolves fine
      // and surfaces only later in callLLM, which the outer try/catch below
      // degrades gracefully — either way the pipeline still works.
      const rewriteRoute = getStageModel('web-search-query-rewrite');
      if (rewriteRoute) {
        try {
          const rewriteResolved = await resolveModel({ stage: 'web-search-query-rewrite' });
          searchQueryModel = rewriteResolved.model;
          searchQueryThinking = rewriteResolved.thinkingConfig;
        } catch (err) {
          log.warn(
            `web-search-query-rewrite route "${rewriteRoute}" unavailable; using classroom model for query rewrite`,
            err,
          );
        }
      }
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
      log.warn('enableWebSearch is true but no web search API key configured, skipping web search');
    }
  }

  await reportProgress({
    step: 'generating_outlines',
    progress: 15,
    message: codeBound ? 'Preparing correction lesson sections' : 'Generating scene outlines',
    scenesGenerated: 0,
  });

  const outlinesResult = codeBound
    ? { success: true as const, data: createCorrectionPlan(requirements) }
    : await generateSceneOutlinesFromRequirements(requirements, pdfText, undefined, aiCall, {
        imageGenerationEnabled: !codeBound && input.enableImageGeneration,
        videoGenerationEnabled: !codeBound && input.enableVideoGeneration,
        researchContext,
        // NO teacherContext — agents haven't been generated yet
      });

  if (!outlinesResult.success || !outlinesResult.data) {
    log.error('Failed to generate outlines:', outlinesResult.error);
    throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
  }

  const { languageDirective, courseTitle, outlines } = outlinesResult.data;
  log.info(
    `Generated ${outlines.length} scene outlines (languageDirective: ${languageDirective}, courseTitle: ${courseTitle ?? 'n/a'})`,
  );

  await reportProgress({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  // Resolve agents based on agentMode — now AFTER outlines so we can use languageDirective
  let agents: AgentInfo[];
  const agentMode = input.agentMode || 'default';
  if (agentMode === 'generate') {
    log.info('Generating custom agent profiles via LLM...');
    try {
      const agentProfilesCall = await getAgentProfilesAiCall();
      agents = await generateAgentProfiles(requirement, languageDirective, agentProfilesCall);
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      log.warn('Agent profile generation failed, falling back to defaults:', e);
      agents = getDefaultAgents();
    }
  } else {
    agents = getDefaultAgents();
  }

  const stageId = nanoid(10);
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
    // hydrate the agent registry without prior IndexedDB data.
    // For default agents, just record IDs — the client already has them.
    ...(agentMode === 'generate'
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

  const store = createInMemoryStore(stage);
  const api = createStageAPI(store);

  log.info('Stage 2: Generating scene content and actions...');
  let generatedScenes = 0;

  for (const [index, outline] of outlines.entries()) {
    const safeOutline = applyOutlineFallbacks(outline, true, {
      allowProceduralSkill: vocationalActive,
    });
    const progressStart = 30 + Math.floor((index / Math.max(outlines.length, 1)) * 60);

    await reportProgress({
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
      await reportProgress({
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
              userRequirements: requirements,
              allowProceduralSkill: vocationalActive,
              ...(safeOutline.type === 'pbl'
                ? {
                    pblLoopFallback: (input) =>
                      generatePBLV2Project(
                        input,
                        contentCall.model,
                        boundedLLM,
                        { logger: log },
                        contentCall.thinking,
                      ),
                  }
                : {}),
            }),
          {
            label: `scene ${index + 1}/${outlines.length} content`,
            ...(codeBound ? { maxRetries: 1 } : {}),
            signal: generationSignal,
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

    const actionsAiCall = await getSceneActionsAiCall();
    const actions = await withGenerationRetry(
      () =>
        generateSceneActions(safeOutline, content, actionsAiCall, {
          agents,
          languageDirective,
          userRequirements: requirements,
          ...(codeBound ? { targetLanguage: 'zh-CN' } : {}),
        }),
      {
        label: `scene ${index + 1}/${outlines.length} actions`,
        ...(codeBound ? { maxRetries: 1 } : {}),
        signal: generationSignal,
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
    await reportProgress({
      step: 'generating_scenes',
      progress: Math.min(progressEnd, 90),
      message: `Generated ${generatedScenes}/${outlines.length} scenes`,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });
  }

  let scenes = store.getState().scenes;
  log.info(`Pipeline complete: ${scenes.length} scenes generated`);

  if (scenes.length === 0) {
    throw new Error('No scenes were generated');
  }
  if (codeBound && scenes.length !== outlines.length) {
    throw new ClassroomContentReviewError('material_incomplete');
  }
  generationSignal.throwIfAborted();

  // Phase: Media generation (after all scenes generated)
  if (!codeBound && (input.enableImageGeneration || input.enableVideoGeneration)) {
    await reportProgress({
      step: 'generating_media',
      progress: 90,
      message: 'Generating media files',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      const mediaMap = await generateMediaForClassroom(outlines, stageId, options.baseUrl);
      replaceMediaPlaceholders(scenes, mediaMap);
      log.info(`Media generation complete: ${Object.keys(mediaMap).length} files`);
    } catch (err) {
      log.warn('Media generation phase failed, continuing:', err);
    }
  }

  // Fix speech chunks before review so synthesis cannot silently change the
  // final teaching text/IDs that were actually checked.
  if (input.enableTTS || codeBound) prepareClassroomSpeechForTTS(scenes);
  let finalMaterial = { stage, scenes };
  let contentReview: ClassroomContentProof | undefined;
  if (codeBound) {
    await reportProgress({
      step: 'reviewing_content',
      progress: 91,
      message: 'Checking complete classroom teaching content',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });
    const checked = await reviewClassroomContentScoped({
      requirements,
      material: finalMaterial,
      callbacks: createClassroomContentCallbacks(contentReviewAiCall, {
        structuredCall: contentReviewStructuredCall,
      }),
      expectedSceneCount: outlines.length,
      signal: generationSignal,
      deadlineAt: generationDeadline,
    });
    generationSignal.throwIfAborted();
    finalMaterial = checked.material;
    contentReview = checked.proof;
    scenes = finalMaterial.scenes;
  }
  const validateBeforeWrite = (material: { stage: Stage; scenes: Scene[] }) => {
    generationSignal.throwIfAborted();
    if (
      codeBound &&
      (!contentReview || !matchesClassroomContentProof(requirements, material, contentReview))
    )
      throw new ClassroomContentReviewError('binding_mismatch');
  };

  // Required AIOJ classroom narration cannot be disabled by a request flag.
  if (input.enableTTS || codeBound) {
    await reportProgress({
      step: 'generating_tts',
      progress: 94,
      message: 'Generating TTS audio',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      await generateTTSForClassroom(scenes, stageId, options.baseUrl, {
        required: codeBound,
        signal: generationSignal,
      });
      log.info('TTS generation complete');
    } catch (err) {
      generationSignal.throwIfAborted();
      if (codeBound) throw err;
      log.warn('TTS generation phase failed, continuing:', err);
    }
  }

  await reportProgress({
    step: 'persisting',
    progress: 98,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  validateBeforeWrite(finalMaterial);
  const persisted = await persistClassroom(
    {
      id: stageId,
      stage: finalMaterial.stage,
      scenes,
    },
    options.baseUrl,
    { signal: generationSignal, contentReview, validateBeforeWrite },
  );
  // Storage normalization is covered before its atomic document write, too.
  validateBeforeWrite({ stage: persisted.stage, scenes: persisted.scenes });

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

  await reportProgress({
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  return {
    id: persisted.id,
    url: persisted.url,
    stage: persisted.stage,
    scenes: persisted.scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
    ...(contentReview ? { contentReview } : {}),
  };
}
