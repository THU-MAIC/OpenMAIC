/**
 * Grok (xAI) Video Generation Adapter
 *
 * Async task pattern: submit → poll → return video URL.
 *
 * REST endpoints:
 * - Submit: POST /v1/videos/generations
 * - Poll:   GET  /v1/videos/{request_id}
 *
 * Supported models:
 * - grok-imagine-video  ($0.05/sec)
 *
 * Authentication: Bearer token via Authorization header
 *
 * API docs: https://docs.x.ai/developers/rest-api-reference/inference/videos
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'grok-imagine-video';
const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const POLL_INTERVAL_MS = 10_000; // 10 seconds
const MAX_POLL_ATTEMPTS = 60; // 10 minutes max

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dimension defaults per aspect ratio */
function getDimensions(aspectRatio?: string): {
  width: number;
  height: number;
} {
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

/** Common headers for all Grok Video API calls */
function apiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

// ---------------------------------------------------------------------------
// REST types
// ---------------------------------------------------------------------------

interface GrokVideoSubmitResponse {
  request_id: string;
}

interface GrokVideoPollResponse {
  status: string; // "pending" | "done" | "failed"
  progress?: number; // 0-100
  video?: {
    url: string;
    duration: number;
    respect_moderation?: boolean;
  };
  model?: string;
}

// ---------------------------------------------------------------------------
// Connectivity test
// ---------------------------------------------------------------------------

/**
 * Lightweight connectivity test — validates API key by making a minimal
 * request that triggers auth check. 401/403 means key invalid.
 */
export async function testGrokVideoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  try {
    const response = await fetch(`${baseUrl}/videos/generations`, {
      method: 'POST',
      headers: apiHeaders(config.apiKey),
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        prompt: '',
      }),
    });
    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `Grok Video auth failed (${response.status}): ${text}`,
      };
    }
    return { success: true, message: 'Connected to Grok Video' };
  } catch (err) {
    return { success: false, message: `Grok Video connectivity error: ${err}` };
  }
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function submitVideoGeneration(
  baseUrl: string,
  apiKey: string,
  model: string,
  options: VideoGenerationOptions,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    prompt: options.prompt,
  };

  if (options.duration) body.duration = options.duration;

  const response = await fetch(`${baseUrl}/videos/generations`, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Grok video submit failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as GrokVideoSubmitResponse;
  if (!data.request_id) {
    throw new Error('Grok video returned empty request_id');
  }

  return data.request_id;
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

async function pollVideoStatus(
  baseUrl: string,
  apiKey: string,
  requestId: string,
): Promise<GrokVideoPollResponse> {
  const response = await fetch(`${baseUrl}/videos/${requestId}`, {
    method: 'GET',
    headers: apiHeaders(apiKey),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Grok video poll failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<GrokVideoPollResponse>;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function generateWithGrokVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const model = config.model || DEFAULT_MODEL;
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  // 1. Submit
  const requestId = await submitVideoGeneration(baseUrl, config.apiKey, model, options);

  // 2. Poll until done
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await delay(POLL_INTERVAL_MS);
    const result = await pollVideoStatus(baseUrl, config.apiKey, requestId);

    if (result.status === 'done') {
      if (!result.video?.url) {
        throw new Error('Grok video task completed but no video URL returned');
      }
      const { width, height } = getDimensions(options.aspectRatio);
      return {
        url: result.video.url,
        duration: result.video.duration || options.duration || 6,
        width,
        height,
      };
    }

    if (result.status === 'failed') {
      throw new Error(`Grok video generation failed: ${JSON.stringify(result)}`);
    }
  }

  throw new Error(
    `Grok video generation timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s (request: ${requestId})`,
  );
}
