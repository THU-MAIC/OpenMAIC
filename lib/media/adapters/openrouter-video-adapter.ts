/**
 * OpenRouter Video Generation Adapter
 *
 * OpenRouter's dedicated video endpoint — one key for every hosted video model
 * (Veo, Kling, Runway, Seedance, Hailuo, Wan, Sora, Grok Imagine, ...).
 *
 * Async job pattern: submit → poll → download bytes.
 * - Submit:   POST /videos   { model, prompt, aspect_ratio?, duration?, resolution? }
 *             → 202 { id, polling_url, status }
 * - Poll:     GET  /videos/{jobId}
 *             → { id, status, unsigned_urls?, error? }
 *               status ∈ pending | in_progress | completed | failed | cancelled | expired
 * - Content:  GET  /videos/{jobId}/content?index=0 → video/mp4 bytes
 * - Catalog:  GET  /videos/models → { data: [{ id, name? }] }
 *
 * Authentication: Authorization: Bearer <key>
 *
 * Like the Veo adapter, the finished clip is returned as a base64 data URL so
 * nothing is written to disk.
 *
 * API docs: https://openrouter.ai/docs/api-reference/overview
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';
import { runPolledTask, type PollResult } from '../polled-task';
import { requireModel } from '../require-model';
import { OPENROUTER_DEFAULT_BASE_URL, openRouterHeaders } from './openrouter-image-adapter';

const POLL_INTERVAL_MS = 10_000; // 10 seconds
const MAX_POLL_ATTEMPTS = 60; // 10 minutes max

/** Dimension defaults per aspect ratio, mirroring the other video adapters. */
function getDimensions(aspectRatio?: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16':
      return { width: 720, height: 1280 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '4:3':
      return { width: 1024, height: 768 };
    case '3:4':
      return { width: 768, height: 1024 };
    case '21:9':
      return { width: 1680, height: 720 };
    default:
      return { width: 1280, height: 720 }; // 16:9
  }
}

interface OpenRouterVideoJob {
  id?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
  polling_url?: string;
  generation_id?: string;
  unsigned_urls?: string[];
  error?: string;
}

/** Download the finished clip and inline it as a data URL. */
async function fetchVideoDataUrl(
  baseUrl: string,
  apiKey: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(jobId)}/content?index=0`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenRouter video download failed (${response.status}): ${text}`);
  }
  const mimeType = response.headers.get('content-type') || 'video/mp4';
  const buffer = await response.arrayBuffer();
  return `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
}

/** Map a polled job onto the shared polled-task result union. */
async function resolveJob(
  job: OpenRouterVideoJob,
  baseUrl: string,
  apiKey: string,
  options: VideoGenerationOptions,
): Promise<PollResult<VideoGenerationResult>> {
  switch (job.status) {
    case 'completed': {
      if (!job.id) throw new Error('OpenRouter returned a completed job without an id');
      const url = await fetchVideoDataUrl(baseUrl, apiKey, job.id, options.signal);
      const { width, height } = getDimensions(options.aspectRatio);
      return {
        status: 'done',
        result: { url, duration: options.duration || 8, width, height },
      };
    }
    case 'failed':
    case 'cancelled':
    case 'expired':
      return {
        status: 'failed',
        message: `OpenRouter video generation ${job.status}: ${job.error || 'no reason given'}`,
      };
    default:
      return { status: 'pending', detail: job.status };
  }
}

async function submitVideoJob(
  baseUrl: string,
  apiKey: string,
  model: string,
  options: VideoGenerationOptions,
): Promise<OpenRouterVideoJob> {
  const body: Record<string, unknown> = { model, prompt: options.prompt };
  if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;
  if (options.duration) body.duration = options.duration;
  if (options.resolution) body.resolution = options.resolution;

  const response = await fetch(`${baseUrl}/videos`, {
    method: 'POST',
    headers: openRouterHeaders(apiKey),
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter video submit failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<OpenRouterVideoJob>;
}

async function pollVideoJob(
  baseUrl: string,
  apiKey: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<OpenRouterVideoJob> {
  const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    headers: openRouterHeaders(apiKey),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter video poll failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<OpenRouterVideoJob>;
}

/**
 * Lightweight connectivity test — lists the video catalog. Costs nothing and
 * never starts a job.
 */
export async function testOpenRouterVideoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || OPENROUTER_DEFAULT_BASE_URL;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/videos/models`, {
      method: 'GET',
      redirect: 'manual',
      headers: openRouterHeaders(config.apiKey),
    });
  } catch {
    return {
      success: false,
      message: `Network error: unable to reach ${baseUrl}. Check your Base URL and network connection.`,
    };
  }

  if (response.ok) {
    return {
      success: true,
      message: `Connected to OpenRouter (${config.model || 'no model selected'})`,
    };
  }

  const text = await response.text().catch(() => '');
  if (response.status === 401 || response.status === 403) {
    return {
      success: false,
      message: `Invalid API key or unauthorized (${response.status}). Check your OpenRouter key.`,
    };
  }
  return {
    success: false,
    message: `OpenRouter video connectivity failed (${response.status}): ${text}`,
  };
}

export async function generateWithOpenRouterVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const baseUrl = config.baseUrl || OPENROUTER_DEFAULT_BASE_URL;
  const model = requireModel(config.model, 'OpenRouter Video');

  return runPolledTask<VideoGenerationResult>({
    submit: async () => {
      const job = await submitVideoJob(baseUrl, config.apiKey, model, options);
      if (!job.id) throw new Error('OpenRouter returned a video job without an id');
      // A job can already be terminal on submit; only 'pending'/'in_progress' waits.
      const resolved = await resolveJob(job, baseUrl, config.apiKey, options);
      return resolved.status === 'pending' ? { status: 'submitted', taskId: job.id } : resolved;
    },
    poll: async (jobId) => {
      const job = await pollVideoJob(baseUrl, config.apiKey, jobId, options.signal);
      // Poll responses may omit the id; keep the one we submitted with.
      return resolveJob({ ...job, id: job.id || jobId }, baseUrl, config.apiKey, options);
    },
    intervalMs: POLL_INTERVAL_MS,
    maxAttempts: MAX_POLL_ATTEMPTS,
    label: 'OpenRouter video generation',
  });
}
