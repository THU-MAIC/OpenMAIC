/**
 * Seedream (ByteDance / Doubao / Ark) Image Generation Adapter
 *
 * Uses OpenAI-compatible synchronous API format.
 * Endpoint: https://ark.cn-beijing.volces.com/api/v3/images/generations
 *
 * Supported models:
 * - doubao-seedream-5-0-260128  (latest / Lite, text2img + img2img + multi-ref + group)
 * - doubao-seedream-4-5-251128
 * - doubao-seedream-4-0-250828
 * - doubao-seedream-3-0-t2i-250415
 *
 * API docs: https://www.volcengine.com/docs/6791/1399028
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'doubao-seedream-5-0-260128';
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com';

/**
 * Map our aspect ratio + size to Seedream size format "WxH".
 * Seedream requires minimum 3,686,400 pixels total.
 * Common sizes: 2048x2048 (2K), 2560x1440 (16:9), 1920x1920.
 */
function resolveSeedreamSize(options: ImageGenerationOptions): string {
  if (options.width && options.height) {
    // Ensure minimum pixel count (3,686,400)
    const pixels = options.width * options.height;
    if (pixels < 3_686_400) {
      // Scale up proportionally
      const scale = Math.ceil(Math.sqrt(3_686_400 / pixels));
      return `${options.width * scale}x${options.height * scale}`;
    }
    return `${options.width}x${options.height}`;
  }
  // Default to 2K for quality
  return '2K';
}

/**
 * Lightweight connectivity test — validates API key by making a minimal
 * request that triggers auth check. 401/403 means key invalid.
 */
export async function testSeedreamConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  try {
    // Send a request with empty prompt — auth failure (401/403) means bad key,
    // any other error (400) means key is valid but request is intentionally bad
    const response = await fetch(`${baseUrl}/api/v3/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        prompt: '',
        size: '1x1',
      }),
    });
    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `Seedream auth failed (${response.status}): ${text}`,
      };
    }
    return { success: true, message: 'Connected to Seedream' };
  } catch (err) {
    return { success: false, message: `Seedream connectivity error: ${err}` };
  }
}

export async function generateWithSeedream(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  const response = await fetch(`${baseUrl}/api/v3/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL,
      prompt: options.prompt,
      size: resolveSeedreamSize(options),
      watermark: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Seedream generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // OpenAI-compatible response format: { data: [{ url, b64_json, ... }] }
  const imageData = data.data?.[0];
  if (!imageData) {
    throw new Error('Seedream returned empty response');
  }

  return {
    url: imageData.url,
    base64: imageData.b64_json,
    width: options.width || 1024,
    height: options.height || 1024,
  };
}
