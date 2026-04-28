/**
 * MiniMax Video Generation Adapter
 * Supports: text-to-video with camera control commands
 * API: POST /v1/video_generation (submit) + GET /v1/query/video_generation?task_id=xxx (poll)
 * Docs: https://platform.minimaxi.com/docs/api-reference/video-generation-t2v
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

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

async function submitTask(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<string> {
  const baseUrl = (config.baseUrl || BASE_URL).replace(/\/$/, '');

  const model = config.model || 'MiniMax-Hailuo-2.3';
  const duration = options.duration || 6;
  // Map OpenMAIC resolution to MiniMax format
  const resolutionMap: Record<string, string> = {
    '720p': '720P',
    '1080p': '1080P',
  };
  const resolution = resolutionMap[options.resolution || ''] || '768P';

  const response = await fetch(`${baseUrl}/v1/video_generation`, {
    method: 'POST',
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
): Promise<MiniMaxQueryResponse> {
  const baseUrl = (config.baseUrl || BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`MiniMax Video poll error: ${errText}`);
  }

  return response.json() as Promise<MiniMaxQueryResponse>;
}

async function retrieveFileDownloadUrl(
  config: VideoGenerationConfig,
  fileId: string,
): Promise<string> {
  const baseUrl = (config.baseUrl || BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  });

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
  // Step 1: Submit task
  const taskId = await submitTask(config, options);

  // Step 2: Poll until complete
  let lastStatus = '';
  let attempts = 0;

  while (attempts < MAX_POLL_ATTEMPTS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const result = await pollTaskStatus(config, taskId);
    lastStatus = result.status;

    if (result.status === 'Success') {
      if (!result.file_id) {
        throw new Error(`MiniMax Video: task succeeded but no file_id returned`);
      }

      const videoUrl = await retrieveFileDownloadUrl(config, result.file_id);

      return {
        url: videoUrl,
        width: result.video_width || 1920,
        height: result.video_height || 1080,
        duration: options.duration || 6,
      };
    }

    if (result.status === 'Fail') {
      throw new Error(
        `MiniMax Video generation failed: ${result.base_resp?.status_msg || 'unknown'}`,
      );
    }

    attempts++;
  }

  throw new Error(
    `MiniMax Video: timeout after ${MAX_POLL_ATTEMPTS} polls, last status: ${lastStatus}`,
  );
}

export async function testMiniMaxVideoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  try {
    const baseUrl = (config.baseUrl || BASE_URL).replace(/\/$/, '');
    // Submit a minimal task and immediately check if it returns a task_id
    const response = await fetch(`${baseUrl}/v1/video_generation`, {
      method: 'POST',
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
