/**
 * OpenAI-Compatible Image Generation Adapter
 *
 * Supports any API that implements the OpenAI images/generations endpoint format:
 * - https://platform.openai.com/docs/api-reference/images/create
 *
 * Can be used with:
 * - OpenAI (default: https://api.openai.com/v1)
 * - LocalAI, LM Studio, Ollama with OpenAI-compatible endpoints
 * - Custom endpoints that implement the OpenAI API format
 *
 * Authentication: Bearer token via Authorization header (or API-Key header)
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'dall-e-3';

/**
 * Lightweight connectivity test — validates API key by making a minimal request
 */
export async function testOpenAICompatibleImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  try {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        prompt: 'test',
        n: 1,
        size: '256x256',
      }),
    });

    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `OpenAI Compatible Image auth failed (${response.status}): ${text}`,
      };
    }

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        message: `OpenAI Compatible Image API error (${response.status}): ${text}`,
      };
    }

    return { success: true, message: 'Connected to OpenAI-Compatible Image endpoint' };
  } catch (err) {
    return {
      success: false,
      message: `OpenAI Compatible Image connectivity error: ${err}`,
    };
  }
}

/**
 * Generate image using OpenAI-compatible endpoint
 */
export async function generateWithOpenAICompatibleImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;

  // Calculate size from aspect ratio or use provided dimensions
  const size = calculateImageSize(options);

  try {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt: options.prompt,
        n: 1,
        size: size,
        ...(options.style && { style: options.style }),
        quality: 'hd',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `OpenAI Compatible Image API error (${response.status}): ${error}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ url?: string; b64_json?: string }>;
    };

    if (!data.data || data.data.length === 0) {
      throw new Error('No image data returned from OpenAI Compatible API');
    }

    const imageData = data.data[0];
    const [width, height] = size
      .split('x')
      .map((v) => parseInt(v, 10));

    if (imageData.url) {
      return {
        url: imageData.url,
        width,
        height,
      };
    }

    if (imageData.b64_json) {
      return {
        base64: imageData.b64_json,
        width,
        height,
      };
    }

    throw new Error('No image URL or base64 data in OpenAI Compatible response');
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(`OpenAI Compatible image generation failed: ${err}`);
  }
}

/**
 * Calculate OpenAI-compatible size format from options
 */
function calculateImageSize(options: ImageGenerationOptions): string {
  // OpenAI supports: 256x256, 512x512, 1024x1024, 1792x1024, 1024x1792
  const supportedSizes = [
    '256x256',
    '512x512',
    '1024x1024',
    '1792x1024',
    '1024x1792',
  ];

  if (options.width && options.height) {
    const requestedSize = `${options.width}x${options.height}`;
    if (supportedSizes.includes(requestedSize)) {
      return requestedSize;
    }
  }

  // Default based on aspect ratio
  switch (options.aspectRatio) {
    case '16:9':
      return '1792x1024';
    case '9:16':
      return '1024x1792';
    default:
      return '1024x1024';
  }
}
