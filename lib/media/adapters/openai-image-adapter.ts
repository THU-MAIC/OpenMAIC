/**
 * OpenAI Image Generation Adapter
 *
 * Uses the OpenAI Images API.
 * Endpoint: https://api.openai.com/v1/images/generations
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function resolveSize(options: ImageGenerationOptions): string {
  return `${options.width || 1024}x${options.height || 1024}`;
}

export async function testOpenAIImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  try {
    const response = await fetch(
      `${baseUrl}/models/${encodeURIComponent(config.model || DEFAULT_MODEL)}`,
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      },
    );

    if (response.ok) {
      return { success: true, message: 'Connected to OpenAI Image' };
    }

    const text = await response.text().catch(() => response.statusText);
    if (response.status === 401 || response.status === 403) {
      return { success: false, message: `OpenAI Image auth failed (${response.status}): ${text}` };
    }
    if (response.status === 404) {
      return {
        success: false,
        message: `OpenAI Image model not found: ${config.model || DEFAULT_MODEL}`,
      };
    }
    return { success: false, message: `OpenAI Image API error (${response.status}): ${text}` };
  } catch (err) {
    return { success: false, message: `OpenAI Image connectivity error: ${err}` };
  }
}

export async function generateWithOpenAIImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const width = options.width || 1024;
  const height = options.height || 1024;

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
      size: resolveSize(options),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`OpenAI image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const imageData = data.data?.[0];
  if (!imageData?.url && !imageData?.b64_json) {
    throw new Error('OpenAI Image returned empty image response');
  }

  return {
    url: imageData.url,
    base64: imageData.b64_json,
    width,
    height,
  };
}
