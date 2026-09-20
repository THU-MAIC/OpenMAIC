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
import { probeAuth } from '../probe-auth';
import { requireModel } from '../require-model';

const DEFAULT_MODEL = 'grok-imagine-image';
const DEFAULT_BASE_URL = 'https://api.x.ai/v1';

/**
 * The base64 of a JPEG stream's opening bytes (`FF D8 FF`).
 *
 * `b64_json` declares no media type, so the container is the only signal — and
 * four base64 characters are exactly those three bytes, so the signature test
 * needs no decoder.
 */
const JPEG_BASE64_PREFIX = '/9j/';

/**
 * The media type of a Grok inline image.
 *
 * Anything without the JPEG signature keeps `image/png`, which is what this
 * adapter recorded for every inline response before it read the container.
 */
function inlineImageMimeType(base64: string): string {
  return base64.startsWith(JPEG_BASE64_PREFIX) ? 'image/jpeg' : 'image/png';
}

/**
 * Lightweight connectivity test — validates API key by making a minimal
 * request that triggers auth check. 401/403 means key invalid.
 */
export async function testGrokImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  return probeAuth({
    providerName: 'Grok Image',
    request: () =>
      fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_MODEL,
          prompt: '',
          n: 1,
        }),
      }),
  });
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
      model: requireModel(config.model, 'Grok Image'),
      prompt: options.prompt,
      n: 1,
      // Inline the bytes instead of asking for a URL. The URL points at a
      // relay/CDN host that may be unreachable from the server's network, which
      // fails the generation at the follow-up fetch through /api/proxy-media
      // even though the image was produced successfully.
      response_format: 'b64_json',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Grok image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  // OpenAI-compatible response format: { data: [{ url, b64_json, revised_prompt }] }
  const imageData = data.data?.[0];
  if (!imageData) {
    throw new Error('Grok returned empty image response');
  }

  // Return a data URL rather than bare `base64`, for the same reason
  // `openrouter-image-adapter` does: the orchestration layer wraps a bare
  // `base64` as `data:image/png` unconditionally, which mislabels the JPEG that
  // xAI returns inline. Carrying the type in the URL keeps the bytes and their
  // type together, and callers already prefer `url` when it is present.
  const inline = imageData.b64_json as string | undefined;
  const mimeType = inline ? inlineImageMimeType(inline) : undefined;

  return {
    url: imageData.url ?? (inline ? `data:${mimeType};base64,${inline}` : undefined),
    base64: inline,
    mimeType,
    width: options.width || 1024,
    height: options.height || 1024,
  };
}
