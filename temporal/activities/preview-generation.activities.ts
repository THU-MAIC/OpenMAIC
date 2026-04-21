/**
 * Activities for the generateRemainingWorkflow.
 *
 * These activities handle the remaining scenes after generation-preview
 * has generated the first scene. TTS and media assets are uploaded to
 * Supabase Storage so they can be served on any device.
 */

import { Context } from '@temporalio/activity';
import { createAdminClient } from '@/utils/supabase/admin';
import { generateTTS } from '@/lib/audio/tts-providers';
import { generateImage } from '@/lib/media/image-providers';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import {
  DEFAULT_TTS_VOICES,
  DEFAULT_TTS_MODELS,
  TTS_PROVIDERS,
} from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import {
  getServerTTSProviders,
  getServerImageProviders,
  getServerVideoProviders,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
} from '@/lib/server/provider-config';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import { replaceAllCourseScenesInSupabase } from '@/lib/server/incremental-course-db-sync';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { SpeechAction } from '@/lib/types/action';
import type { TTSProviderId } from '@/lib/audio/types';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('PreviewGenerationActivity');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabasePublicUrl(bucket: string, storagePath: string): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set');
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${storagePath}`;
}

function isSupabaseConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Activity 1: Fetch existing scenes from Supabase (to seed the accumulation)
// ---------------------------------------------------------------------------

export async function fetchExistingScenesActivity(stageId: string): Promise<Scene[]> {
  if (!isSupabaseConfigured()) return [];

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from('scenes')
      .select('scene_id, type, title, order, content, actions, whiteboards')
      .eq('course_id', stageId)
      .order('order', { ascending: true });

    if (error) {
      log.warn('Failed to fetch existing scenes from Supabase:', error);
      return [];
    }

    return (data ?? []).map((row) => ({
      id: row.scene_id as string,
      stageId,
      type: row.type as Scene['type'],
      title: row.title as string,
      order: row.order as number,
      content: row.content as Scene['content'],
      actions: (row.actions as Scene['actions']) ?? [],
      whiteboards: (row.whiteboards as Scene['whiteboards']) ?? [],
    }));
  } catch (err) {
    log.warn('fetchExistingScenesActivity failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Activity 2: Generate TTS for a scene and upload audio to Supabase Storage
// ---------------------------------------------------------------------------

export interface GenerateSceneTTSParams {
  scene: Scene;
  stageId: string;
}

export async function generateSceneTTSToSupabaseActivity(
  params: GenerateSceneTTSParams,
): Promise<Scene> {
  const { scene, stageId } = params;

  if (!isSupabaseConfigured()) {
    log.warn('Supabase not configured — skipping TTS upload');
    return scene;
  }

  const ttsProviderIds = Object.keys(getServerTTSProviders()).filter(
    (id) => id !== 'browser-native-tts',
  );
  if (ttsProviderIds.length === 0) {
    log.warn('No server TTS provider — skipping TTS for scene:', scene.title);
    return scene;
  }

  const providerId = ttsProviderIds[0] as TTSProviderId;
  const apiKey = resolveTTSApiKey(providerId);
  if (!apiKey) {
    log.warn(`No API key for TTS provider "${providerId}" — skipping`);
    return scene;
  }

  const ttsBaseUrl = resolveTTSBaseUrl(providerId) || TTS_PROVIDERS[providerId]?.defaultBaseUrl;
  const voice = DEFAULT_TTS_VOICES[providerId] || 'default';
  const format = TTS_PROVIDERS[providerId]?.supportedFormats?.[0] || 'mp3';
  const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`;

  // Clone the scene deeply so we don't mutate the workflow state
  const updatedScene: Scene = JSON.parse(JSON.stringify(scene));

  if (!updatedScene.actions) return updatedScene;

  // Split long speech actions (mirrors client-side behaviour)
  updatedScene.actions = splitLongSpeechActions(updatedScene.actions, providerId);

  const supabase = createAdminClient();

  const speechActions = updatedScene.actions.filter(
    (a): a is SpeechAction => a.type === 'speech' && !!a.text,
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
          .upload(storagePath, result.audio, {
            contentType: mimeType,
            upsert: true,
          });

        if (error) {
          log.warn(`TTS upload failed for ${audioId}:`, error.message);
          return;
        }
        speechAction.audioId = audioId;
        speechAction.audioUrl = getSupabasePublicUrl('courses', storagePath);
        log.info(`TTS uploaded: ${storagePath} (${result.audio.length} bytes)`);
      } catch (err) {
        log.warn(`TTS generation/upload failed for action ${speechAction.id}:`, err);
      }
    }),
  );

  return updatedScene;
}

// ---------------------------------------------------------------------------
// Activity 3: Generate images/videos and upload to Supabase Storage
// ---------------------------------------------------------------------------

export interface GenerateMediaToSupabaseParams {
  scenes: Scene[];
  outlines: SceneOutline[];
  stageId: string;
}

export async function generateMediaToSupabaseActivity(
  params: GenerateMediaToSupabaseParams,
): Promise<Scene[]> {
  const { scenes, outlines, stageId } = params;

  if (!isSupabaseConfigured()) {
    log.warn('Supabase not configured — skipping media upload');
    return scenes;
  }

  const imageProviderIds = Object.keys(getServerImageProviders());
  const videoProviderIds = Object.keys(getServerVideoProviders());

  const requests = outlines.flatMap((o) => o.mediaGenerations ?? []);
  if (requests.length === 0) return scenes;

  const supabase = createAdminClient();
  const mediaMap: Record<string, string> = {};

  const imageRequests = requests.filter(
    (r) => r.type === 'image' && imageProviderIds.length > 0,
  );
  const videoRequests = requests.filter(
    (r) => r.type === 'video' && videoProviderIds.length > 0,
  );

  const generateImages = async () => {
    for (const req of imageRequests) {
      try {
        Context.current().heartbeat(`image:${req.elementId}`);
        const providerId = imageProviderIds[0] as ImageProviderId;
        const apiKey = resolveImageApiKey(providerId);
        if (!apiKey) continue;

        const providerConfig = IMAGE_PROVIDERS[providerId];
        const model = providerConfig?.models?.[0]?.id;

        const result = await generateImage(
          { providerId, apiKey, baseUrl: resolveImageBaseUrl(providerId), model },
          { prompt: req.prompt, aspectRatio: req.aspectRatio || '16:9' },
        );

        let buf: Buffer;
        let ext: string;
        if (result.base64) {
          buf = Buffer.from(result.base64, 'base64');
          ext = 'png';
        } else if (result.url) {
          buf = await downloadToBuffer(result.url);
          const urlExt = new URL(result.url).pathname.split('.').pop() || 'png';
          ext = ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt) ? urlExt : 'png';
        } else {
          continue;
        }

        const storagePath = `${stageId}/${req.elementId}.${ext}`;
        const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';

        const { error } = await supabase.storage
          .from('media')
          .upload(storagePath, buf, { contentType: mimeType, upsert: true });

        if (error) {
          log.warn(`Image upload failed for ${req.elementId}:`, error.message);
          continue;
        }

        mediaMap[req.elementId] = getSupabasePublicUrl('media', storagePath);
        log.info(`Image uploaded: ${storagePath}`);
      } catch (err) {
        log.warn(`Image generation/upload failed for ${req.elementId}:`, err);
      }
    }
  };

  const generateVideos = async () => {
    for (const req of videoRequests) {
      try {
        Context.current().heartbeat(`video:${req.elementId}`);
        const providerId = videoProviderIds[0] as VideoProviderId;
        const apiKey = resolveVideoApiKey(providerId);
        if (!apiKey) continue;

        const providerConfig = VIDEO_PROVIDERS[providerId];
        const model = providerConfig?.models?.[0]?.id;

        const normalized = normalizeVideoOptions(providerId, {
          prompt: req.prompt,
          aspectRatio: (req.aspectRatio as '16:9' | '4:3' | '1:1' | '9:16') || '16:9',
        });

        const result = await generateVideo(
          { providerId, apiKey, baseUrl: resolveVideoBaseUrl(providerId), model },
          normalized,
        );

        const buf = await downloadToBuffer(result.url);
        const storagePath = `${stageId}/${req.elementId}.mp4`;

        const { error } = await supabase.storage
          .from('media')
          .upload(storagePath, buf, { contentType: 'video/mp4', upsert: true });

        if (error) {
          log.warn(`Video upload failed for ${req.elementId}:`, error.message);
          continue;
        }

        mediaMap[req.elementId] = getSupabasePublicUrl('media', storagePath);
        log.info(`Video uploaded: ${storagePath}`);
      } catch (err) {
        log.warn(`Video generation/upload failed for ${req.elementId}:`, err);
      }
    }
  };

  await Promise.all([generateImages(), generateVideos()]);

  if (Object.keys(mediaMap).length === 0) return scenes;

  // Apply URLs to scene elements
  const updatedScenes: Scene[] = JSON.parse(JSON.stringify(scenes));
  for (const scene of updatedScenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: { elements?: Array<{ id: string; src?: string; type?: string }> };
      }
    )?.canvas;
    if (!canvas?.elements) continue;

    for (const el of canvas.elements) {
      if (
        (el.type === 'image' || el.type === 'video') &&
        typeof el.src === 'string' &&
        isMediaPlaceholder(el.src) &&
        mediaMap[el.src]
      ) {
        el.src = mediaMap[el.src];
      }
    }
  }

  return updatedScenes;
}

// ---------------------------------------------------------------------------
// Activity 4: Replace all scenes in Supabase (final sync)
// ---------------------------------------------------------------------------

export interface FinalizeCourseScenesParams {
  stage: Stage;
  scenes: Scene[];
  courseDescription?: string;
}

export async function finalizeCourseScenesActivity(
  params: FinalizeCourseScenesParams,
): Promise<void> {
  const { stage, scenes, courseDescription } = params;
  await replaceAllCourseScenesInSupabase({ stage, scenes, courseDescription });
}
