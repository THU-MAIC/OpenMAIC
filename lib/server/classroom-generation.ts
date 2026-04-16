import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
} from '@/lib/generation/outline-generator';
import {
  createSceneWithActions,
  generateSceneActions,
  generateSceneContent,
} from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { AgentInfo } from '@/lib/generation/pipeline-types';
import { formatTeacherPersonaForPrompt } from '@/lib/generation/prompt-formatters';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { searchWithTavily, formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { persistClassroom } from '@/lib/server/classroom-storage';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
} from '@/lib/server/classroom-media-generation';
import type { UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage, LessonPlanContent, ExerciseCard } from '@/lib/types/stage';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';

const log = createLogger('Classroom');

export interface GenerateClassroomInput {
  requirement: string;
  pdfContent?: { text: string; images: string[] };
  language?: string;
  enableWebSearch?: boolean;
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

function normalizeLanguage(language?: string): 'zh-CN' | 'en-US' {
  return language === 'en-US' ? 'en-US' : 'zh-CN';
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
  language: string,
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
- Names and personas must be in language: ${language}

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

const LESSON_PLAN_MARKER = '[LESSON_PLAN_MODE]';

const VALID_CARD_KINDS = new Set([
  'phrase_chunk', 'dialog_snippet', 'shadow', 'roleplay', 'dialogue_completion',
  'grammar_pattern', 'fill_blank', 'case_transform', 'tense_transform',
  'vocab_in_context', 'matching', 'multiple_choice', 'translate_sentence',
  'mistake_spotlight',
]);

const FIRST_CARD_KINDS = new Set(['phrase_chunk', 'dialog_snippet']);
const LAST_CARD_KINDS = new Set(['grammar_pattern', 'mistake_spotlight']);

interface LessonPlanValidationResult {
  valid: boolean;
  errors: string[];
}

function validateLessonPlanDeck(
  data: { microGoal?: unknown; groundingIds?: unknown; cards?: unknown },
  groundingBlock: string,
): LessonPlanValidationResult {
  const errors: string[] = [];
  const cards = data.cards;

  if (!Array.isArray(cards)) {
    return { valid: false, errors: ['cards must be an array'] };
  }
  if (cards.length < 10 || cards.length > 16) {
    errors.push(`Expected 10–16 cards, got ${cards.length}`);
  }
  if (cards.length > 0 && !FIRST_CARD_KINDS.has(cards[0].kind)) {
    errors.push(`First card must be phrase_chunk or dialog_snippet, got "${cards[0].kind}"`);
  }
  if (cards.length > 0 && !LAST_CARD_KINDS.has(cards[cards.length - 1].kind)) {
    errors.push(`Last card must be grammar_pattern or mistake_spotlight, got "${cards[cards.length - 1].kind}"`);
  }
  for (const [i, card] of cards.entries()) {
    if (!card.kind || !VALID_CARD_KINDS.has(card.kind)) {
      errors.push(`Card ${i}: unknown kind "${card.kind}"`);
    }
  }

  // Validate grounding IDs reference the grounding block
  const allReferencedIds = new Set<string>();
  for (const card of cards) {
    if (card.groundingId) allReferencedIds.add(card.groundingId);
    if (Array.isArray(card.groundingIds)) {
      for (const id of card.groundingIds) allReferencedIds.add(id);
    }
  }
  for (const id of allReferencedIds) {
    if (!groundingBlock.includes(`id="${id}"`)) {
      errors.push(`Grounding ID "${id}" not found in the grounding block`);
    }
  }

  return { valid: errors.length === 0, errors };
}

async function generateLessonPlan(
  requirement: string,
  aiCall: AICallFn,
): Promise<LessonPlanContent> {
  const prompt = buildPrompt(PROMPT_IDS.LESSON_PLAN, { requirement });
  if (!prompt) throw new Error('Failed to load lesson-plan prompt template');

  const groundingBlock = requirement.includes('## Grounding')
    ? requirement.slice(requirement.indexOf('## Grounding'))
    : '';

  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryHint = attempt > 0 && lastErrors.length > 0
      ? `\n\nYour previous response had validation errors:\n${lastErrors.map((e) => `- ${e}`).join('\n')}\nPlease fix these issues.`
      : '';

    const response = await aiCall(prompt.system, prompt.user + retryHint);
    const cleaned = stripCodeFences(response);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      lastErrors = [`Invalid JSON: ${cleaned.slice(0, 100)}...`];
      log.warn(`Lesson plan attempt ${attempt + 1}: JSON parse failed, ${attempt < 1 ? 'retrying' : 'giving up'}`);
      continue;
    }

    const validation = validateLessonPlanDeck(parsed, groundingBlock);
    if (validation.valid) {
      return {
        type: 'lesson_plan',
        microGoal: parsed.microGoal as LessonPlanContent['microGoal'],
        groundingIds: parsed.groundingIds as string[],
        cards: parsed.cards as ExerciseCard[],
      };
    }

    lastErrors = validation.errors;
    log.warn(`Lesson plan attempt ${attempt + 1}: validation failed (${validation.errors.length} errors), ${attempt < 1 ? 'retrying' : 'giving up'}`);
  }

  throw new Error(`Lesson plan validation failed after 2 attempts: ${lastErrors.join('; ')}`);
}

/** Detect rate-limit / overload errors where a fallback model may succeed. */
function isOverloadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const statusCode = (error as unknown as Record<string, unknown>).statusCode ??
    (error as unknown as Record<string, unknown>).status;
  if (statusCode === 429 || statusCode === 503) return true;
  const msg = error.message.toLowerCase();
  return msg.includes('overloaded') || msg.includes('rate limit') || msg.includes('quota') || msg.includes('high demand');
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  },
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;

  await options.onProgress?.({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const {
    model: languageModel,
    modelInfo,
    modelString,
  } = await resolveModel({});
  log.info(`Using server-configured model: ${modelString}`);

  // Resolve fallback model chain for overload resilience.
  // FALLBACK_MODEL accepts a comma-separated list, e.g.
  // "google:gemini-2.5-flash-lite,google:gemini-3-flash-preview"
  const fallbackChain: Array<{
    modelString: string;
    model: typeof languageModel;
    modelInfo: typeof modelInfo;
  }> = [];
  const fallbackEnv = process.env.FALLBACK_MODEL;
  if (fallbackEnv) {
    for (const entry of fallbackEnv.split(',').map((s) => s.trim()).filter(Boolean)) {
      try {
        const fb = await resolveModel({ modelString: entry });
        fallbackChain.push({ modelString: entry, model: fb.model, modelInfo: fb.modelInfo });
      } catch (e) {
        log.warn(`Failed to resolve fallback model "${entry}":`, e);
      }
    }
    if (fallbackChain.length > 0) {
      log.info(`Fallback chain: ${fallbackChain.map((f) => f.modelString).join(' → ')}`);
    }
  }

  /** Try primary model first, then walk the fallback chain on overload errors. */
  async function callWithFallback(
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number | undefined,
    source: string,
  ): Promise<string> {
    try {
      const result = await callLLM(
        {
          model: languageModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: maxTokens,
        },
        source,
      );
      return result.text;
    } catch (error) {
      if (!isOverloadError(error) || fallbackChain.length === 0) throw error;
      log.warn(`Primary model overloaded (${source}), trying fallback chain...`);

      for (const fb of fallbackChain) {
        try {
          log.info(`Trying fallback: ${fb.modelString}`);
          const result = await callLLM(
            {
              model: fb.model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              maxOutputTokens: fb.modelInfo?.outputWindow,
            },
            `${source}-fallback`,
          );
          return result.text;
        } catch (fbError) {
          if (!isOverloadError(fbError)) throw fbError;
          log.warn(`Fallback ${fb.modelString} also overloaded, trying next...`);
        }
      }
      throw error;
    }
  }

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    return callWithFallback(systemPrompt, userPrompt, modelInfo?.outputWindow, 'generate-classroom');
  };

  const searchQueryAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    return callWithFallback(systemPrompt, userPrompt, 256, 'web-search-query-rewrite');
  };

  // ── Lesson Plan Mode ─────────────────────────────────────────────────
  // When the requirement starts with [LESSON_PLAN_MODE], skip the entire
  // outline → scene → media pipeline and generate a single lesson-plan
  // Scene directly from the structured grounding data.
  if (requirement.startsWith(LESSON_PLAN_MARKER)) {
    log.info('Lesson plan mode detected — skipping outline generator');

    await options.onProgress?.({
      step: 'generating_outlines',
      progress: 15,
      message: 'Generating lesson plan',
      scenesGenerated: 0,
      totalScenes: 1,
    });

    const lessonContent = await generateLessonPlan(requirement, aiCall);
    log.info(`Lesson plan generated: ${lessonContent.cards.length} cards`);

    await options.onProgress?.({
      step: 'generating_scenes',
      progress: 80,
      message: 'Building lesson scene',
      scenesGenerated: 1,
      totalScenes: 1,
    });

    const stageId = nanoid(10);
    const title = lessonContent.microGoal.topic || requirement.slice(0, 50);
    const stage: Stage = {
      id: stageId,
      name: title,
      language: input.language,
      style: 'lesson_plan',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const scene: Scene = {
      id: `sc_${nanoid(10)}`,
      stageId,
      type: 'lesson_plan',
      title,
      order: 0,
      content: lessonContent,
    };

    await options.onProgress?.({
      step: 'persisting',
      progress: 95,
      message: 'Persisting lesson',
      scenesGenerated: 1,
      totalScenes: 1,
    });

    const persisted = await persistClassroom(
      { id: stageId, stage, scenes: [scene] },
      options.baseUrl,
    );

    log.info(`Lesson plan persisted: ${persisted.id}, URL: ${persisted.url}`);

    await options.onProgress?.({
      step: 'completed',
      progress: 100,
      message: 'Lesson plan generation completed',
      scenesGenerated: 1,
      totalScenes: 1,
    });

    return {
      id: persisted.id,
      url: persisted.url,
      stage,
      scenes: [scene],
      scenesCount: 1,
      createdAt: persisted.createdAt,
    };
  }

  // ── Standard classroom generation ──────────────────────────────────

  const lang = normalizeLanguage(input.language);
  const requirements: UserRequirements = {
    requirement,
    language: lang,
  };
  const pdfText = pdfContent?.text || undefined;

  // Resolve agents based on agentMode
  let agents: AgentInfo[];
  let agentMode = input.agentMode || 'default';
  if (agentMode === 'generate') {
    log.info('Generating custom agent profiles via LLM...');
    try {
      agents = await generateAgentProfiles(requirement, lang, aiCall);
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      log.warn('Agent profile generation failed, falling back to defaults:', e);
      agents = getDefaultAgents();
      agentMode = 'default';
    }
  } else {
    agents = getDefaultAgents();
  }
  const teacherContext = formatTeacherPersonaForPrompt(agents);

  await options.onProgress?.({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (input.enableWebSearch) {
    const tavilyKey = resolveWebSearchApiKey();
    if (tavilyKey) {
      try {
        const searchQuery = await buildSearchQuery(requirement, pdfText, searchQueryAiCall);

        log.info('Running web search for classroom generation', {
          hasPdfContext: searchQuery.hasPdfContext,
          rawRequirementLength: searchQuery.rawRequirementLength,
          rewriteAttempted: searchQuery.rewriteAttempted,
          finalQueryLength: searchQuery.finalQueryLength,
        });

        const searchResult = await searchWithTavily({
          query: searchQuery.query,
          apiKey: tavilyKey,
        });
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        log.warn('Web search failed, continuing without search context:', e);
      }
    } else {
      log.warn('enableWebSearch is true but no Tavily API key configured, skipping web search');
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
    aiCall,
    undefined,
    {
      imageGenerationEnabled: input.enableImageGeneration,
      videoGenerationEnabled: input.enableVideoGeneration,
      researchContext,
      teacherContext,
    },
  );

  if (!outlinesResult.success || !outlinesResult.data) {
    log.error('Failed to generate outlines:', outlinesResult.error);
    throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
  }

  const outlines = outlinesResult.data;
  log.info(`Generated ${outlines.length} scene outlines`);

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  const stageId = nanoid(10);
  const stage: Stage = {
    id: stageId,
    name: outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    language: lang,
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
    const safeOutline = applyOutlineFallbacks(outline, true);
    const progressStart = 30 + Math.floor((index / Math.max(outlines.length, 1)) * 60);

    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.max(progressStart, 31),
      message: `Generating scene ${index + 1}/${outlines.length}: ${safeOutline.title}`,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });

    const content = await generateSceneContent(
      safeOutline,
      aiCall,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      agents,
    );
    if (!content) {
      log.warn(`Skipping scene "${safeOutline.title}" — content generation failed`);
      continue;
    }

    const actions = await generateSceneActions(safeOutline, content, aiCall, undefined, agents);
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

  // Phase: Media generation (after all scenes generated)
  if (input.enableImageGeneration || input.enableVideoGeneration) {
    await options.onProgress?.({
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

  // Phase: TTS generation
  if (input.enableTTS) {
    await options.onProgress?.({
      step: 'generating_tts',
      progress: 94,
      message: 'Generating TTS audio',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      await generateTTSForClassroom(scenes, stageId, options.baseUrl, input.language);
      log.info('TTS generation complete');
    } catch (err) {
      log.warn('TTS generation phase failed, continuing:', err);
    }
  }

  await options.onProgress?.({
    step: 'persisting',
    progress: 98,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  const persisted = await persistClassroom(
    {
      id: stageId,
      stage,
      scenes,
    },
    options.baseUrl,
  );

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

  await options.onProgress?.({
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  return {
    id: persisted.id,
    url: persisted.url,
    stage,
    scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
  };
}
