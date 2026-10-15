/**
 * Server-side media and TTS generation for classrooms.
 *
 * Generates image/video files and TTS audio for a classroom,
 * writes them to disk, and returns serving URL mappings.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { generateImage } from '@/lib/media/image-providers';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import { generateTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_VOICES, DEFAULT_TTS_MODELS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import {
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
  resolveTTSModel,
} from '@/lib/server/provider-config';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { ImageProviderId } from '@/lib/media/types';
import type { VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { measureAudioDuration } from '@/lib/audio/audio-duration';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import { resolveImageSize } from '@/lib/server/image-sizing';
import { VOXCPM_AUTO_VOICE_ID, VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';

const log = createLogger('ClassroomMedia');

/**
 * The classroom JSON payload is a pre-conversion transport, not a persisted
 * DSL document. `audioUrl` is gone from the `SpeechAction` contract, but the
 * file-based classroom store has no asset registry to allocate from, so the
 * server still hands the client the serving URL beside the derived `audioId`.
 * The app-side reference converter ingests the URL's bytes and rewrites the
 * pair to one allocated asset id when the classroom is first fetched, before
 * the document is persisted client-side; the URL never enters a stored
 * document.
 */
type ServerTransportSpeechAction = SpeechAction & { audioUrl?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes
const DOWNLOAD_MAX_SIZE = 100 * 1024 * 1024; // 100 MB

async function downloadToBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > DOWNLOAD_MAX_SIZE) {
    throw new Error(`File too large: ${contentLength} bytes (max ${DOWNLOAD_MAX_SIZE})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function mediaServingUrl(baseUrl: string, classroomId: string, subPath: string): string {
  return `${baseUrl}/api/classroom-media/${classroomId}/${subPath}`;
}

// ---------------------------------------------------------------------------
// Image / Video generation
// ---------------------------------------------------------------------------

export async function generateMediaForClassroom(
  outlines: SceneOutline[],
  classroomId: string,
  baseUrl: string,
): Promise<Record<string, string>> {
  const mediaDir = path.join(CLASSROOMS_DIR, classroomId, 'media');
  await ensureDir(mediaDir);

  // Collect all media generation requests from outlines
  const requests = outlines.flatMap((o) => o.mediaGenerations ?? []);
  if (requests.length === 0) return {};

  // Resolve providers, excluding operator force-disabled ones (server
  // precedence, #665 — mirror the TTS listing's disabled flag).
  const imageProviderIds = Object.entries(getServerImageProviders())
    .filter(([, info]) => !info.disabled)
    .map(([id]) => id);
  const videoProviderIds = Object.entries(getServerVideoProviders())
    .filter(([, info]) => !info.disabled)
    .map(([id]) => id);

  const mediaMap: Record<string, string> = {};

  // Separate image and video requests, generate each type sequentially
  // but run the two types in parallel (providers often have limited concurrency).
  const imageRequests = requests.filter((r) => r.type === 'image' && imageProviderIds.length > 0);
  const videoRequests = requests.filter((r) => r.type === 'video' && videoProviderIds.length > 0);

  const generateImages = async () => {
    for (const req of imageRequests) {
      try {
        const providerId = imageProviderIds[0] as ImageProviderId;
        const apiKey = resolveImageApiKey(providerId);
        const providerConfig = IMAGE_PROVIDERS[providerId];
        if (providerConfig?.requiresApiKey && !apiKey) {
          log.warn(`No API key for image provider "${providerId}", skipping ${req.elementId}`);
          continue;
        }
        // No client model here — the server-side `IMAGE_<PREFIX>_MODELS` pin
        // (first entry) is authoritative when set; otherwise fall back to the
        // first catalog model so key-only deployments keep generating. This
        // path is internal (no HTTP response to fail loud with), so the
        // adapter's requireModel must stay a backstop, never the primary
        // failure mode.
        const model = resolveImageModel(providerId) ?? providerConfig?.models?.[0]?.id;

        const result = await generateImage(
          { providerId, apiKey, baseUrl: resolveImageBaseUrl(providerId), model },
          resolveImageSize(
            { prompt: req.prompt, aspectRatio: req.aspectRatio || '16:9' },
            { providerId, modelId: model },
          ),
        );

        let buf: Buffer;
        let ext: string;
        if (result.base64) {
          buf = Buffer.from(result.base64, 'base64');
          ext = 'png';
        } else if (result.url) {
          buf = await downloadToBuffer(result.url);
          const urlExt = path.extname(new URL(result.url).pathname).replace('.', '');
          ext = ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt) ? urlExt : 'png';
        } else {
          log.warn(`Image generation returned no data for ${req.elementId}`);
          continue;
        }

        const filename = `${req.elementId}.${ext}`;
        await fs.writeFile(path.join(mediaDir, filename), buf);
        mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
        log.info(`Generated image: ${filename}`);
      } catch (err) {
        log.warn(`Image generation failed for ${req.elementId}:`, err);
      }
    }
  };

  const generateVideos = async () => {
    for (const req of videoRequests) {
      try {
        const providerId = videoProviderIds[0] as VideoProviderId;
        const apiKey = resolveVideoApiKey(providerId);
        if (!apiKey) {
          log.warn(`No API key for video provider "${providerId}", skipping ${req.elementId}`);
          continue;
        }
        // No client model here — the server-side `VIDEO_<PREFIX>_MODELS` pin
        // (first entry) is authoritative when set; otherwise fall back to the
        // first catalog model so key-only deployments keep generating. This
        // path is internal (no HTTP response to fail loud with), so the
        // adapter's requireModel must stay a backstop, never the primary
        // failure mode.
        const providerConfig = VIDEO_PROVIDERS[providerId];
        const model = resolveVideoModel(providerId) ?? providerConfig?.models?.[0]?.id;

        const normalized = normalizeVideoOptions(providerId, {
          prompt: req.prompt,
          aspectRatio: (req.aspectRatio as '16:9' | '4:3' | '1:1' | '9:16') || '16:9',
        });

        const result = await generateVideo(
          { providerId, apiKey, baseUrl: resolveVideoBaseUrl(providerId), model },
          normalized,
        );

        const buf = await downloadToBuffer(result.url);
        const filename = `${req.elementId}.mp4`;
        await fs.writeFile(path.join(mediaDir, filename), buf);
        mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
        log.info(`Generated video: ${filename}`);
      } catch (err) {
        log.warn(`Video generation failed for ${req.elementId}:`, err);
      }
    }
  };

  await Promise.all([generateImages(), generateVideos()]);

  return mediaMap;
}

// ---------------------------------------------------------------------------
// Placeholder replacement in scene content
// ---------------------------------------------------------------------------

export function replaceMediaPlaceholders(scenes: Scene[], mediaMap: Record<string, string>): void {
  if (Object.keys(mediaMap).length === 0) return;

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: {
          elements?: Array<{ id: string; src?: string; mediaRef?: string; type?: string }>;
        };
      }
    )?.canvas;
    if (!canvas?.elements) continue;

    for (const el of canvas.elements) {
      if (
        el.type === 'video' &&
        typeof el.mediaRef === 'string' &&
        mediaMap[el.mediaRef] &&
        (!el.src || /^gen_vid_[\w-]+$/i.test(el.src))
      ) {
        el.src = mediaMap[el.mediaRef];
        continue;
      }
      if (
        (el.type === 'image' || el.type === 'video') &&
        typeof el.src === 'string' &&
        isGeneratedMediaPlaceholder(el.src) &&
        mediaMap[el.src]
      ) {
        el.src = mediaMap[el.src];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TTS generation
// ---------------------------------------------------------------------------

export type ClassroomTTSFailureReason =
  | 'provider-unavailable'
  | 'credentials-unavailable'
  | 'model-unavailable'
  | 'voice-context-required'
  | 'storage-unavailable'
  | 'invalid-speech'
  | 'synthesis-failed'
  | 'empty-audio'
  | 'invalid-audio'
  | 'storage-failed'
  | 'cancelled'
  | 'timeout';

export interface ClassroomTTSReport {
  status: 'completed' | 'partial' | 'unavailable' | 'skipped';
  ready: boolean;
  required: boolean;
  /** Number of speech actions supplied to this call before internal splitting. */
  inputSpeechCount: number;
  /** Counts refer to the final speech actions, including split chunks. */
  total: number;
  succeeded: number;
  failed: number;
  providerId?: TTSProviderId;
  modelId?: string;
  reason?: ClassroomTTSFailureReason | 'no-speech' | 'incomplete';
  failures: Array<{
    sceneId: string;
    actionId: string;
    reason: ClassroomTTSFailureReason;
  }>;
}

export class ClassroomTTSGenerationError extends Error {
  readonly code = 'CLASSROOM_TTS_REQUIRED_INCOMPLETE';

  constructor(readonly report: ClassroomTTSReport) {
    super('Required classroom speech audio is incomplete');
    this.name = 'ClassroomTTSGenerationError';
  }
}

function firstClassroomTTSProvider(): TTSProviderId | undefined {
  return Object.entries(getServerTTSProviders())
    .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
    .map(([id]) => id as TTSProviderId)[0];
}

function splitClassroomSpeech(scenes: Scene[], providerId: TTSProviderId): void {
  for (const scene of scenes) {
    if (!scene.actions) continue;
    // Keep malformed speech for explicit failure accounting, never stringify it.
    scene.actions = scene.actions.flatMap((action) =>
      action.type === 'speech' && typeof action.text === 'string'
        ? splitLongSpeechActions([action], providerId)
        : [action],
    );
  }
}

/** Prepare the same speech chunks before factual review; no synthesis or I/O. */
export function prepareClassroomSpeechForTTS(scenes: Scene[]): void {
  const providerId = firstClassroomTTSProvider();
  if (providerId) splitClassroomSpeech(scenes, providerId);
}

export async function generateTTSForClassroom(
  scenes: Scene[],
  classroomId: string,
  baseUrl: string,
  options: { required?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ClassroomTTSReport> {
  const speechEntries = () =>
    scenes.flatMap((scene) =>
      (scene.actions || [])
        .filter((action) => action.type === 'speech')
        .map((action) => ({ scene, action: action as ServerTransportSpeechAction })),
    );
  const report: ClassroomTTSReport = {
    status: 'unavailable',
    ready: false,
    required: options.required === true,
    inputSpeechCount: speechEntries().length,
    total: speechEntries().length,
    succeeded: 0,
    failed: 0,
    failures: [],
  };
  const settled = new Set<ServerTransportSpeechAction>();
  // AIOJ-required speech gets one bounded budget for the whole batch.
  // Optional legacy callers retain their existing behavior unless they opt in.
  const requestedTimeout = options.timeoutMs ?? (report.required ? 180_000 : undefined);
  const localTimeout =
    requestedTimeout === undefined
      ? undefined
      : AbortSignal.timeout(
          Number.isFinite(requestedTimeout) && requestedTimeout > 0
            ? Math.min(180_000, Math.max(1, Math.floor(requestedTimeout)))
            : 180_000,
        );
  const signals = [options.signal, localTimeout].filter((value): value is AbortSignal => !!value);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const finish = () => {
    if (!report.ready) {
      // Do not log provider error objects or narration/student/voice-sample text.
      log.warn('Classroom speech audio is not complete', {
        required: report.required,
        total: report.total,
        succeeded: report.succeeded,
        failed: report.failed,
        reason: report.reason,
      });
      if (report.required) throw new ClassroomTTSGenerationError(report);
    }
    return report;
  };
  const throwIfCancelled = () => {
    if (!signal?.aborted) return;
    // Caller cancellation wins over the local batch deadline when both fired.
    const callerAborted = options.signal?.aborted === true;
    const reason = callerAborted
      ? options.signal?.reason?.name === 'TimeoutError'
        ? 'timeout'
        : 'cancelled'
      : 'timeout';
    for (const { scene, action } of speechEntries()) {
      if (settled.has(action)) continue;
      delete action.audioId;
      delete action.audioUrl;
      action.audioInvalidated = true;
      report.failed += 1;
      report.failures.push({ sceneId: scene.id, actionId: action.id, reason });
      settled.add(action);
    }
    report.ready = false;
    report.status = report.succeeded ? 'partial' : 'unavailable';
    report.reason = reason;
    finish();
    throw new DOMException(
      'Classroom speech synthesis was cancelled',
      reason === 'timeout' ? 'TimeoutError' : 'AbortError',
    );
  };
  const blocked = (reason: ClassroomTTSFailureReason) => {
    throwIfCancelled();
    report.reason = reason;
    report.failed = report.total;
    report.failures = speechEntries().map(({ scene, action }) => ({
      sceneId: scene.id,
      actionId: action.id,
      reason,
    }));
    return finish();
  };
  throwIfCancelled();
  if (!report.total) {
    report.status = report.required ? 'unavailable' : 'skipped';
    report.reason = 'no-speech';
    return finish();
  }

  const providerId = firstClassroomTTSProvider();
  if (!providerId) return blocked('provider-unavailable');
  report.providerId = providerId;
  const apiKey = resolveTTSApiKey(providerId);
  const ttsProvider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (ttsProvider?.requiresApiKey && !apiKey) return blocked('credentials-unavailable');
  const ttsBaseUrl = resolveTTSBaseUrl(providerId) || ttsProvider?.defaultBaseUrl;
  const voice = DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || 'default';
  const format = ttsProvider?.supportedFormats?.[0] || 'mp3';
  if (providerId === VOXCPM_TTS_PROVIDER_ID && voice === VOXCPM_AUTO_VOICE_ID)
    return blocked('voice-context-required');

  let modelId: string;
  try {
    // Undefined means unconfigured; an explicitly empty resolver result is not a fallback pin.
    modelId =
      resolveTTSModel(providerId, undefined, voice) ??
      DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] ??
      '';
  } catch {
    return blocked('model-unavailable');
  }
  if (!modelId && ttsProvider?.models?.length) return blocked('model-unavailable');
  report.modelId = modelId;
  throwIfCancelled();
  splitClassroomSpeech(scenes, providerId);
  report.total = speechEntries().length;
  throwIfCancelled();

  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  try {
    throwIfCancelled();
    await ensureDir(audioDir);
    throwIfCancelled();
  } catch {
    throwIfCancelled();
    return blocked('storage-unavailable');
  }

  for (const { scene, action } of speechEntries()) {
    throwIfCancelled();
    // A failed attempt must not leave stale audio references for different text.
    delete action.audioId;
    delete action.audioUrl;
    action.audioInvalidated = true;
    const fail = (reason: ClassroomTTSFailureReason) => {
      report.failed += 1;
      report.failures.push({ sceneId: scene.id, actionId: action.id, reason });
      settled.add(action);
    };
    if (typeof action.text !== 'string' || !action.text.trim()) {
      fail('invalid-speech');
      continue;
    }
    let result: Awaited<ReturnType<typeof generateTTS>>;
    try {
      throwIfCancelled();
      result = await generateTTS(
        { providerId, modelId, apiKey, baseUrl: ttsBaseUrl, voice, speed: action.speed, signal },
        action.text,
      );
      throwIfCancelled();
    } catch {
      throwIfCancelled();
      fail('synthesis-failed');
      continue;
    }
    if (!(result?.audio instanceof Uint8Array) || !result.audio.byteLength) {
      fail('empty-audio');
      continue;
    }
    const audioId = `tts_s${scene.order}_${action.id}`;
    const audioFormat = result.format || format;
    if (!/^[a-z0-9]{1,12}$/i.test(audioFormat)) {
      fail('invalid-audio');
      continue;
    }
    // Required audio must be measurable encoded audio, not a JSON/text error body.
    // This reuses the existing WAV/MP3 container parser, not a playback/fidelity claim.
    if (report.required) {
      const duration = measureAudioDuration(result.audio, audioFormat);
      if (duration === null || !Number.isFinite(duration) || duration <= 0) {
        fail('invalid-audio');
        continue;
      }
    }
    const filename = `${audioId}.${audioFormat}`;
    try {
      throwIfCancelled();
      await fs.writeFile(path.join(audioDir, filename), result.audio, { signal });
      throwIfCancelled();
    } catch {
      throwIfCancelled();
      fail('storage-failed');
      continue;
    }
    action.audioId = audioId;
    action.audioUrl = mediaServingUrl(baseUrl, classroomId, `audio/${filename}`);
    delete action.audioInvalidated;
    report.succeeded += 1;
    settled.add(action);
  }
  throwIfCancelled();
  report.ready = report.total > 0 && report.succeeded === report.total && report.failed === 0;
  report.status = report.ready ? 'completed' : report.succeeded ? 'partial' : 'unavailable';
  if (!report.ready) report.reason = 'incomplete';
  return finish();
}
