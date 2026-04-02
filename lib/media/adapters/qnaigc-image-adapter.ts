/**
 * QNAIGC Image Generation Adapter (Qiniu Cloud)
 *
 * Uses QNAIGC's OpenAI-compatible image generation endpoint.
 * Model: gemini-3.1-flash-image-preview (hidden model, not in /v1/models)
 *
 * Endpoint: POST https://api.qnaigc.com/v1/images/generations
 * Auth: Authorization: Bearer <apiKey>
 * Response: { data: [{ b64_json: "..." }], output_format: "png" }
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'gemini-3.1-flash-image-preview';
const DEFAULT_BASE_URL = 'https://api.qnaigc.com/v1';

// Default output dimensions per aspect ratio (observed from live API)
const ASPECT_RATIO_DIMENSIONS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1376, height: 768 },
  '9:16': { width: 768, height: 1376 },
  '4:3': { width: 1024, height: 768 },
  '1:1': { width: 1024, height: 1024 },
};

export async function testQnaigcImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  try {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        prompt: '',
        image_config: { aspect_ratio: '1:1' },
      }),
    });

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        message: `Invalid API key or unauthorized (${response.status}). Check your QNAIGC API Key.`,
      };
    }

    // 400 or 200 both mean the key was accepted (400 might be prompt rejection, which is fine)
    return { success: true, message: `Connected to QNAIGC Image (${config.model || DEFAULT_MODEL})` };
  } catch (err) {
    return {
      success: false,
      message: `Network error: unable to reach ${baseUrl}. ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function generateWithQnaigcImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;
  const aspectRatio = options.aspectRatio ?? '16:9';

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt: options.prompt,
      image_config: { aspect_ratio: aspectRatio },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`QNAIGC image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const b64 = data?.data?.[0]?.b64_json as string | undefined;

  if (!b64) {
    throw new Error(`QNAIGC image: no b64_json in response. Got: ${JSON.stringify(data)}`);
  }

  const dims = ASPECT_RATIO_DIMENSIONS[aspectRatio] ?? { width: 1024, height: 576 };

  return {
    base64: b64,
    width: options.width || dims.width,
    height: options.height || dims.height,
  };
}
