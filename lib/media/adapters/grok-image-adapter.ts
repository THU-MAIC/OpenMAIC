/**
 * Grok (xAI) Image Generation Adapter
 *
 * Uses OpenAI-compatible synchronous API format.
 * Endpoint: https://api.x.ai/v1/images/generations
 *
 * Supported models:
 * - grok-imagine-image      (standard, $0.02/image)
 * - grok-imagine-image-pro  (pro quality, $0.07/image)
 *
 * Authentication: Bearer token via Authorization header
 *
 * API docs: https://docs.x.ai/developers/rest-api-reference/inference/images
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'grok-imagine-image';
const DEFAULT_BASE_URL = 'https://api.x.ai/v1';

/**
 * Lightweight connectivity test — validates API key by making a minimal
 * request that triggers auth check. 401/403 means key invalid.
 */
export async function testGrokImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  try {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        prompt: '',
        n: 1,
      }),
    });
    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `Grok Image auth failed (${response.status}): ${text}`,
      };
    }
    return { success: true, message: 'Connected to Grok Image' };
  } catch (err) {
    return { success: false, message: `Grok Image connectivity error: ${err}` };
  }
}

export async function generateWithGrokImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL,
      prompt: options.prompt,
      n: 1,
      response_format: 'url',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Grok image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // OpenAI-compatible response format: { data: [{ url, revised_prompt }] }
  const imageData = data.data?.[0];
  if (!imageData) {
    throw new Error('Grok returned empty image response');
  }

  return {
    url: imageData.url,
    base64: imageData.b64_json,
    width: options.width || 1024,
    height: options.height || 1024,
  };
}
