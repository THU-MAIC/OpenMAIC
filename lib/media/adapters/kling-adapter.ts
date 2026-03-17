/**
 * Kling (Kuaishou) Video Generation Adapter
 *
 * Async task pattern: submit → poll → return video URL.
 *
 * REST endpoints:
 * - Submit: POST /v1/videos/text2video
 * - Poll:   GET  /v1/videos/text2video/{task_id}
 *
 * Authentication: JWT Bearer token generated from Access Key + Secret Key.
 * The apiKey field should be formatted as "accessKey:secretKey".
 *
 * Supported models:
 * - kling-v2-6     (latest)
 * - kling-v1-6     (v1)
 *
 * API docs: https://docs.klingai.com/api
 */

import crypto from 'crypto';
import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'kling-v2-6';
const DEFAULT_BASE_URL = 'https://api-beijing.klingai.com';
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120; // 10 minutes max
const JWT_EXPIRY_SECS = 1800; // 30 minutes

// ---------------------------------------------------------------------------
// JWT helper (HS256, no external deps)
// ---------------------------------------------------------------------------

function base64url(data: Buffer | string): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function generateJWT(accessKey: string, secretKey: string): string {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: accessKey,
      exp: now + JWT_EXPIRY_SECS,
      nbf: now - 5,
      iat: now,
    }),
  );

  const signature = base64url(
    crypto.createHmac('sha256', secretKey).update(`${header}.${payload}`).digest(),
  );

  return `${header}.${payload}.${signature}`;
}

function parseApiKey(apiKey: string): { accessKey: string; secretKey: string } {
  const sep = apiKey.indexOf(':');
  if (sep <= 0) {
    throw new Error('Kling apiKey must be "accessKey:secretKey" format');
  }
  return {
    accessKey: apiKey.slice(0, sep),
    secretKey: apiKey.slice(sep + 1),
  };
}

// ---------------------------------------------------------------------------
// REST types
// ---------------------------------------------------------------------------

interface KlingSubmitResponse {
  code: number;
  message: string;
  data: {
    task_id: string;
    task_status: string;
  };
}

interface KlingPollResponse {
  code: number;
  message: string;
  data: {
    task_id: string;
    task_status: string; // submitted | processing | succeed | failed
    task_status_msg?: string;
    task_result?: {
      videos?: Array<{
        id: string;
        url: string;
        duration: string; // seconds as string
      }>;
    };
  };
}

// ---------------------------------------------------------------------------
// Dimension helpers
// ---------------------------------------------------------------------------

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

/**
 * Lightweight connectivity test — validates API key by generating a JWT
 * and making a GET request. 401/403 means key invalid.
 */
export async function testKlingConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  try {
    const { accessKey, secretKey } = parseApiKey(config.apiKey);
    const token = generateJWT(accessKey, secretKey);
    // Use a GET to a non-existent task to validate auth
    const response = await fetch(`${baseUrl}/v1/videos/text2video/connectivity-test`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `Kling auth failed (${response.status}): ${text}`,
      };
    }
    return { success: true, message: 'Connected to Kling' };
  } catch (err) {
    return { success: false, message: `Kling connectivity error: ${err}` };
  }
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function submitTask(
  baseUrl: string,
  token: string,
  model: string,
  options: VideoGenerationOptions,
): Promise<string> {
  const body: Record<string, unknown> = {
    model_name: model,
    prompt: options.prompt,
    negative_prompt: '',
    mode: 'pro',
  };

  if (options.duration) body.duration = String(options.duration);
  if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;

  const response = await fetch(`${baseUrl}/v1/videos/text2video`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kling submit failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as KlingSubmitResponse;
  if (data.code !== 0) {
    throw new Error(`Kling submit error ${data.code}: ${data.message}`);
  }
  if (!data.data?.task_id) {
    throw new Error('Kling returned empty task_id');
  }

  return data.data.task_id;
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

async function pollTask(
  baseUrl: string,
  token: string,
  taskId: string,
): Promise<KlingPollResponse['data']> {
  const response = await fetch(`${baseUrl}/v1/videos/text2video/${taskId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kling poll failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as KlingPollResponse;
  if (data.code !== 0) {
    throw new Error(`Kling poll error ${data.code}: ${data.message}`);
  }

  return data.data;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function generateWithKling(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const model = config.model || DEFAULT_MODEL;
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const { accessKey, secretKey } = parseApiKey(config.apiKey);
  const token = generateJWT(accessKey, secretKey);

  // 1. Submit
  const taskId = await submitTask(baseUrl, token, model, options);

  // 2. Poll until done
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const result = await pollTask(baseUrl, token, taskId);

    if (result.task_status === 'succeed') {
      const video = result.task_result?.videos?.[0];
      if (!video?.url) {
        throw new Error('Kling task succeeded but no video URL returned');
      }
      const { width, height } = getDimensions(options.aspectRatio);
      return {
        url: video.url,
        duration: Number(video.duration) || options.duration || 5,
        width,
        height,
      };
    }

    if (result.task_status === 'failed') {
      throw new Error(
        `Kling video generation failed: ${result.task_status_msg || 'Unknown error'}`,
      );
    }
  }

  throw new Error(
    `Kling video generation timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s (task: ${taskId})`,
  );
}
