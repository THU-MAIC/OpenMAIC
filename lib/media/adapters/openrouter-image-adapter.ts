/**
 * OpenRouter Image Generation Adapter
 *
 * Uses OpenAI-compatible synchronous API format.
 * Endpoint: https://openrouter.ai/api/v1/images/generations
 *
 * Supported models include:
 * - black-forest-labs/FLUX-1.1-pro
 * - black-forest-labs/FLUX.1-schnell:free
 * - openai/dall-e-3
 * - openai/dall-e-2
 * - stability-ai/sdxl:fp16
 *
 * Authentication: Bearer token via Authorization header
 *
 * API docs: https://openrouter.ai/docs/image-generation
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'bytedance-seed/seedream-4.5';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Lightweight connectivity test — validates API key by making a minimal
 * request that triggers auth check. 401/403 means key invalid.
 */
export async function testOpenRouterImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  try {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'HTTP-Referer': 'https://openmaiac.app',
        'X-Title': 'OpenMAIC',
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        prompt: 'test',
        n: 1,
      }),
    });
    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `OpenRouter Image auth failed (${response.status}): ${text}`,
      };
    }
    return { success: true, message: 'Connected to OpenRouter Image' };
  } catch (err) {
    return { success: false, message: `OpenRouter Image connectivity error: ${err}` };
  }
}

export async function generateWithOpenRouterImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  const body: Record<string, unknown> = {
    model: config.model || DEFAULT_MODEL,
    prompt: options.prompt,
    n: 1,
    response_format: 'url',
  };

  // Add dimensions or aspect ratio if provided
  if (options.width && options.height) {
    body.size = `${options.width}x${options.height}`;
  }

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'HTTP-Referer': 'https://openmaiac.app',
      'X-Title': 'OpenMAIC',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // OpenAI-compatible response format: { data: [{ url, b64_json }] }
  const imageData = data.data?.[0];
  if (!imageData) {
    throw new Error('OpenRouter returned empty image response');
  }

  return {
    url: imageData.url,
    base64: imageData.b64_json,
    width: options.width || 1024,
    height: options.height || 1024,
  };
}
