/**
 * MiniMax Image Generation Adapter
 * Supports: text-to-image with aspect ratio control
 * API Docs: https://platform.minimaxi.com/docs/api-reference/image-generation-t2i
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const BASE_URL = 'https://api.minimaxi.com';

export async function generateWithMiniMaxImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = (config.baseUrl || BASE_URL).replace(/\/$/, '');

  const model = config.model || 'image-01';

  const aspectRatio = options.aspectRatio || '1:1';

  const response = await fetch(`${baseUrl}/v1/image_generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model,
      prompt: options.prompt,
      negative_prompt: options.negativePrompt,
      aspect_ratio: aspectRatio,
      response_format: 'url',
      n: 1,
      prompt_optimizer: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    throw new Error(`MiniMax Image API error: ${errText}`);
  }

  const data = await response.json();

  // Check for error response
  if (data?.base_resp?.status_code !== 0 && data?.base_resp?.status_code !== undefined) {
    const code = data.base_resp.status_code;
    const msg = data.base_resp.status_msg || 'unknown error';
    throw new Error(`MiniMax Image API error ${code}: ${msg}`);
  }

  const imageUrls = data?.data?.image_urls;
  if (!imageUrls || imageUrls.length === 0) {
    throw new Error(`MiniMax Image: no image URLs returned. Response: ${JSON.stringify(data)}`);
  }

  const imageUrl = imageUrls[0];

  // Determine dimensions from aspect ratio
  let width = options.width || 1024;
  let height = options.height || 1024;
  if (!options.width && !options.height) {
    const [w, h] = aspectRatio.split(':').map(Number);
    if (w && h) {
      if (w > h) {
        width = 1024;
        height = Math.round((1024 * h) / w);
      } else {
        height = 1024;
        width = Math.round((1024 * w) / h);
      }
    }
  }

  return {
    url: imageUrl,
    width,
    height,
  };
}

export async function testMiniMaxImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  try {
    const baseUrl = (config.baseUrl || BASE_URL).replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/v1/image_generation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        model: 'image-01',
        prompt: 'test',
        aspect_ratio: '1:1',
        n: 1,
      }),
    });

    if (response.ok) {
      return { success: true, message: 'MiniMax Image API connected' };
    }

    const errData = await response.json().catch(() => ({}));
    const msg = errData?.base_resp?.status_msg || response.statusText;
    return { success: false, message: `API error: ${msg}` };
  } catch (err) {
    return { success: false, message: `Connection failed: ${(err as Error).message}` };
  }
}
