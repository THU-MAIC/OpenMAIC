import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { DEFAULT_TTS_VOICES } from '@/lib/audio/constants';
import { generateTTS } from '@/lib/audio/tts-providers';
import type { TTSProviderId } from '@/lib/audio/types';
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
import { createLogger } from '@/lib/logger';
import { generateImage } from '@/lib/media/image-providers';
import type { ImageProviderId, MediaGenerationRequest } from '@/lib/media/types';
import { parseModelString } from '@/lib/ai/providers';
import {
  resolveApiKey,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { persistClassroom } from '@/lib/server/classroom-storage';
import { saveMedia, mediaExists } from '@/lib/server/media-storage';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import type { SpeechAction } from '@/lib/types/action';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

const log = createLogger('Classroom');

export interface GenerateClassroomInput {
  requirement: string;
  pdfContent?: { text: string; images: string[] };
  language?: string;
  stageName?: string;
  modelString?: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
  requiresApiKey?: boolean;
  imageGenerationEnabled?: boolean;
  imageProviderId?: ImageProviderId;
  imageModel?: string;
  imageApiKey?: string;
  imageBaseUrl?: string;
  ttsEnabled?: boolean;
  ttsProviderId?: TTSProviderId;
  ttsVoice?: string;
  ttsSpeed?: number;
  ttsApiKey?: string;
  ttsBaseUrl?: string;
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
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

interface ResolvedImageGenerationConfig {
  providerId: ImageProviderId;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

interface ResolvedTTSGenerationConfig {
  providerId: Exclude<TTSProviderId, 'browser-native-tts'>;
  apiKey: string;
  baseUrl?: string;
  voice: string;
  speed: number;
}

function assertSafeClientBaseUrl(baseUrl?: string): void {
  if (!baseUrl || process.env.NODE_ENV !== 'production') return;
  const ssrfError = validateUrlForSSRF(baseUrl);
  if (ssrfError) {
    throw new Error(ssrfError);
  }
}

function extractStageNameFromRequirement(requirement: string): string | undefined {
  const patterns = [
    /【(?:章节|课堂|课程)标题】\s*([^\n]+)/u,
    /(?:章节|课堂|课程)标题[:：]\s*([^\n]+)/u,
  ];

  for (const pattern of patterns) {
    const match = requirement.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

function resolveStageName(
  input: GenerateClassroomInput,
  requirement: string,
  outlines: SceneOutline[],
): string {
  return (
    input.stageName?.trim() ||
    extractStageNameFromRequirement(requirement) ||
    outlines[0]?.title ||
    requirement.slice(0, 50)
  );
}

function resolveImageGenerationConfig(
  input: GenerateClassroomInput,
): ResolvedImageGenerationConfig | null {
  if (input.imageGenerationEnabled === false) return null;

  const providerId = input.imageProviderId || 'seedream';
  assertSafeClientBaseUrl(input.imageBaseUrl);

  const clientApiKey = input.imageApiKey?.trim() || undefined;
  const apiKey = input.imageBaseUrl
    ? clientApiKey || ''
    : resolveImageApiKey(providerId, clientApiKey);

  if (!apiKey) {
    const explicitlyConfigured = !!(
      input.imageProviderId ||
      input.imageApiKey ||
      input.imageBaseUrl ||
      input.imageModel
    );
    if (explicitlyConfigured) {
      throw new Error(`No API key configured for image provider: ${providerId}`);
    }
    return null;
  }

  return {
    providerId,
    apiKey,
    baseUrl: input.imageBaseUrl
      ? input.imageBaseUrl
      : resolveImageBaseUrl(providerId, input.imageBaseUrl),
    model: input.imageModel,
  };
}

function resolveTTSGenerationConfig(
  input: GenerateClassroomInput,
): ResolvedTTSGenerationConfig | null {
  if (input.ttsEnabled === false) return null;

  const providerId = (input.ttsProviderId || 'qwen-tts') as TTSProviderId;
  if (providerId === 'browser-native-tts') return null;

  assertSafeClientBaseUrl(input.ttsBaseUrl);

  const clientApiKey = input.ttsApiKey?.trim() || undefined;
  const apiKey = input.ttsBaseUrl ? clientApiKey || '' : resolveTTSApiKey(providerId, clientApiKey);

  if (!apiKey) {
    const explicitlyConfigured = !!(
      input.ttsProviderId ||
      input.ttsApiKey ||
      input.ttsBaseUrl ||
      input.ttsVoice ||
      input.ttsSpeed !== undefined
    );
    if (explicitlyConfigured) {
      throw new Error(`No API key configured for TTS provider: ${providerId}`);
    }
    return null;
  }

  return {
    providerId,
    apiKey,
    baseUrl: input.ttsBaseUrl ? input.ttsBaseUrl : resolveTTSBaseUrl(providerId, input.ttsBaseUrl),
    voice: input.ttsVoice?.trim() || DEFAULT_TTS_VOICES[providerId],
    speed: input.ttsSpeed ?? 1.0,
  };
}

function collectImageRequests(outlines: SceneOutline[]): MediaGenerationRequest[] {
  const requests: MediaGenerationRequest[] = [];
  const seen = new Set<string>();

  for (const outline of outlines) {
    for (const request of outline.mediaGenerations || []) {
      if (request.type !== 'image' || seen.has(request.elementId)) continue;
      seen.add(request.elementId);
      requests.push(request);
    }
  }

  return requests;
}

function isSpeechAction(
  action: NonNullable<Scene['actions']>[number] | undefined,
): action is SpeechAction {
  return !!action && action.type === 'speech' && typeof action.text === 'string' && action.text.trim().length > 0;
}

function inferImageExtension(contentType?: string | null, url?: string): string {
  const normalized = (contentType || '').toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';

  if (url) {
    const cleanUrl = url.split('?')[0] || url;
    const match = cleanUrl.match(/\.([a-zA-Z0-9]+)$/);
    if (match?.[1]) {
      const ext = match[1].toLowerCase();
      if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
        return ext === 'jpeg' ? 'jpg' : ext;
      }
    }
  }

  return 'png';
}

async function resolveGeneratedImageBuffer(
  result: Awaited<ReturnType<typeof generateImage>>,
): Promise<{ buffer: Buffer; ext: string }> {
  if (result.base64) {
    return { buffer: Buffer.from(result.base64, 'base64'), ext: 'png' };
  }

  if (!result.url) {
    throw new Error('Image generation returned no image payload');
  }

  const response = await fetch(result.url);
  if (!response.ok) {
    throw new Error(`Failed to download generated image (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    ext: inferImageExtension(response.headers.get('content-type'), result.url),
  };
}

async function generateClassroomMedia(
  stageId: string,
  outlines: SceneOutline[],
  scenes: Scene[],
  mediaConfig: {
    image: ResolvedImageGenerationConfig | null;
    tts: ResolvedTTSGenerationConfig | null;
  },
  onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void,
): Promise<void> {
  const imageConfig = mediaConfig.image;
  const ttsConfig = mediaConfig.tts;

  const imageRequests = imageConfig ? collectImageRequests(outlines) : [];
  const speechActions = ttsConfig
    ? scenes.flatMap((scene) =>
        (scene.actions || [])
          .filter(isSpeechAction)
          .map((action) => ({ sceneTitle: scene.title, action })),
      )
    : [];

  const totalItems = imageRequests.length + speechActions.length;
  if (totalItems === 0) return;

  let completedItems = 0;
  const reportProgress = async (message: string) => {
    const progress = totalItems > 0 ? 91 + Math.floor((completedItems / totalItems) * 3) : 94;
    await onProgress?.({
      step: 'generating_media',
      progress: Math.min(progress, 94),
      message,
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });
  };

  await reportProgress('Generating classroom media');

  if (imageConfig) {
    for (const request of imageRequests) {
      try {
        const existing = await mediaExists(stageId, request.elementId);
        if (!existing.exists) {
          const imageResult = await generateImage(imageConfig, {
            prompt: request.prompt,
            aspectRatio: request.aspectRatio,
            style: request.style,
          });
          const { buffer, ext } = await resolveGeneratedImageBuffer(imageResult);
          await saveMedia(stageId, request.elementId, buffer, ext);
          log.info(`Generated image media: ${request.elementId}`);
        }
      } catch (error) {
        log.warn(`Failed to generate image media "${request.elementId}":`, error);
      } finally {
        completedItems += 1;
        await reportProgress(`Generated media ${completedItems}/${totalItems}`);
      }
    }
  }

  if (ttsConfig) {
    for (const { sceneTitle, action } of speechActions) {
      const audioId = action.audioId || `tts_${action.id}`;
      try {
        const existing = await mediaExists(stageId, audioId);
        if (!existing.exists) {
          const audioResult = await generateTTS(
            {
              providerId: ttsConfig.providerId,
              apiKey: ttsConfig.apiKey,
              baseUrl: ttsConfig.baseUrl,
              voice: ttsConfig.voice,
              speed: ttsConfig.speed,
            },
            action.text,
          );
          await saveMedia(stageId, audioId, Buffer.from(audioResult.audio), audioResult.format);
          log.info(`Generated TTS media: ${audioId} (${sceneTitle})`);
        }
        action.audioId = audioId;
      } catch (error) {
        log.warn(`Failed to generate TTS media "${audioId}" (${sceneTitle}):`, error);
      } finally {
        completedItems += 1;
        await reportProgress(`Generated media ${completedItems}/${totalItems}`);
      }
    }
  }
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

  const { model: languageModel, modelInfo, modelString } = resolveModel({
    modelString: input.modelString,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    providerType: input.providerType,
    requiresApiKey: input.requiresApiKey,
  });
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  const { providerId } = parseModelString(modelString);
  const apiKey = input.baseUrl
    ? input.apiKey?.trim() || ''
    : resolveApiKey(providerId, input.apiKey?.trim() || '');
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Pass it in the request or set the appropriate key in .env.local / server-providers.yml ` +
        `(e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
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

  const lang = normalizeLanguage(input.language);
  const mediaConfig = {
    image: resolveImageGenerationConfig(input),
    tts: resolveTTSGenerationConfig(input),
  };
  const requirements: UserRequirements = {
    requirement,
    language: lang,
  };
  const pdfText = pdfContent?.text || undefined;

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
      imageGenerationEnabled: !!mediaConfig.image,
      videoGenerationEnabled: false,
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
    name: resolveStageName(input, requirement, outlines),
    description: undefined,
    language: lang,
    style: 'interactive',
    createdAt: Date.now(),
    updatedAt: Date.now(),
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

    const content = await generateSceneContent(safeOutline, aiCall);
    if (!content) {
      log.warn(`Skipping scene "${safeOutline.title}" — content generation failed`);
      continue;
    }

    const actions = await generateSceneActions(safeOutline, content, aiCall);
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

  await generateClassroomMedia(stageId, outlines, scenes, mediaConfig, options.onProgress);

  await options.onProgress?.({
    step: 'persisting',
    progress: 95,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  const persisted = await persistClassroom(
    {
      id: stageId,
      stage,
      scenes,
      outlines,
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
