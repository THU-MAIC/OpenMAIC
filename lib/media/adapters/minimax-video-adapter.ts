/**
 * MiniMax Video Generation Adapter
 * Supports: text-to-video with camera control commands
 * API: POST /v1/video_generation (submit) + GET /v1/query/video_generation?task_id=xxx (poll)
 * Docs: https://platform.minimaxi.com/docs/api-reference/video-generation-t2v
 *
 * H3-family models (`minimax-h3`, `minimax-h3-max`) are served through the v2
 * task API instead: POST /v2/video_generation with a content array, then
 * GET /v2/query/video_generation/{task_id}, which returns a task envelope whose
 * finished video URL is inline (no file-retrieve step).
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';
import { probeAuth } from '../probe-auth';
import { runPolledTask } from '../polled-task';
import { assertNotRedirected } from '../redirect-guard';
import { requireModel } from '../require-model';

const BASE_URL = 'https://api.minimaxi.com';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 120; // ~10 minutes max

interface MiniMaxSubmitResponse {
  task_id: string;
  base_resp: {
    status_code: number;
    status_msg: string;
  };
}

interface MiniMaxQueryResponse {
  task_id: string;
  status: 'Preparing' | 'Queueing' | 'Processing' | 'Success' | 'Fail';
  file_id?: string;
  video_width?: number;
  video_height?: number;
  base_resp: {
    status_code: number;
    status_msg: string;
  };
}

interface MiniMaxFileRetrieveResponse {
  file?: {
    file_id: string | number;
    download_url?: string;
    filename?: string;
  };
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}

interface MiniMaxV2Task {
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  content?: { url?: string };
  error?: { message?: string } | string;
}

interface MiniMaxV2Response extends MiniMaxV2Task {
  task_id?: string;
  id?: string;
  task?: MiniMaxV2Task;
}

/** Reported size of an H3 768P clip for each requested aspect ratio. */
const V2_DIMENSIONS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1366, height: 768 },
  '9:16': { width: 768, height: 1366 },
  '4:3': { width: 1024, height: 768 },
  '1:1': { width: 768, height: 768 },
};

/** H3-family models only accept the v2 task API. */
function usesV2TaskApi(model: string | undefined): boolean {
  return /^minimax-h3(?:-|$)/i.test(model ?? '');
}

async function submitTask(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<string> {
  const baseUrl = (config.baseUrl || BASE_URL).replace(/\/$/, '');

  const model = requireModel(config.model, 'MiniMax Video');
  const duration = options.duration || 6;
  // Map OpenMAIC resolution to MiniMax format. MiniMax's mid tier is 768P, not
  // 720P — Hailuo 2.3 rejects 720P with "2013 ... does not support resolution
  // 720P". Our shared resolution enum has no 768p, so the UI's "720p" maps to
  // MiniMax 768P here (and 768P is also the safe fallback for any other value).
  const resolutionMap: Record<string, string> = {
    '720p': '768P',
    '1080p': '1080P',
  };
  const resolution = resolutionMap[options.resolution || ''] || '768P';

  if (usesV2TaskApi(model)) {
    // H3 renders 768P clips; request the fixed 6s tier so the reported
    // duration below matches the delivered video.
    const response = await fetch(`${baseUrl}/v2/video_generation`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        model,
        resolution: '768P',
        duration: 6,
        ratio: options.aspectRatio || '16:9',
        content: [{ type: 'text', text: options.prompt }],
      }),
    });

    assertNotRedirected(response, 'MiniMax Video');

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`MiniMax Video submit error: ${errText}`);
    }

    const data = (await response.json()) as MiniMaxV2Response;
    const taskId = data.task_id || data.id;
    if (!taskId) {
      throw new Error(`MiniMax Video: no task_id returned. Response: ${JSON.stringify(data)}`);
    }
    return taskId;
  }

  const response = await fetch(`${baseUrl}/v1/video_generation`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model,
      prompt: options.prompt,
      duration,
      resolution,
      prompt_optimizer: false,
    }),
  });

  assertNotRedirected(response, 'MiniMax Video');

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`MiniMax Video submit error: ${errText}`);
  }

  const data: MiniMaxSubmitResponse = await response.json();

  if (data.base_resp?.status_code !== 0) {
    const code = data.base_resp?.status_code;
    const msg = data.base_resp?.status_msg || 'unknown error';
    throw new Error(`MiniMax Video API error ${code}: ${msg}`);
  }

  if (!data.task_id) {
    throw new Error(`MiniMax Video: no task_id returned. Response: ${JSON.stringify(data)}`);
  }

  return data.task_id;
}

async function pollTaskStatus(
  config: VideoGenerationConfig,
  taskId: string,
): Promise<MiniMaxQueryResponse | MiniMaxV2Response> {
  const baseUrl = (config.baseUrl || BASE_URL).replace(/\/$/, '');
  const url = usesV2TaskApi(config.model)
    ? `${baseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`
    : `${baseUrl}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`;

  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  });

  assertNotRedirected(response, 'MiniMax Video');

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`MiniMax Video poll error: ${errText}`);
  }

  return response.json() as Promise<MiniMaxQueryResponse | MiniMaxV2Response>;
}

async function retrieveFileDownloadUrl(
  config: VideoGenerationConfig,
  fileId: string,
): Promise<string> {
  const baseUrl = (config.baseUrl || BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`;

  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  });

  assertNotRedirected(response, 'MiniMax Video');

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`MiniMax Video file retrieve error: ${errText}`);
  }

  const data: MiniMaxFileRetrieveResponse = await response.json();
  if (data.base_resp?.status_code !== 0) {
    const code = data.base_resp?.status_code;
    const msg = data.base_resp?.status_msg || 'unknown error';
    throw new Error(`MiniMax Video file retrieve error ${code}: ${msg}`);
  }

  const downloadUrl = data.file?.download_url;
  if (!downloadUrl) {
    throw new Error(`MiniMax Video: no download_url returned. Response: ${JSON.stringify(data)}`);
  }

  return downloadUrl;
}

export async function generateWithMiniMaxVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  return runPolledTask<VideoGenerationResult>({
    submit: async () => ({
      status: 'submitted',
      taskId: await submitTask(config, options),
    }),
    poll: async (taskId) => {
      const polled = await pollTaskStatus(config, taskId);

      if (usesV2TaskApi(config.model)) {
        const envelope = polled as MiniMaxV2Response;
        const task = envelope.task ?? envelope;
        if (task.status === 'succeeded') {
          const url = task.content?.url;
          if (!url) throw new Error('MiniMax Video: task succeeded but no video url returned');
          const { width, height } =
            V2_DIMENSIONS[options.aspectRatio || '16:9'] ?? V2_DIMENSIONS['16:9'];
          return { status: 'done', result: { url, width, height, duration: 6 } };
        }
        if (task.status === 'failed' || task.status === 'cancelled' || task.status === 'expired') {
          const message = typeof task.error === 'string' ? task.error : task.error?.message;
          return {
            status: 'failed',
            message: `MiniMax Video generation ${task.status}: ${message || 'unknown'}`,
          };
        }
        return { status: 'pending', detail: task.status || 'queued' };
      }

      const result = polled as MiniMaxQueryResponse;

      if (result.status === 'Success') {
        if (!result.file_id) {
          throw new Error(`MiniMax Video: task succeeded but no file_id returned`);
        }

        return {
          status: 'done',
          result: {
            url: await retrieveFileDownloadUrl(config, result.file_id),
            width: result.video_width || 1920,
            height: result.video_height || 1080,
            duration: options.duration || 6,
          },
        };
      }

      if (result.status === 'Fail') {
        return {
          status: 'failed',
          message: `MiniMax Video generation failed: ${result.base_resp?.status_msg || 'unknown'}`,
        };
      }

      return { status: 'pending', detail: result.status };
    },
    intervalMs: POLL_INTERVAL_MS,
    maxAttempts: MAX_POLL_ATTEMPTS,
    label: 'MiniMax Video',
    formatTimeout: ({ attempts, lastPendingDetail }) =>
      `MiniMax Video: timeout after ${attempts} polls, last status: ${lastPendingDetail ?? ''}`,
  });
}

export async function testMiniMaxVideoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = (config.baseUrl || BASE_URL).replace(/\/$/, '');

  if (usesV2TaskApi(config.model)) {
    // Querying an unknown task id only exercises auth, so the check never
    // submits (and bills) a generation.
    return probeAuth({
      providerName: 'MiniMax Video',
      request: () =>
        fetch(`${baseUrl}/v2/query/video_generation/connectivity-check`, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
        }),
    });
  }

  try {
    // Submit a minimal task and immediately check if it returns a task_id
    const response = await fetch(`${baseUrl}/v1/video_generation`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        model: 'MiniMax-Hailuo-2.3',
        prompt: 'test connectivity',
        duration: 6,
        resolution: '768P',
      }),
    });

    if (response.ok) {
      return { success: true, message: 'MiniMax Video API connected' };
    }

    const errData = await response.json().catch(() => ({}));
    const msg = errData?.base_resp?.status_msg || response.statusText;
    return { success: false, message: `API error: ${msg}` };
  } catch (err) {
    return { success: false, message: `Connection failed: ${(err as Error).message}` };
  }
}
