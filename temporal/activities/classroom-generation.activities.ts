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
import { resolveApiKey, resolveWebSearchApiKey, resolveTTSApiKey, resolveTTSBaseUrl } from '@/lib/server/provider-config';
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
import { resolveGenerationLanguage } from '@/lib/constants/generation';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { generateTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_VOICES, DEFAULT_TTS_MODELS, TTS_PROVIDERS } from '@/lib/audio/constants';
import type { TTSProviderId } from '@/lib/audio/types';
import type { SpeechAction } from '@/lib/types/action';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { createAdminClient } from '@/utils/supabase/admin';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomGenerationActivity');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isSupabaseConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
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

  const lang = resolveGenerationLanguage(input.language);
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

  const outlineWithLanguage: SceneOutline = {
    ...outline,
    language: resolveGenerationLanguage(outline.language ?? stage.language),
  };

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

  const safeOutline = applyOutlineFallbacks(outlineWithLanguage, true);
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
      const updatedScenes = await Promise.all(
        scenesCopy.map((scene) => generateSceneTTSToSupabaseActivity({ scene, stageId })),
      );
      log.info('TTS generation/upload complete');
      return updatedScenes;
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

// ---------------------------------------------------------------------------
// Activity 7: Generate TTS with an explicit provider override (for queued jobs)
// ---------------------------------------------------------------------------

export interface GenerateTTSWithProviderParams {
  scenes: Scene[];
  stageId: string;
  baseUrl: string;
  ttsProviderId: string;
}

export async function generateTTSWithProviderActivity(
  params: GenerateTTSWithProviderParams,
): Promise<Scene[]> {
  const { scenes, stageId, ttsProviderId } = params;

  const scenesCopy: Scene[] = JSON.parse(JSON.stringify(scenes));

  if (!isSupabaseConfigured()) {
    log.warn('Supabase not configured — skipping TTS generation');
    return scenesCopy;
  }

  const providerId = ttsProviderId as TTSProviderId;
  const apiKey = resolveTTSApiKey(providerId);

  if (!apiKey) {
    log.warn(`No API key for TTS provider "${providerId}" — falling back to default per-scene TTS`);
    return Promise.all(
      scenesCopy.map((scene) => generateSceneTTSToSupabaseActivity({ scene, stageId })),
    );
  }

  const ttsBaseUrl = resolveTTSBaseUrl(providerId) || TTS_PROVIDERS[providerId]?.defaultBaseUrl;
  const voice = DEFAULT_TTS_VOICES[providerId] || 'default';
  const format = TTS_PROVIDERS[providerId]?.supportedFormats?.[0] || 'mp3';
  const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`;
  const supabase = createAdminClient();
  const supabasePublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;

  return Promise.all(
    scenesCopy.map(async (scene) => {
      if (!scene.actions) return scene;

      const updatedScene: Scene = JSON.parse(JSON.stringify(scene));
      updatedScene.actions = splitLongSpeechActions(updatedScene.actions!, providerId);

      const speechActions = (updatedScene.actions ?? []).filter(
        (a): a is SpeechAction => a.type === 'speech' && !!('text' in a && (a as SpeechAction).text),
      );

      await Promise.all(
        speechActions.map(async (speechAction) => {
          const audioId = `tts_${speechAction.id}`;
          try {
            Context.current().heartbeat(`tts:${audioId}`);
            const result = await generateTTS(
              {
                providerId,
                modelId: DEFAULT_TTS_MODELS[providerId] || '',
                apiKey,
                baseUrl: ttsBaseUrl,
                voice,
                speed: speechAction.speed,
              },
              speechAction.text,
            );
            const storagePath = `${stageId}/audio/${audioId}.${format}`;
            const { error } = await supabase.storage
              .from('courses')
              .upload(storagePath, result.audio, { contentType: mimeType, upsert: true });
            if (error) {
              log.warn(`TTS upload failed for ${audioId}:`, error.message);
              return;
            }
            speechAction.audioId = audioId;
            speechAction.audioUrl = `${supabasePublicUrl}/storage/v1/object/public/courses/${storagePath}`;
            log.info(`TTS (${providerId}) uploaded: ${storagePath}`);
          } catch (err) {
            log.warn(`TTS generation failed for ${speechAction.id}:`, err);
          }
        }),
      );

      return updatedScene;
    }),
  );
}

// ---------------------------------------------------------------------------
// Activity 8: Send completion notification (in-app + email)
// ---------------------------------------------------------------------------

export interface SendCompletionNotificationParams {
  userId: string;
  userEmail?: string;
  jobId: string;
  classroomId: string;
  classroomUrl: string;
  requirementSnippet: string;
}

export async function sendCompletionNotificationActivity(
  params: SendCompletionNotificationParams,
): Promise<void> {
  const { userId, userEmail, jobId, classroomId, classroomUrl, requirementSnippet } = params;

  try {
    const admin = createAdminClient();

    // 1. Update classroom_jobs record
    await admin
      .from('classroom_jobs')
      .update({ status: 'succeeded', classroom_id: classroomId, classroom_url: classroomUrl })
      .eq('temporal_id', jobId);

    // 2. Insert in-app notification
    await admin.from('notifications').insert({
      user_id: userId,
      type: 'classroom_ready',
      title: 'Your classroom is ready!',
      body: `"${requirementSnippet}" has been generated and is ready to explore.`,
      action_url: classroomUrl,
      metadata: { classroom_id: classroomId, job_id: jobId },
    });

    log.info(`Notification created for user ${userId}, classroom ${classroomId}`);

    // 3. Send email if configured and email provided
    if (userEmail && process.env.SENDGRID_API_KEY && process.env.SENDER_EMAIL) {
      await sendEmailNotification({
        to: userEmail,
        subject: 'Your Slate classroom is ready!',
        html: buildClassroomReadyEmail({ requirementSnippet, classroomUrl }),
      });
    }
  } catch (err) {
    // Non-fatal — classroom is still generated even if notification fails
    log.warn('Failed to send completion notification:', err);
  }
}

async function sendEmailNotification(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const { to, subject, html } = params;
  const apiKey = process.env.SENDGRID_API_KEY!;
  const from = process.env.SENDER_EMAIL!;

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [{ type: 'text/html', value: html }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendGrid API error ${res.status}: ${body}`);
  }
}

function buildClassroomReadyEmail(params: {
  requirementSnippet: string;
  classroomUrl: string;
}): string {
  const { requirementSnippet, classroomUrl } = params;
  return `
    <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
      <h2 style="color: #073b4c;">Your classroom is ready! 🎓</h2>
      <p>Your Slate classroom based on <strong>"${requirementSnippet}…"</strong> has been generated and is ready to explore.</p>
      <a href="${classroomUrl}"
         style="display:inline-block;margin-top:16px;padding:12px 24px;background:#ef476f;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">
        Enter Classroom
      </a>
      <p style="margin-top:24px;color:#666;font-size:13px;">
        Powered by <strong>Slate Up</strong> — AI-powered interactive classrooms.
      </p>
    </div>
  `;
}
