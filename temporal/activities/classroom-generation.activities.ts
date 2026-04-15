import { Context } from '@temporalio/activity';
import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import { applyOutlineFallbacks, generateSceneOutlinesFromRequirements } from '@/lib/generation/outline-generator';
import {
  createSceneWithActions,
  generateSceneActions,
  generateSceneContent,
} from '@/lib/generation/scene-generator';
import { formatTeacherPersonaForPrompt } from '@/lib/generation/prompt-formatters';
import type { AICallFn, AgentInfo } from '@/lib/generation/pipeline-types';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { parseModelString } from '@/lib/ai/providers';
import { resolveApiKey, resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { searchWithExa, formatSearchResultsAsContext } from '@/lib/web-search/exa';
import { persistClassroom } from '@/lib/server/classroom-storage';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
} from '@/lib/server/classroom-media-generation';
import {
  generateMediaToSupabaseActivity,
  generateSceneTTSToSupabaseActivity,
} from './preview-generation.activities';
import {
  pushLatestGeneratedSceneToSupabase,
  replaceAllCourseScenesInSupabase,
} from '@/lib/server/incremental-course-db-sync';
import type { UserRequirements, SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomGenerationActivity');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isSupabaseConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
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

function createInMemoryStore(stage: Stage) {
  type StoreState = {
    stage: Stage | null;
    scenes: Scene[];
    currentSceneId: string | null;
    mode: 'playback';
  };
  let state: StoreState = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };
  const listeners: Array<(s: StoreState, prev: StoreState) => void> = [];
  return {
    getState: () => state,
    setState: (partial: Partial<StoreState>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: StoreState, prev: StoreState) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
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

// ---------------------------------------------------------------------------
// Activity return types (shared between activities and the workflow)
// ---------------------------------------------------------------------------

export interface SetupResult {
  stageId: string;
  stage: Stage;
  agents: AgentInfo[];
  outlines: SceneOutline[];
  courseDescription: string;
}

export interface PersistResult {
  classroomId: string;
  url: string;
  scenesCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Activity 1: Initialise, optionally generate agents + web search, then outlines
// ---------------------------------------------------------------------------

export async function setupAndGenerateOutlinesActivity(
  input: GenerateClassroomInput,
): Promise<SetupResult> {
  Context.current().heartbeat('initializing');

  const { requirement, pdfContent } = input;
  const { model: languageModel, modelInfo, modelString } = resolveModel({});
  log.info(`Using server-configured model: ${modelString}`);

  const { providerId } = parseModelString(modelString);
  const apiKey = resolveApiKey(providerId);
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set ${providerId.toUpperCase()}_API_KEY in env.`,
    );
  }

  const aiCall: AICallFn = async (systemPrompt, userPrompt) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom',
    );
    return result.text;
  };

  const searchQueryAiCall: AICallFn = async (systemPrompt, userPrompt) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: 256,
      },
      'web-search-query-rewrite',
    );
    return result.text;
  };

  const lang = normalizeLanguage(input.language);
  const pdfText = pdfContent?.text || undefined;

  // Resolve agents
  let agents: AgentInfo[];
  const agentMode = input.agentMode || 'default';
  if (agentMode === 'generate') {
    Context.current().heartbeat('generating_agents');
    log.info('Generating custom agent profiles via LLM...');
    try {
      agents = await generateAgentProfiles(requirement, lang, aiCall);
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      log.warn('Agent profile generation failed, falling back to defaults:', e);
      agents = getDefaultAgents();
    }
  } else {
    agents = getDefaultAgents();
  }

  // Optional web search
  Context.current().heartbeat('researching');
  let researchContext: string | undefined;
  if (input.enableWebSearch) {
    const exaKey = resolveWebSearchApiKey();
    if (exaKey) {
      try {
        const searchQuery = await buildSearchQuery(requirement, pdfText, searchQueryAiCall);
        const searchResult = await searchWithExa({ query: searchQuery.query, apiKey: exaKey });
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        log.warn('Web search failed, continuing without search context:', e);
      }
    }
  }

  // Generate outlines
  Context.current().heartbeat('generating_outlines');
  const teacherContext = formatTeacherPersonaForPrompt(agents);
  const requirements: UserRequirements = { requirement, language: lang };

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
    throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
  }

  const outlines = outlinesResult.data;
  log.info(`Generated ${outlines.length} scene outlines`);

  const stageId = nanoid(10);
  const stage: Stage = {
    id: stageId,
    name: outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    language: lang,
    style: 'interactive',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    generatedAgentConfigs: agents.map((a, i) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      persona: a.persona || '',
      avatar: AGENT_DEFAULT_AVATARS[i % AGENT_DEFAULT_AVATARS.length],
      color: AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length],
      priority: a.role === 'teacher' ? 10 : a.role === 'assistant' ? 7 : 5,
    })),
  };

  const courseDescription = outlines[0]?.description || requirement.slice(0, 200);

  return { stageId, stage, agents, outlines, courseDescription };
}

// ---------------------------------------------------------------------------
// Activity 2: Generate a single scene (called once per outline in the workflow)
// ---------------------------------------------------------------------------

export interface GenerateSingleSceneParams {
  outline: SceneOutline;
  stage: Stage;
  agents: AgentInfo[];
  input: GenerateClassroomInput;
}

export async function generateSingleSceneActivity(
  params: GenerateSingleSceneParams,
): Promise<Scene | null> {
  const { outline, stage, agents, input: _input } = params;

  const { model: languageModel, modelInfo } = resolveModel({});

  const aiCall: AICallFn = async (systemPrompt, userPrompt) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom',
    );
    return result.text;
  };

  const safeOutline = applyOutlineFallbacks(outline, true);
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
    log.warn(`Scene content generation failed for: "${safeOutline.title}"`);
    return null;
  }

  const actions = await generateSceneActions(safeOutline, content, aiCall, undefined, agents);
  log.info(`Scene "${safeOutline.title}": ${actions.length} actions`);

  // Use a temporary in-memory store to build the scene object
  const store = createInMemoryStore(stage);
  const api = createStageAPI(store);
  const sceneId = createSceneWithActions(safeOutline, content, actions, api);

  if (!sceneId) {
    log.warn(`Scene creation failed for: "${safeOutline.title}"`);
    return null;
  }

  const scene = store.getState().scenes.find((s) => s.id === sceneId);
  return scene ?? null;
}

// ---------------------------------------------------------------------------
// Activity 3: Push the latest scene to Supabase (incremental sync)
// ---------------------------------------------------------------------------

export interface PushSceneToSupabaseParams {
  stage: Stage;
  scenes: Scene[];
  courseDescription: string;
}

export async function pushSceneToSupabaseActivity(params: PushSceneToSupabaseParams): Promise<void> {
  await pushLatestGeneratedSceneToSupabase({
    stage: params.stage,
    scenes: params.scenes,
    courseDescription: params.courseDescription,
  });
}

// ---------------------------------------------------------------------------
// Activity 4: Generate media and apply placeholders (optional)
// ---------------------------------------------------------------------------

export interface GenerateMediaParams {
  scenes: Scene[];
  outlines: SceneOutline[];
  stageId: string;
  baseUrl: string;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
}

export async function generateMediaActivity(params: GenerateMediaParams): Promise<Scene[]> {
  const {
    scenes,
    outlines,
    stageId,
    baseUrl,
    enableImageGeneration = true,
    enableVideoGeneration = true,
  } = params;

  if (!enableImageGeneration && !enableVideoGeneration) return scenes;

  const scenesCopy: Scene[] = JSON.parse(JSON.stringify(scenes));
  try {
    const filteredOutlines: SceneOutline[] = outlines.map((o) => ({
      ...o,
      mediaGenerations: (o.mediaGenerations ?? []).filter((m) => {
        if (m.type === 'image') return enableImageGeneration;
        if (m.type === 'video') return enableVideoGeneration;
        return false;
      }),
    }));

    // In production, the Temporal Worker runs separately from the web app.
    // Generating media to local disk and serving via /api/classroom-media won't work there.
    // Prefer uploading to Supabase Storage when configured.
    if (isSupabaseConfigured()) {
      const updated = await generateMediaToSupabaseActivity({
        scenes: scenesCopy,
        outlines: filteredOutlines,
        stageId,
      });
      return updated;
    }

    const mediaMap = await generateMediaForClassroom(filteredOutlines, stageId, baseUrl);
    replaceMediaPlaceholders(scenesCopy, mediaMap);
    log.info(`Media generation complete: ${Object.keys(mediaMap).length} files`);
  } catch (err) {
    log.warn('Media generation phase failed, continuing with original scenes:', err);
    return scenes;
  }

  return scenesCopy;
}

// ---------------------------------------------------------------------------
// Activity 5: Generate TTS audio (optional)
// ---------------------------------------------------------------------------

export interface GenerateTTSParams {
  scenes: Scene[];
  stageId: string;
  baseUrl: string;
}

export async function generateTTSActivity(params: GenerateTTSParams): Promise<Scene[]> {
  const { scenes, stageId, baseUrl } = params;

  const scenesCopy: Scene[] = JSON.parse(JSON.stringify(scenes));
  try {
    // Prefer uploading TTS audio to Supabase when configured; filesystem + /api route won't work
    // when the Worker is deployed separately from the web app.
    if (isSupabaseConfigured()) {
      for (let i = 0; i < scenesCopy.length; i++) {
        const updatedScene = await generateSceneTTSToSupabaseActivity({
          scene: scenesCopy[i],
          stageId,
        });
        scenesCopy[i] = updatedScene;
      }
      log.info('TTS generation/upload complete');
      return scenesCopy;
    }

    await generateTTSForClassroom(scenesCopy, stageId, baseUrl);
    log.info('TTS generation complete');
  } catch (err) {
    log.warn('TTS generation phase failed, continuing with original scenes:', err);
    return scenes;
  }

  return scenesCopy;
}

// ---------------------------------------------------------------------------
// Activity 6: Replace all Supabase scenes + persist classroom to disk
// ---------------------------------------------------------------------------

export interface PersistClassroomParams {
  stage: Stage;
  scenes: Scene[];
  courseDescription: string;
  baseUrl: string;
}

export async function persistClassroomActivity(params: PersistClassroomParams): Promise<PersistResult> {
  const { stage, scenes, courseDescription, baseUrl } = params;

  await replaceAllCourseScenesInSupabase({ stage, scenes, courseDescription });

  const persisted = await persistClassroom({ id: stage.id, stage, scenes }, baseUrl);

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

  return {
    classroomId: persisted.id,
    url: persisted.url,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
  };
}
