/**
 * OpenAI-Compatible Video Generation Adapter
 *
 * Supports any API that implements the OpenAI video/generations endpoint format:
 * - https://platform.openai.com/docs/api-reference/videos (future OpenAI API)
 *
 * Can be used with:
 * - Custom endpoints that implement the OpenAI video API format
 * - Grok Video or similar OpenAI-compatible video APIs
 *
 * Note: This is a template for OpenAI API-compatible video providers
 * The actual OpenAI video API is not yet released, so this uses a similar pattern.
 *
 * Authentication: Bearer token via Authorization header
 */

import type {
  VideoGenerationConfig,
  VideoGenerationOptions,
  VideoGenerationResult,
} from '../types';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-vision';

/**
 * Lightweight connectivity test — validates API key by making a minimal request
 */
export async function testOpenAICompatibleVideoConnectivity(
  config: VideoGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  try {
    // Test using a simple text-to-video request format
    const response = await fetch(`${baseUrl}/video/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        prompt: 'test',
      }),
    });

    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `OpenAI Compatible Video auth failed (${response.status}): ${text}`,
      };
    }

    if (!response.ok) {
      // 404 is acceptable if endpoint doesn't exist yet, but auth passed
      if (response.status === 404) {
        return {
          success: true,
          message: 'Endpoint not found, but authentication succeeded',
        };
      }
      const text = await response.text();
      return {
        success: false,
        message: `OpenAI Compatible Video API error (${response.status}): ${text}`,
      };
    }

    return {
      success: true,
      message: 'Connected to OpenAI-Compatible Video endpoint',
    };
  } catch (err) {
    return {
      success: false,
      message: `OpenAI Compatible Video connectivity error: ${err}`,
    };
  }
}

/**
 * Generate video using OpenAI-compatible endpoint
 */
export async function generateWithOpenAICompatibleVideo(
  config: VideoGenerationConfig,
  options: VideoGenerationOptions,
): Promise<VideoGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;

  const size = calculateVideoSize(options);
  const [width, height] = size.split('x').map((v) => parseInt(v, 10));

  try {
    const response = await fetch(`${baseUrl}/video/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt: options.prompt,
        duration: options.duration || 6,
        size: size,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `OpenAI Compatible Video API error (${response.status}): ${error}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ url?: string }>;
    };

    if (!data.data || data.data.length === 0) {
      throw new Error('No video data returned from OpenAI Compatible API');
    }

    const videoData = data.data[0];

    if (videoData.url) {
      return {
        url: videoData.url,
        duration: options.duration || 6,
        width,
        height,
      };
    }

    throw new Error('No video URL in OpenAI Compatible response');
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(`OpenAI Compatible video generation failed: ${err}`);
  }
}

/**
 * Calculate OpenAI-compatible video size format from options
 */
function calculateVideoSize(options: VideoGenerationOptions): string {
  // Common video sizes
  const supportedSizes: { [key: string]: string } = {
    '16:9': '1280x720',
    '9:16': '720x1280',
    '1:1': '720x720',
  };

  return supportedSizes[options.aspectRatio || '16:9'] || '1280x720';
}
