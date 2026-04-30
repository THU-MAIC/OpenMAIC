/**
 * HappyHorse (Alibaba Cloud Model Studio / DashScope) Video Generation Adapter
 *
 * Uses DashScope's async task flow:
 * POST /api/v1/services/aigc/video-generation/video-synthesis
 * GET  /api/v1/tasks/{task_id}
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'happyhorse-1.0-t2v';
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com';
const POLL_INTERVAL_MS = 15000;
const MAX_POLL_ATTEMPTS = 40; // 10 minutes max

type HappyHorseTaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED'
  | 'UNKNOWN'
  | string;

interface HappyHorseOutput {
  task_id?: string;
  task_status?: HappyHorseTaskStatus;
  video_url?: string;
  code?: string;
  message?: string;
}

interface HappyHorseSubmitResponse {
  output?: HappyHorseOutput;
  code?: string;
  message?: string;
}

interface HappyHorsePollResponse {
  output?: HappyHorseOutput;
  usage?: {
    duration?: number;
    SR?: number;
    ratio?: string;
  };
  code?: string;
  message?: string;
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    ...authHeaders(apiKey),
    'Content-Type': 'application/json',
  };
}

function toHappyHorseResolution(resolution?: string): '720P' | '1080P' {
  return resolution === '1080p' ? '1080P' : '720P';
}

function estimateDimensions(
  ratio?: string,
  resolution?: number,
): { width: number; height: number } {
  const height = resolution || 720;
  const [widthRatio, heightRatio] = (ratio || '16:9').split(':').map(Number);
  if (!widthRatio || !heightRatio) return { width: Math.round((height * 16) / 9), height };
  return { width: Math.round((height * widthRatio) / heightRatio), height };
}

function getErrorMessage(data: HappyHorseSubmitResponse | HappyHorsePollResponse): string {
  const code = data.output?.code || data.code;
  const message = data.output?.message || data.message || 'Unknown error';
  return code ? `${code}: ${message}` : message;
}

export async function submitHappyHorseTask(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<string> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const response = await fetch(`${baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`, {
    method: 'POST',
    headers: {
      ...jsonHeaders(config.apiKey),
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL,
      input: {
        prompt: options.prompt,
      },
      parameters: {
        resolution: toHappyHorseResolution(options.resolution),
        ratio: options.aspectRatio || '16:9',
        duration: options.duration || 5,
        watermark: false,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HappyHorse task submission failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as HappyHorseSubmitResponse;
  if (data.code || data.message) {
    throw new Error(`HappyHorse task submission failed: ${getErrorMessage(data)}`);
  }
  if (!data.output?.task_id) {
    throw new Error(`HappyHorse returned empty task ID. Response: ${JSON.stringify(data)}`);
  }

  return data.output.task_id;
}

export async function pollHappyHorseTask(
  config: VideoGenerationConfig,
  taskId: string,
): Promise<VideoGenerationResult | null> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const response = await fetch(`${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: authHeaders(config.apiKey),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HappyHorse poll failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as HappyHorsePollResponse;
  const status = data.output?.task_status;

  if (status === 'SUCCEEDED') {
    if (!data.output?.video_url) {
      throw new Error('HappyHorse task succeeded but no video URL returned');
    }
    const dimensions = estimateDimensions(data.usage?.ratio, data.usage?.SR);
    return {
      url: data.output.video_url,
      duration: data.usage?.duration || 5,
      width: dimensions.width,
      height: dimensions.height,
    };
  }

  if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
    throw new Error(`HappyHorse video generation failed: ${getErrorMessage(data)}`);
  }

  return null;
}

export async function generateWithHappyHorse(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const taskId = await submitHappyHorseTask(config, options);

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await delay(POLL_INTERVAL_MS);
    const result = await pollHappyHorseTask(config, taskId);
    if (result) return result;
  }

  throw new Error(
    `HappyHorse video generation timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s (task: ${taskId})`,
  );
}

export async function testHappyHorseConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  try {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const response = await fetch(`${baseUrl}/api/v1/tasks/connectivity-test-nonexistent`, {
      method: 'GET',
      headers: authHeaders(config.apiKey),
    });

    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `HappyHorse auth failed (${response.status}): ${text}`,
      };
    }

    return { success: true, message: 'Connected to HappyHorse' };
  } catch (err) {
    return { success: false, message: `HappyHorse connectivity error: ${err}` };
  }
}
