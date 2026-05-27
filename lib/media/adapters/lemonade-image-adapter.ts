/**
 * Lemonade Image Generation Adapter
 *
 * Lemonade exposes OpenAI-compatible image generation at /v1/images/generations.
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'Qwen-Image-GGUF';
const DEFAULT_BASE_URL = 'http://localhost:13305/v1';

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function authHeaders(apiKey?: string): Record<string, string> {
  const key = apiKey?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function resolveSize(options: ImageGenerationOptions): string {
  return `${options.width || 1024}x${options.height || 1024}`;
}

export async function testLemonadeImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: authHeaders(config.apiKey),
    });

    if (response.ok) {
      return { success: true, message: 'Connected to Lemonade image generation' };
    }

    const text = await response.text().catch(() => response.statusText);
    return { success: false, message: `Lemonade API error (${response.status}): ${text}` };
  } catch (err) {
    return { success: false, message: `Lemonade connectivity error: ${err}` };
  }
}

export async function generateWithLemonadeImage(
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
      ...authHeaders(config.apiKey),
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL,
      prompt: options.prompt,
      n: 1,
      size: resolveSize(options),
      response_format: 'b64_json',
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Lemonade image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const imageData = data.data?.[0];
  if (!imageData?.url && !imageData?.b64_json) {
    throw new Error('Lemonade returned empty image response');
  }

  return {
    url: imageData.url,
    base64: imageData.b64_json,
    width,
    height,
  };
}
