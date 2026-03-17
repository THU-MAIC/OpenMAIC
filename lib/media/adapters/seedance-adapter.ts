/**
 * Seedance (ByteDance / Doubao / Ark) Video Generation Adapter
 *
 * Uses async task pattern: submit task → poll until succeeded → get video URL.
 * Endpoint: https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
 *
 * Request format (text-to-video):
 *   POST /api/v3/contents/generations/tasks
 *   {
 *     "model": "doubao-seedance-1-5-pro-251215",
 *     "content": [{ "type": "text", "text": "prompt here" }],
 *     "ratio": "16:9",
 *     "duration": 5,
 *     "resolution": "1080p",
 *     "watermark": false
 *   }
 *
 * Supported models:
 * - doubao-seedance-1-5-pro-251215     (latest, 4~12s)
 * - doubao-seedance-1-0-pro-250528     (stable, 2~12s)
 * - doubao-seedance-1-0-pro-fast-251015 (faster, 2~12s)
 * - doubao-seedance-1-0-lite-t2v-250428 (lightweight, 2~12s)
 *
 * API docs: https://www.volcengine.com/docs/6492/2165104
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'doubao-seedance-1-5-pro-251215';
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 60; // 5 minutes max

/** Response shape for task creation (only returns id) */
interface SeedanceSubmitResponse {
  id: string;
}

/** Response shape for task polling */
interface SeedancePollResponse {
  id: string;
  model: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | string;
  content?: {
    video_url?: string;
  };
  resolution?: string;
  ratio?: string;
  duration?: number;
  framespersecond?: number;
  error?: {
    message: string;
    code?: string;
  };
}

/**
 * Map aspect ratio to Seedance ratio format.
 * Seedance uses the same "W:H" format we already have.
 */
function toSeedanceRatio(aspectRatio?: string): string | undefined {
  if (!aspectRatio) return undefined;
  return aspectRatio; // Already in "16:9" format
}

/**
 * Map resolution to Seedance format.
 * Seedance expects "480p", "720p", "1080p".
 */
function toSeedanceResolution(resolution?: string): string | undefined {
  if (!resolution) return undefined;
  return resolution; // Already in "720p" format
}

/**
 * Estimate video dimensions from ratio and resolution for the result.
 */
function estimateDimensions(
  ratio?: string,
  resolution?: string,
): { width: number; height: number } {
  const resMap: Record<string, number> = {
    '480p': 480,
    '720p': 720,
    '1080p': 1080,
  };
  const h = resMap[resolution || '720p'] || 720;

  if (!ratio) return { width: Math.round((h * 16) / 9), height: h };
  const [w, hRatio] = ratio.split(':').map(Number);
  if (!w || !hRatio) return { width: Math.round((h * 16) / 9), height: h };
  return { width: Math.round((h * w) / hRatio), height: h };
}

/**
 * Submit a video generation task to Seedance API.
 * Returns the task ID for polling.
 */
/**
 * Lightweight connectivity test — validates API key by making a GET request
 * to poll a non-existent task. If auth fails we get 401/403; if auth succeeds
 * we get 404 (task not found), confirming the key is valid.
 */
export async function testSeedanceConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  try {
    const response = await fetch(
      `${baseUrl}/api/v3/contents/generations/tasks/connectivity-test-nonexistent`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.apiKey}` },
      },
    );
    // 401/403 means key invalid; anything else (404, 400, 200) means key works
    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `Seedance auth failed (${response.status}): ${text}`,
      };
    }
    return { success: true, message: 'Connected to Seedance' };
  } catch (err) {
    return { success: false, message: `Seedance connectivity error: ${err}` };
  }
}

export async function submitSeedanceTask(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<string> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  const body: Record<string, unknown> = {
    model: config.model || DEFAULT_MODEL,
    content: [
      {
        type: 'text',
        text: options.prompt,
      },
    ],
    watermark: false,
  };

  const ratio = toSeedanceRatio(options.aspectRatio);
  if (ratio) body.ratio = ratio;

  if (options.duration) body.duration = options.duration;

  const resolution = toSeedanceResolution(options.resolution);
  if (resolution) body.resolution = resolution;

  const response = await fetch(`${baseUrl}/api/v3/contents/generations/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Seedance task submission failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as SeedanceSubmitResponse;
  if (!data.id) {
    throw new Error('Seedance returned empty task ID');
  }

  return data.id;
}

/**
 * Poll the status of a Seedance video generation task.
 * Returns the result if complete, null if still running.
 * Throws on failure.
 */
export async function pollSeedanceTask(
  config: VideoGenerationConfig,
  taskId: string,
): Promise<VideoGenerationResult | null> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  const response = await fetch(`${baseUrl}/api/v3/contents/generations/tasks/${taskId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Seedance poll failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as SeedancePollResponse;

  if (data.status === 'succeeded') {
    if (!data.content?.video_url) {
      throw new Error('Seedance task succeeded but no video URL returned');
    }
    const dims = estimateDimensions(data.ratio, data.resolution);
    return {
      url: data.content.video_url,
      duration: data.duration || 5,
      width: dims.width,
      height: dims.height,
    };
  }

  if (data.status === 'failed') {
    throw new Error(`Seedance video generation failed: ${data.error?.message || 'Unknown error'}`);
  }

  // queued or running
  return null;
}

/**
 * Generate a video using Seedance: submit task + poll until complete.
 */
export async function generateWithSeedance(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const taskId = await submitSeedanceTask(config, options);

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const result = await pollSeedanceTask(config, taskId);
    if (result) return result;
  }

  throw new Error(
    `Seedance video generation timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s (task: ${taskId})`,
  );
}
