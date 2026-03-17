/**
 * Qwen Image (Alibaba Cloud / DashScope) Image Generation Adapter
 *
 * Uses DashScope multimodal generation API (synchronous, no polling needed).
 * Endpoint: https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 *
 * Supported models:
 * - qwen-image-max     (highest quality)
 * - z-image-turbo      (fast, good quality)
 *
 * API docs: https://help.aliyun.com/zh/model-studio/developer-reference/text-to-image
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'qwen-image-max';
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com';

/**
 * Map our width x height to DashScope size format "WxH".
 * Common sizes: 1024*1024, 1280*720, 1664*928, 1120*1440, etc.
 */
function resolveDashScopeSize(options: ImageGenerationOptions): string {
  const w = options.width || 1024;
  const h = options.height || 576;
  return `${w}*${h}`;
}

/**
 * Lightweight connectivity test — validates API key by making a minimal
 * request. 401/403 means key invalid; other errors mean key is valid.
 */
export async function testQwenImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  try {
    const response = await fetch(
      `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_MODEL,
          input: { messages: [{ role: 'user', content: [{ text: '' }] }] },
          parameters: { size: '1*1' },
        }),
      },
    );
    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `Qwen Image auth failed (${response.status}): ${text}`,
      };
    }
    return { success: true, message: 'Connected to Qwen Image' };
  } catch (err) {
    return { success: false, message: `Qwen Image connectivity error: ${err}` };
  }
}

export async function generateWithQwenImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;

  const response = await fetch(`${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL,
      input: {
        messages: [
          {
            role: 'user',
            content: [
              {
                text: options.prompt,
              },
            ],
          },
        ],
      },
      parameters: {
        negative_prompt: options.negativePrompt || undefined,
        prompt_extend: true,
        watermark: false,
        size: resolveDashScopeSize(options),
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Qwen Image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // DashScope multimodal generation response format:
  // { output: { choices: [{ message: { content: [{ image: "url" }] } }] } }
  const choices = data.output?.choices;
  if (!choices || choices.length === 0) {
    // Check for error in response
    if (data.code || data.message) {
      throw new Error(`Qwen Image error: ${data.code} - ${data.message}`);
    }
    throw new Error('Qwen Image returned empty response');
  }

  const content = choices[0]?.message?.content;
  const imageContent = content?.find((c: { image?: string }) => c.image);

  if (!imageContent?.image) {
    throw new Error('Qwen Image response missing image URL');
  }

  return {
    url: imageContent.image,
    width: options.width || 1024,
    height: options.height || 576,
  };
}
