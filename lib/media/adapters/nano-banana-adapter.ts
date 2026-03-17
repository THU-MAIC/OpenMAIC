/**
 * Nano Banana / Gemini Native Image Generation Adapter
 *
 * Uses Google Gemini's native image generation capability.
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * Supported models:
 * - gemini-3.1-flash-image-preview  (Nano Banana 2 — latest, fastest)
 * - gemini-3-pro-image-preview      (Nano Banana Pro — highest quality)
 * - gemini-2.5-flash-image          (Nano Banana — original)
 *
 * Authentication: x-goog-api-key header
 *
 * API docs: https://ai.google.dev/gemini-api/docs/image-generation
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[];
    };
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * Lightweight connectivity test — validates API key by fetching model info.
 * Uses GET /v1beta/models/{model} which does not trigger generation.
 */
export async function testNanoBananaConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;
  const url = `${baseUrl}/v1beta/models`;

  // Try ?key= query param first (direct Google API), fall back to x-goog-api-key header (proxy)
  let response: Response | null = null;
  try {
    response = await fetch(`${url}?key=${config.apiKey}`, { method: 'GET' });
  } catch {
    // Direct API unreachable, try header auth
  }
  if (!response || !response.ok) {
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { 'x-goog-api-key': config.apiKey },
      });
    } catch (_err) {
      return {
        success: false,
        message: `Network error: unable to reach ${baseUrl}. Check your Base URL and network connection.`,
      };
    }
  }

  if (response.ok) {
    return { success: true, message: `Connected to Nano Banana (${model})` };
  }

  // Parse error body for user-friendly message
  const text = await response.text().catch(() => '');
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return {
      success: false,
      message: `Invalid API key or unauthorized (${response.status}). Check your API Key and Base URL match the same provider.`,
    };
  }
  return {
    success: false,
    message: `Nano Banana connectivity failed (${response.status}): ${text}`,
  };
}

export async function generateWithNanoBanana(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const model = config.model || DEFAULT_MODEL;

  const response = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: options.prompt }],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini image generation failed (${response.status}): ${text}`);
  }

  const data: GeminiResponse = await response.json();

  if (data.error) {
    throw new Error(`Gemini error: ${data.error.code} - ${data.error.message}`);
  }

  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error('Gemini returned empty response');
  }

  // Find the image part (inlineData with base64)
  const imagePart = parts.find((p) => p.inlineData);
  if (!imagePart?.inlineData) {
    // Might have returned text only (e.g. if prompt was rejected)
    const textPart = parts.find((p) => p.text);
    throw new Error(`Gemini did not return an image. Response text: ${textPart?.text || 'none'}`);
  }

  return {
    base64: imagePart.inlineData.data,
    width: options.width || 1024,
    height: options.height || 1024,
  };
}
