/**
 * OpenRouter Image Generation Adapter
 *
 * OpenRouter's dedicated image endpoint — one key for every hosted image model
 * (Seedream, GPT Image, Gemini/Nano Banana, Qwen Image, Recraft, Krea, ...).
 *
 * Endpoints:
 * - Generate: POST /images   { model, prompt, aspect_ratio?, n?, output_format? }
 *             → { created, data: [{ b64_json, media_type? }] }
 * - Catalog:  GET  /images/models  → { data: [{ id, name? }] }
 *
 * Note this is NOT the OpenAI-compatible `/images/generations` shape (that path
 * 404s on OpenRouter), and it is not chat-completions either. It is its own
 * endpoint that answers inline base64.
 *
 * Authentication: Authorization: Bearer <key>
 *
 * API docs: https://openrouter.ai/docs/api-reference/overview
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import { requireModel } from '../require-model';

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Dimension defaults per aspect ratio, mirroring the other image adapters. */
function getDimensions(aspectRatio?: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16':
      return { width: 720, height: 1280 };
    case '1:1':
      return { width: 1024, height: 1024 };
    case '4:3':
      return { width: 1024, height: 768 };
    default:
      return { width: 1280, height: 720 }; // 16:9
  }
}

export function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

interface OpenRouterImageResponse {
  created?: number;
  data?: Array<{ b64_json?: string; media_type?: string }>;
  error?: { code?: string | number; message?: string };
}

/**
 * Lightweight connectivity test — lists the image catalog. Costs nothing and
 * never triggers a generation.
 */
export async function testOpenRouterImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || OPENROUTER_DEFAULT_BASE_URL;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/images/models`, {
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
    message: `OpenRouter image connectivity failed (${response.status}): ${text}`,
  };
}

export async function generateWithOpenRouterImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || OPENROUTER_DEFAULT_BASE_URL;
  const model = requireModel(config.model, 'OpenRouter Image');

  const body: Record<string, unknown> = { model, prompt: options.prompt, n: 1 };
  // `aspect_ratio` accepts our four ratios verbatim; omit it and the model decides.
  if (options.aspectRatio) body.aspect_ratio = options.aspectRatio;

  const response = await fetch(`${baseUrl}/images`, {
    method: 'POST',
    headers: openRouterHeaders(config.apiKey),
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter image generation failed (${response.status}): ${text}`);
  }

  const data: OpenRouterImageResponse = await response.json();
  if (data.error) {
    throw new Error(
      `OpenRouter error: ${data.error.code ?? ''} ${data.error.message ?? ''}`.trim(),
    );
  }

  const first = data.data?.[0];
  if (!first?.b64_json) {
    throw new Error('OpenRouter returned no image data');
  }

  const { width, height } = getDimensions(options.aspectRatio);
  return {
    base64: first.b64_json,
    width: options.width || width,
    height: options.height || height,
  };
}
