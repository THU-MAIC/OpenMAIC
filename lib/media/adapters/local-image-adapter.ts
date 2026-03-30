/**
 * Local Image Generation Adapter
 *
 * Connects to a local OpenAI-compatible image generation server
 * (e.g. SDXL-Turbo via FastAPI at http://localhost:8765)
 *
 * Start the server: ~/.local/share/openmaic-images/start.sh
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';

const DEFAULT_BASE_URL = 'http://localhost:8765';
const DEFAULT_MODEL = 'sdxl-turbo';

function resolveSize(options: ImageGenerationOptions): string {
  if (options.width && options.height) {
    return `${options.width}x${options.height}`;
  }
  const ratio = options.aspectRatio || '16:9';
  const map: Record<string, string> = {
    '16:9': '1024x576',
    '4:3': '1024x768',
    '1:1': '1024x1024',
    '9:16': '576x1024',
  };
  return map[ratio] || '1024x576';
}

export async function testLocalImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const data = await response.json();
      return { success: true, message: `Connected — ${data.model || 'local'} on ${data.gpu || 'GPU'}` };
    }
    return { success: false, message: `Server returned ${response.status}` };
  } catch (err) {
    return { success: false, message: `Cannot reach local image server at ${baseUrl} — is it running?` };
  }
}

export async function generateWithLocalImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const size = resolveSize(options);
  const [w, h] = size.split('x').map(Number);

  const response = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey || 'local'}`,
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODEL,
      prompt: options.prompt,
      size,
      response_format: 'b64_json',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Local image generation failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const imageData = data.data?.[0];
  if (!imageData) throw new Error('Local image server returned empty response');

  return {
    base64: imageData.b64_json,
    url: imageData.url,
    width: w || 1024,
    height: h || 576,
  };
}
