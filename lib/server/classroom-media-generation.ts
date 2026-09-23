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
import { generateTTS, TTSRateLimitError } from '@/lib/audio/tts-providers';
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
} from '@/lib/server/provider-config';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { ImageProviderId } from '@/lib/media/types';
import type { VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
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

/**
 * File extension for the image types this path writes.
 *
 * It names the bytes on disk, so it has to follow the type the adapter reported
 * rather than a constant: a JPEG saved as `.png` is served back as the wrong
 * type. Anything unlisted keeps `png`, the extension this path used to write
 * for every inline image.
 */
const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

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
          // The adapter that received these bytes reports their type; the URL
          // branch below reads it off the response, and this branch has only
          // the adapter's word for it.
          ext = IMAGE_EXTENSION_BY_MIME[result.mimeType ?? ''] ?? 'png';
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

const DEFAULT_TTS_MIN_INTERVAL_MS = 0;
/** Back-off floor after a rate limit. Independent of `TTS_MIN_INTERVAL_MS`. */
const TTS_RATE_LIMIT_BACKOFF_FLOOR_MS = 1000;
const MAX_TTS_INTERVAL_MS = 15_000;
const MAX_TTS_RATE_LIMIT_RETRIES = 5;
/** Cumulative rate-limit sleep budget for one classroom TTS phase. */
const DEFAULT_TTS_BACKOFF_BUDGET_MS = 120_000;

/** Classroom TTS request spacing. Unset or invalid values fall back to 0. */
function readTtsMinIntervalMs(): number {
  const raw = process.env.TTS_MIN_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_TTS_MIN_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTS_MIN_INTERVAL_MS;
}

/** Total rate-limit back-off budget. Unset or invalid values fall back to 120000ms. `0` disables further waits. */
function readTtsBackoffBudgetMs(): number {
  const raw = process.env.TTS_BACKOFF_BUDGET_MS?.trim();
  if (!raw) return DEFAULT_TTS_BACKOFF_BUDGET_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTS_BACKOFF_BUDGET_MS;
}

/**
 * Next spacing after a rate limit. A configured interval of 0 must not stay 0:
 * the delay starts at 2× {@link TTS_RATE_LIMIT_BACKOFF_FLOOR_MS} and doubles
 * up to {@link MAX_TTS_INTERVAL_MS}.
 */
function widenTtsSpacing(currentMs: number): number {
  if (currentMs >= MAX_TTS_INTERVAL_MS) return currentMs;
  const base = Math.max(currentMs, TTS_RATE_LIMIT_BACKOFF_FLOOR_MS);
  return Math.min(base * 2, MAX_TTS_INTERVAL_MS);
}

/**
 * Step spacing halfway back toward the configured base.
 * A non-positive success streak leaves spacing unchanged; rate limits reset that streak.
 */
function decayTtsSpacing(currentMs: number, baseMs: number, consecutiveSuccesses: number): number {
  if (consecutiveSuccesses <= 0 || currentMs <= baseMs) return Math.max(currentMs, baseMs);
  return baseMs + Math.floor((currentMs - baseMs) / 2);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Narratable speech clips currently stored on `scenes`.
 * Pass `providerId` to split long lines the same way synthesis does before counting.
 * That split is applied in place so a skipped run and a generated run agree.
 * With no provider there is no length limit, so the stored actions are counted as-is.
 */
export function countNarratableSpeechActions(scenes: Scene[], providerId?: TTSProviderId): number {
  if (providerId) {
    for (const scene of scenes) {
      if (!scene.actions) continue;
      scene.actions = splitLongSpeechActions(scene.actions, providerId);
    }
  }
  let total = 0;
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech' && (action as SpeechAction).text) total += 1;
    }
  }
  return total;
}

/**
 * TTS was requested but synthesis never started.
 * Coverage stays at zero written clips so the job is not a clean success.
 */
function skippedTtsCoverage(
  scenes: Scene[],
  reason: string,
  providerId?: TTSProviderId,
): ClassroomTtsCoverage {
  const coverage: ClassroomTtsCoverage = {
    written: 0,
    total: countNarratableSpeechActions(scenes, providerId),
  };
  log.warn(reason);
  if (coverage.written < coverage.total)
    log.error(classroomTtsSummary(coverage.written, coverage.total));
  return coverage;
}

export interface ClassroomTtsCoverage {
  written: number;
  total: number;
}

/** Loud one-line summary for a classroom TTS run. */
export function classroomTtsSummary(written: number, total: number): string {
  const silent = total - written;
  if (silent <= 0) return `TTS generation complete: ${written} clips written`;
  return `TTS generation INCOMPLETE: ${written} written, ${silent} speech actions left silent`;
}

/** Clip counts emitted while classroom TTS is still running. */
export interface ClassroomTtsProgress {
  written: number;
  total: number;
}

/**
 * Synthesize narration for every speech clip.
 * `signal` rejects an in-flight wait when a caller supplies one. The classroom
 * job runner does not supply one.
 * `onProgress` reports clip counts so a long run can refresh job liveness.
 */
export async function generateTTSForClassroom(
  scenes: Scene[],
  classroomId: string,
  baseUrl: string,
  signal?: AbortSignal,
  onProgress?: (progress: ClassroomTtsProgress) => void | Promise<void>,
): Promise<ClassroomTtsCoverage> {
  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  await ensureDir(audioDir);

  // Resolve TTS provider (exclude browser-native-tts and operator force-disabled
  // providers — server precedence, #665).
  const ttsProviderIds = Object.entries(getServerTTSProviders())
    .filter(([id, info]) => id !== 'browser-native-tts' && !info.disabled)
    .map(([id]) => id);
  if (ttsProviderIds.length === 0) {
    return skippedTtsCoverage(scenes, 'No server TTS provider configured, skipping TTS generation');
  }

  const providerId = ttsProviderIds[0] as TTSProviderId;
  const apiKey = resolveTTSApiKey(providerId);
  const ttsProvider = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (ttsProvider?.requiresApiKey && !apiKey) {
    return skippedTtsCoverage(
      scenes,
      `No API key for TTS provider "${providerId}", skipping TTS generation`,
      providerId,
    );
  }
  const ttsBaseUrl = resolveTTSBaseUrl(providerId) || ttsProvider?.defaultBaseUrl;
  const voice = DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES] || 'default';
  const format = ttsProvider?.supportedFormats?.[0] || 'mp3';
  if (providerId === VOXCPM_TTS_PROVIDER_ID && voice === VOXCPM_AUTO_VOICE_ID) {
    return skippedTtsCoverage(
      scenes,
      'VoxCPM Auto Voice requires agent context; skipping server-side TTS generation',
      providerId,
    );
  }

  const baseSpacingMs = readTtsMinIntervalMs();
  let spacingMs = baseSpacingMs;
  let consecutiveSuccesses = 0;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  // Full delay for the next attempt after a rate limit. Unlike successful-call
  // pacing, this is not reduced by how long the failed request itself took.
  let pendingBackoffMs = 0;
  let backoffSpentMs = 0;
  const backoffBudgetMs = readTtsBackoffBudgetMs();
  let budgetExhausted = false;
  let written = 0;
  const total = countNarratableSpeechActions(scenes, providerId);

  const waitForTtsSlot = async () => {
    signal?.throwIfAborted();
    const pacingWaitMs = spacingMs - (Date.now() - lastStartedAt);
    const waitMs = pendingBackoffMs > 0 ? pendingBackoffMs : pacingWaitMs;
    pendingBackoffMs = 0;
    if (waitMs > 0) await sleep(waitMs, signal);
    lastStartedAt = Date.now();
  };

  const emitTtsProgress = async () => {
    await onProgress?.({ written, total });
  };

  for (const scene of scenes) {
    if (!scene.actions) continue;

    // Use scene order to make audio IDs unique across scenes
    const sceneOrder = scene.order;

    for (const action of scene.actions) {
      signal?.throwIfAborted();
      if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
      const speechAction = action as ServerTransportSpeechAction;
      // Server transport emits the derived id plus the serving URL; the
      // client-side converter collapses the pair into one pool asset on
      // first load. Browser generation allocates pool ids directly.
      const audioId = `tts_s${sceneOrder}_${action.id}`;
      if (budgetExhausted) {
        log.warn(`TTS back-off budget exhausted; leaving ${audioId} silent`);
        await emitTtsProgress();
        continue;
      }
      let rateLimitRetries = 0;

      while (true) {
        await waitForTtsSlot();
        try {
          const result = await generateTTS(
            {
              providerId,
              modelId: DEFAULT_TTS_MODELS[providerId as keyof typeof DEFAULT_TTS_MODELS] || '',
              apiKey,
              baseUrl: ttsBaseUrl,
              voice,
              speed: speechAction.speed,
              signal,
            },
            speechAction.text,
          );

          const filename = `${audioId}.${result.format || format}`;
          await fs.writeFile(path.join(audioDir, filename), result.audio);

          speechAction.audioId = audioId;
          speechAction.audioUrl = mediaServingUrl(baseUrl, classroomId, `audio/${filename}`);
          written += 1;
          consecutiveSuccesses += 1;
          spacingMs = decayTtsSpacing(spacingMs, baseSpacingMs, consecutiveSuccesses);
          log.info(`Generated TTS: ${filename} (${result.audio.length} bytes)`);
          break;
        } catch (err) {
          if (isAbortError(err) || signal?.aborted) {
            throw isAbortError(err) ? err : new DOMException('Aborted', 'AbortError');
          }
          if (err instanceof TTSRateLimitError && rateLimitRetries < MAX_TTS_RATE_LIMIT_RETRIES) {
            const nextSpacingMs = widenTtsSpacing(spacingMs);
            const retryAfterMs = err.retryAfterMs ?? 0;
            const delayMs = Math.max(nextSpacingMs, retryAfterMs);
            consecutiveSuccesses = 0;
            const remainingBudgetMs = backoffBudgetMs - backoffSpentMs;
            // A single huge Retry-After must not silence every later clip.
            if (retryAfterMs > remainingBudgetMs) {
              spacingMs = nextSpacingMs;
              log.warn(
                `TTS Retry-After ${retryAfterMs}ms exceeds remaining back-off budget for ${audioId}; leaving this clip silent and widening spacing to ${spacingMs}ms`,
              );
              break;
            }
            if (backoffSpentMs + delayMs > backoffBudgetMs) {
              budgetExhausted = true;
              log.warn(
                `TTS back-off budget exhausted for ${audioId}; leaving remaining speech silent`,
              );
              break;
            }
            backoffSpentMs += delayMs;
            rateLimitRetries += 1;
            spacingMs = nextSpacingMs;
            pendingBackoffMs = delayMs;
            log.warn(
              `TTS rate limited for ${audioId}; widening spacing to ${spacingMs}ms (retry ${rateLimitRetries}/${MAX_TTS_RATE_LIMIT_RETRIES})`,
            );
            continue;
          }
          if (err instanceof TTSRateLimitError) {
            log.warn(`TTS rate limit retries exhausted for ${audioId}; leaving speech silent`);
          } else {
            log.warn(`TTS generation failed for action ${action.id}:`, err);
          }
          break;
        }
      }
      await emitTtsProgress();
    }
  }

  const summary = classroomTtsSummary(written, total);
  if (written < total) log.error(summary);
  else log.info(summary);
  return { written, total };
}
