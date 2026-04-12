/**
 * Veo (Google) Video Generation Adapter
 *
 * Uses @ai-sdk/google provider + experimental_generateVideo from 'ai'.
 * The SDK handles the submit/poll lifecycle correctly against the Gemini API.
 *
 * Supported models (Gemini API, API key auth):
 * - veo-3.1-fast-generate-preview  (fast)
 * - veo-3.1-generate-preview       (quality)
 * - veo-3.1-generate               (stable)
 * - veo-3.0-fast-generate-001      (fast)
 * - veo-3.0-generate-001           (quality)
 * - veo-2.0-generate-001           (legacy)
 *
 * Authentication: Google AI Studio API key (x-goog-api-key)
 *
 * Stateless: video content is returned as a base64 data URL.
 * No files are saved on the server.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { experimental_generateVideo } from 'ai';
import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'veo-3.0-generate-001';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/** Dimension defaults per aspect ratio */
function getDimensions(aspectRatio?: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16':
      return { width: 720, height: 1280 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '4:3':
      return { width: 1024, height: 768 };
    default:
      return { width: 1280, height: 720 }; // 16:9
  }
}

/**
 * Lightweight connectivity test — validates API key by listing models.
 * Uses GET /v1beta/models?key=... which does not trigger generation.
 */
export async function testVeoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const model = config.model || DEFAULT_MODEL;
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const url = `${baseUrl}/v1beta/models?key=${config.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch {
    return {
      success: false,
      message: `Network error: unable to reach ${baseUrl}. Check your Base URL and network connection.`,
    };
  }

  if (response.ok) {
    return { success: true, message: `Connected to Veo (${model})` };
  }

  const text = await response.text().catch(() => '');
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return {
      success: false,
      message: `Invalid API key or unauthorized (${response.status}). Check your API Key and Base URL.`,
    };
  }
  return {
    success: false,
    message: `Veo connectivity failed (${response.status}): ${text}`,
  };
}

export async function generateWithVeo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const model = config.model || DEFAULT_MODEL;

  const google = createGoogleGenerativeAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  // Only Veo 3+ non-fast models expose the generateAudio parameter.
  // Fast variants and Veo 2.0 reject it at the API level, so we gate it.
  const supportsAudioParam = !model.includes('fast') && !model.startsWith('veo-2');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await experimental_generateVideo({
    model: google.video(model as Parameters<typeof google.video>[0]),
    prompt: options.prompt,
    ...(options.aspectRatio && { aspectRatio: options.aspectRatio as `${number}:${number}` }),
    ...(options.duration && { duration: options.duration }),
    // Disable audio generation on models that support it — audio is handled via TTS.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(supportsAudioParam && { providerOptions: { google: { generateAudio: false } } as any }),
  });

  const video = result.videos[0];
  if (!video) {
    throw new Error('Veo returned no generated videos');
  }

  // Convert to data URL — SDK may return base64, binary (Uint8Array) or URL
  let url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = video as any;
  if (v.base64) {
    url = `data:${v.mediaType ?? 'video/mp4'};base64,${v.base64}`;
  } else if (v.uint8Array) {
    const b64 = Buffer.from(v.uint8Array as Uint8Array).toString('base64');
    url = `data:${v.mediaType ?? 'video/mp4'};base64,${b64}`;
  } else if (v.url) {
    url = v.url as string;
  } else {
    throw new Error('Veo returned video in unexpected format');
  }

  const { width, height } = getDimensions(options.aspectRatio);
  return {
    url,
    duration: options.duration ?? 8,
    width,
    height,
  };
}
