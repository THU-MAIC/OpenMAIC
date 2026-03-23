/**
 * Sora (OpenAI) Video Generation Adapter
 *
 * Uses OpenAI's async video API:
 * - POST   /videos              submit job
 * - GET    /videos/{id}         poll status
 * - GET    /videos/{id}/content download MP4
 *
 * API docs: https://platform.openai.com/docs/guides/video-generation
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'sora-2';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 60;
const SORA_SUPPORTED_SECONDS = [4, 8, 12] as const;
type SoraSupportedSecond = (typeof SORA_SUPPORTED_SECONDS)[number];

interface SoraVideoJob {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'canceled' | string;
  model?: string;
  progress?: number;
  seconds?: string;
  size?: string;
  error?: {
    message?: string;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function getVideoSize(aspectRatio?: string): string {
  switch (aspectRatio) {
    case '9:16':
      return '720x1280';
    case '1:1':
      return '1024x1024';
    case '4:3':
      return '1024x768';
    case '3:4':
      return '768x1024';
    default:
      return '1280x720';
  }
}

function getSoraSeconds(duration?: number): string | undefined {
  if (duration === undefined || !Number.isFinite(duration)) {
    return undefined;
  }

  const roundedDuration = Math.round(duration);
  const clampedDuration = Math.max(
    SORA_SUPPORTED_SECONDS[0],
    Math.min(SORA_SUPPORTED_SECONDS[SORA_SUPPORTED_SECONDS.length - 1], roundedDuration),
  );

  let closestDuration: SoraSupportedSecond = SORA_SUPPORTED_SECONDS[0];
  let smallestDifference = Math.abs(clampedDuration - closestDuration);

  for (const supportedDuration of SORA_SUPPORTED_SECONDS.slice(1)) {
    const difference = Math.abs(clampedDuration - supportedDuration);
    if (difference < smallestDifference) {
      closestDuration = supportedDuration;
      smallestDifference = difference;
    }
  }

  return String(closestDuration);
}

function sizeToDimensions(size?: string): { width: number; height: number } {
  if (!size) {
    return { width: 1280, height: 720 };
  }

  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) {
    return { width: 1280, height: 720 };
  }

  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const data = (await response.json()) as {
        error?: { message?: string };
        message?: string;
      };
      return data.error?.message || data.message || response.statusText;
    } catch {
      // fall through to text parsing
    }
  }

  return (await response.text().catch(() => '')) || response.statusText;
}

function getAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

async function submitVideoJob(
  baseUrl: string,
  apiKey: string,
  model: string,
  options: VideoGenerationOptions,
): Promise<SoraVideoJob> {
  const formData = new FormData();
  formData.append('prompt', options.prompt);
  formData.append('model', model);
  formData.append('size', getVideoSize(options.aspectRatio));

  const seconds = getSoraSeconds(options.duration);
  if (seconds) {
    formData.append('seconds', seconds);
  }

  const response = await fetch(`${baseUrl}/videos`, {
    method: 'POST',
    headers: getAuthHeaders(apiKey),
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Sora submit failed (${response.status}): ${await readErrorMessage(response)}`);
  }

  return response.json() as Promise<SoraVideoJob>;
}

async function getVideoJob(
  baseUrl: string,
  apiKey: string,
  videoId: string,
): Promise<SoraVideoJob> {
  const response = await fetch(`${baseUrl}/videos/${videoId}`, {
    method: 'GET',
    headers: getAuthHeaders(apiKey),
  });

  if (!response.ok) {
    throw new Error(`Sora poll failed (${response.status}): ${await readErrorMessage(response)}`);
  }

  return response.json() as Promise<SoraVideoJob>;
}

async function downloadVideoContent(
  baseUrl: string,
  apiKey: string,
  videoId: string,
): Promise<{ url: string; mimeType: string }> {
  const response = await fetch(`${baseUrl}/videos/${videoId}/content`, {
    method: 'GET',
    headers: getAuthHeaders(apiKey),
  });

  if (!response.ok) {
    throw new Error(
      `Sora content download failed (${response.status}): ${await readErrorMessage(response)}`,
    );
  }

  const mimeType = response.headers.get('content-type') || 'video/mp4';
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    url: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
  };
}

export async function testSoraConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = getBaseUrl(config.baseUrl);
  const model = config.model || DEFAULT_MODEL;

  try {
    const response = await fetch(`${baseUrl}/videos?limit=1`, {
      method: 'GET',
      headers: getAuthHeaders(config.apiKey),
    });

    if (response.ok) {
      return {
        success: true,
        message: `Connected to Sora (${model})`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        message: `OpenAI auth failed (${response.status}): ${await readErrorMessage(response)}`,
      };
    }

    if (response.status === 404) {
      return {
        success: false,
        message: `Sora endpoint not found at ${baseUrl}. Check that your Base URL points to an OpenAI-compatible /v1 API.`,
      };
    }

    return {
      success: false,
      message: `Sora connectivity failed (${response.status}): ${await readErrorMessage(response)}`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Sora connectivity error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function generateWithSora(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const baseUrl = getBaseUrl(config.baseUrl);
  const model = config.model || DEFAULT_MODEL;

  const submitted = await submitVideoJob(baseUrl, config.apiKey, model, options);
  if (!submitted.id) {
    throw new Error('Sora returned an empty video ID');
  }

  let current = submitted;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (current.status === 'completed') {
      const { url } = await downloadVideoContent(baseUrl, config.apiKey, current.id);
      const { width, height } = sizeToDimensions(current.size || getVideoSize(options.aspectRatio));
      return {
        url,
        duration: Number(current.seconds) || options.duration || 5,
        width,
        height,
      };
    }

    if (current.status === 'failed' || current.status === 'canceled') {
      throw new Error(current.error?.message || `Sora generation ${current.status}`);
    }

    await delay(POLL_INTERVAL_MS);
    current = await getVideoJob(baseUrl, config.apiKey, current.id);
  }

  throw new Error('Sora video generation timed out after 10 minutes');
}
