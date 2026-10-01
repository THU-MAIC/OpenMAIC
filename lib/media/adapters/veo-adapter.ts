/**
 * Veo (Google) Video Generation Adapter
 *
 * Direct REST API calls for video generation with Google's Veo models.
 * Async task pattern: submit → poll → download → return inline base64 video.
 *
 * REST endpoints (Gemini API, https://ai.google.dev/gemini-api/docs/veo):
 * - Submit:   POST /v1beta/models/{model}:predictLongRunning
 * - Poll:     GET  /v1beta/{operationName}
 *   Done operations carry response.generateVideoResponse.generatedSamples[].video.uri
 * - Download: GET  {uri}  (same API key; may answer with a redirect to storage)
 *
 * (`fetchPredictOperation` and inline `response.videos[].bytesBase64Encoded`
 * are the Vertex AI shapes; inline bytes are still accepted when present.)
 *
 * Supported models:
 * - veo-3.1-generate-preview
 * - veo-3.1-fast-generate-preview
 * - veo-3.1-lite-generate-preview
 * - veo-3.0-generate-001, veo-3.0-fast-generate-001  (deprecated)
 * - veo-2.0-generate-001                             (legacy)
 *
 * Authentication: x-goog-api-key header
 *
 * Stateless: video content is returned as a base64 data URL.
 * No files are saved on the server.
 */

import type {
  MediaProviderFetch,
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';
import { mediaFetchFor } from '../media-fetch';
import { connectivityHttpFailure, connectivityTransportFailure } from '../probe-auth';
import {
  ProviderTaskFailedError,
  runPolledTask,
  type TerminalResult,
  type PolledTaskControl,
} from '../polled-task';
import { assertNotRedirected } from '../redirect-guard';
import { requireModel } from '../require-model';

const DEFAULT_MODEL = 'veo-3.0-generate-001';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const POLL_INTERVAL_MS = 10_000; // 10 seconds
const MAX_POLL_ATTEMPTS = 60; // 10 minutes max

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
    /** Gemini API: the finished clip is a file URI fetched with the API key */
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string; mimeType?: string } }>;
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
    /** Vertex AI shape: inline base64 video data */
    videos?: Array<{
      bytesBase64Encoded?: string; // base64-encoded video bytes
      mimeType?: string; // e.g. "video/mp4"
    }>;
  };
  error?: { code: number; message: string; status: string };
}

/**
 * Download a generated clip and inline it as a data URL. The request always
 * goes to the configured base URL's origin, so the API key is never sent to a
 * host other than the one the SSRF guard already accepted.
 *
 * The file URI may answer with a redirect to storage (Google's own example
 * downloads it with `curl -L`). A server caller injects `downloadFetchImpl`,
 * which follows it with every hop re-validated and the API key dropped on a
 * cross-origin hop; without it the download refuses redirects like every other
 * adapter call.
 */
async function downloadVideo(
  config: VideoGenerationConfig,
  baseUrl: string,
  uri: string,
): Promise<string> {
  const source = new URL(uri, baseUrl);
  const url =
    source.origin === new URL(baseUrl).origin
      ? source.href
      : `${baseUrl}${source.pathname}${source.search}`;
  const headers = { 'x-goog-api-key': config.apiKey };

  let response: Response;
  if (config.downloadFetchImpl) {
    response = await config.downloadFetchImpl(url, { method: 'GET', headers });
  } else {
    response = await mediaFetchFor(config)(url, { method: 'GET', redirect: 'manual', headers });
    assertNotRedirected(response, 'Veo');
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Veo video download failed (${response.status}): ${text}`);
  }

  const mimeType = response.headers.get('content-type') || 'video/mp4';
  const buffer = await response.arrayBuffer();
  return `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
}

async function resolveCompletedOperation(
  operation: VeoOperation,
  options: VideoGenerationOptions,
  config: VideoGenerationConfig,
  baseUrl: string,
): Promise<TerminalResult<VideoGenerationResult>> {
  if (operation.error) {
    return {
      status: 'failed',
      message: `Veo generation failed: ${operation.error.code} - ${operation.error.message}`,
    };
  }

  const { width, height } = getDimensions(options.aspectRatio);
  const result = (url: string): TerminalResult<VideoGenerationResult> => ({
    status: 'done',
    result: { url, duration: options.duration || 8, width, height },
  });

  const inline = operation.response?.videos?.[0];
  if (inline?.bytesBase64Encoded) {
    return result(`data:${inline.mimeType || 'video/mp4'};base64,${inline.bytesBase64Encoded}`);
  }

  const generated = operation.response?.generateVideoResponse;
  const uri = generated?.generatedSamples?.[0]?.video?.uri;
  if (uri) {
    return result(await downloadVideo(config, baseUrl, uri));
  }

  const filtered = generated?.raiMediaFilteredReasons?.filter(Boolean);
  if (filtered?.length) {
    return { status: 'failed', message: `Veo generation was filtered: ${filtered.join('; ')}` };
  }

  throw new ProviderTaskFailedError('Veo returned no generated videos');
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function submitVideoGeneration(
  fetchImpl: MediaProviderFetch,
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

  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'manual',
    headers: apiHeaders(apiKey),
    body: JSON.stringify(body),
  });

  assertNotRedirected(response, 'Veo');

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
  fetchImpl: MediaProviderFetch,
  baseUrl: string,
  apiKey: string,
  operationName: string,
): Promise<VeoOperation> {
  const url = `${baseUrl}/v1beta/${operationName}`;

  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'x-goog-api-key': apiKey },
  });

  assertNotRedirected(response, 'Veo');

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

  const fetchImpl = mediaFetchFor(config);

  // Try ?key= query param first (direct Google API), fall back to x-goog-api-key header (proxy)
  let response: Response | null = null;
  try {
    response = await fetchImpl(`${url}?key=${config.apiKey}`, {
      method: 'GET',
      redirect: 'manual',
    });
  } catch {
    // Direct API unreachable, try header auth
  }
  if (!response || !response.ok) {
    await response?.body?.cancel().catch(() => undefined);
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'x-goog-api-key': config.apiKey },
      });
    } catch (err) {
      return connectivityTransportFailure('Veo', err);
    }
  }
  await response.body?.cancel().catch(() => undefined);

  if (response.ok) {
    return { success: true, message: `Connected to Veo (${model})` };
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return {
      success: false,
      message: `Invalid API key or unauthorized (${response.status}). Check your API Key and Base URL match the same provider.`,
    };
  }
  return connectivityHttpFailure('Veo', response.status);
}

export async function generateWithVeo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
  control?: PolledTaskControl,
): Promise<VideoGenerationResult> {
  const model = requireModel(config.model, 'Veo');
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  return runPolledTask<VideoGenerationResult>({
    submit: async () => {
      const operation = await submitVideoGeneration(
        mediaFetchFor(config),
        baseUrl,
        config.apiKey,
        model,
        options,
      );
      if (!operation.name) {
        throw new Error('Veo returned operation without name');
      }
      return operation.done
        ? resolveCompletedOperation(operation, options, config, baseUrl)
        : { status: 'submitted', taskId: operation.name };
    },
    poll: async (operationName) => {
      const operation = await pollOperation(
        mediaFetchFor(config),
        baseUrl,
        config.apiKey,
        operationName,
      );
      return operation.done
        ? resolveCompletedOperation(operation, options, config, baseUrl)
        : { status: 'pending' };
    },
    intervalMs: POLL_INTERVAL_MS,
    maxAttempts: MAX_POLL_ATTEMPTS,
    label: 'Veo video generation',
    control,
    formatTimeout: () => 'Veo video generation timed out after 10 minutes',
  });
}
