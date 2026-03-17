/**
 * Veo (Google) Video Generation Adapter
 *
 * Direct REST API calls for video generation with Google's Veo models.
 * Async task pattern: submit → poll → return inline base64 video.
 *
 * REST endpoints (Gemini API):
 * - Submit:   POST /v1beta/models/{model}:predictLongRunning
 * - Poll:     POST /v1beta/models/{model}:fetchPredictOperation  { operationName }
 *   Returns inline base64 video data in response.videos[]
 *
 * Supported models:
 * - veo-3.1-fast-generate-001  (fast, $0.15/sec)
 * - veo-3.1-generate-001       (quality, $0.40/sec)
 * - veo-3.0-fast-generate-001  (fast, $0.15/sec)
 * - veo-3.0-generate-001       (quality, $0.40/sec)
 * - veo-2.0-generate-001       (legacy, $0.50/sec)
 *
 * Authentication: x-goog-api-key header
 *
 * Stateless: video content is returned as a base64 data URL.
 * No files are saved on the server.
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'veo-3.0-generate-001';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
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

/** Common headers for all Veo API calls */
function apiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
}

// ---------------------------------------------------------------------------
// REST types (matches official Gemini API response format)
// ---------------------------------------------------------------------------

interface VeoOperation {
  name: string;
  done?: boolean;
  response?: {
    /** fetchPredictOperation returns inline base64 video data */
    videos?: Array<{
      bytesBase64Encoded?: string; // base64-encoded video bytes
      mimeType?: string; // e.g. "video/mp4"
    }>;
  };
  error?: { code: number; message: string; status: string };
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function submitVideoGeneration(
  baseUrl: string,
  apiKey: string,
  model: string,
  options: VideoGenerationOptions,
): Promise<VeoOperation> {
  const url = `${baseUrl}/v1beta/models/${model}:predictLongRunning`;

  const body: Record<string, unknown> = {
    instances: [{ prompt: options.prompt }],
  };

  // Parameters are optional — only include if we have values
  const parameters: Record<string, unknown> = {};
  if (options.aspectRatio) parameters.aspectRatio = options.aspectRatio;
  if (options.duration) parameters.durationSeconds = options.duration;
  if (Object.keys(parameters).length > 0) {
    body.parameters = parameters;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Veo submit failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<VeoOperation>;
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

async function pollOperation(
  baseUrl: string,
  apiKey: string,
  model: string,
  operationName: string,
): Promise<VeoOperation> {
  const url = `${baseUrl}/v1beta/models/${model}:fetchPredictOperation`;

  const response = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    body: JSON.stringify({ operationName }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Veo poll failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<VeoOperation>;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Lightweight connectivity test — validates API key by fetching model info.
 * Uses GET /v1beta/models/{model} which does not trigger generation.
 */
export async function testVeoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const model = config.model || DEFAULT_MODEL;
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const url = `${baseUrl}/v1beta/models`;

  // Try ?key= query param first (direct Google API), fall back to x-goog-api-key header (proxy)
  let response: Response | null = null;
  try {
    response = await fetch(`${url}?key=${config.apiKey}`, { method: 'GET' });
  } catch {
    // Direct API unreachable, try header auth
  }
  if (!response || !response.ok) {
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'x-goog-api-key': config.apiKey },
      });
    } catch (_err) {
      return {
        success: false,
        message: `Network error: unable to reach ${baseUrl}. Check your Base URL and network connection.`,
      };
    }
  }

  if (response.ok) {
    return { success: true, message: `Connected to Veo (${model})` };
  }

  // Parse error body for user-friendly message
  const text = await response.text().catch(() => '');
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return {
      success: false,
      message: `Invalid API key or unauthorized (${response.status}). Check your API Key and Base URL match the same provider.`,
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
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  // 1. Submit
  const operation = await submitVideoGeneration(baseUrl, config.apiKey, model, options);

  if (!operation.name) {
    throw new Error('Veo returned operation without name');
  }

  // 2. Poll until done
  let current = operation;
  let pollCount = 0;
  while (!current.done) {
    if (pollCount >= MAX_POLL_ATTEMPTS) {
      throw new Error('Veo video generation timed out after 10 minutes');
    }
    await delay(POLL_INTERVAL_MS);
    current = await pollOperation(baseUrl, config.apiKey, model, current.name);
    pollCount++;
  }

  // 3. Check for errors
  if (current.error) {
    throw new Error(`Veo generation failed: ${current.error.code} - ${current.error.message}`);
  }

  // 4. Extract inline base64 video from response.videos[]
  const videos = current.response?.videos;
  if (!videos || videos.length === 0) {
    throw new Error('Veo returned no generated videos');
  }

  const first = videos[0];
  if (!first.bytesBase64Encoded) {
    throw new Error('Veo returned video entry without data');
  }

  const base64 = first.bytesBase64Encoded;
  const mimeType = first.mimeType || 'video/mp4';

  const { width, height } = getDimensions(options.aspectRatio);

  return {
    url: `data:${mimeType};base64,${base64}`,
    duration: options.duration || 8,
    width,
    height,
  };
}
