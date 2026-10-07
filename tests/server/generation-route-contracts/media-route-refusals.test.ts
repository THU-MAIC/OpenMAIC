/**
 * Characterization: the answers the narration, image and video routes give
 * when a resolved connection cannot be used. They import nothing but the
 * routes, so they run unchanged against the routes before and after the steps
 * moved into lib/server/generation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveMediaSlot: vi.fn(),
  generateTTS: vi.fn(),
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
}));

vi.mock('@/lib/server/model-config/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-config/media')>()),
  resolveMediaSlot: mocks.resolveMediaSlot,
}));
vi.mock('@/lib/audio/tts-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: mocks.generateTTS,
}));
vi.mock('@/lib/media/image-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media/image-providers')>()),
  generateImage: mocks.generateImage,
}));
vi.mock('@/lib/media/video-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media/video-providers')>()),
  generateVideo: mocks.generateVideo,
}));
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: vi.fn() }));

function post(path: string, body: unknown): NextRequest {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function connection(providerId: string, extra: Record<string, unknown> = {}) {
  return {
    providerId,
    apiKey: 'key',
    managed: true,
    userEndpoint: false,
    origin: 'configuration',
    ...extra,
  };
}

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

describe('media generation route refusals', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it.each([
    [
      'no voice for a provider without a default',
      connection('unlisted-tts'),
      {},
      'MISSING_REQUIRED_FIELD',
      'Missing required field: ttsVoice',
    ],
    [
      'a browser-side provider',
      connection('browser-native-tts'),
      { ttsVoice: 'x' },
      'INVALID_REQUEST',
      'browser-native-tts must be handled client-side',
    ],
    [
      'the automatic voice without context',
      connection('voxcpm-tts'),
      { ttsVoice: 'voxcpm:auto' },
      'VOXCPM_AUTO_VOICE_REQUIRES_CONTEXT',
      'VoxCPM Auto Voice requires agent context',
    ],
    [
      'a keyed provider without a key',
      connection('openai-tts', { apiKey: undefined }),
      { ttsVoice: 'alloy' },
      'MISSING_API_KEY',
      'No API key configured for TTS provider: openai-tts',
    ],
  ])('POST /api/generate/tts answers %s with 400', async (_case, slot, extra, errorCode, error) => {
    mocks.resolveMediaSlot.mockResolvedValue(slot);
    const { POST } = await import('@/app/api/generate/tts/route');
    const response = await POST(
      post('/api/generate/tts', { text: 'Hello', audioId: 'a1', ...extra }),
    );
    expect(await answer(response)).toEqual({
      status: 400,
      body: { success: false, errorCode, error },
    });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a keyed provider without a key',
      connection('seedream', { apiKey: undefined }),
      401,
      'MISSING_API_KEY',
      'No API key configured for image provider: seedream',
    ],
    [
      'no model',
      connection('seedream', { origin: 'request' }),
      400,
      'MISSING_MODEL',
      'No model configured for image provider: seedream',
    ],
  ])('POST /api/generate/image answers %s', async (_case, slot, status, errorCode, error) => {
    mocks.resolveMediaSlot.mockResolvedValue(slot);
    const { POST } = await import('@/app/api/generate/image/route');
    const response = await POST(post('/api/generate/image', { prompt: 'A leaf' }));
    expect(await answer(response)).toEqual({
      status,
      body: { success: false, errorCode, error },
    });
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it.each([
    [
      'no key',
      connection('seedance', { apiKey: undefined }),
      401,
      'MISSING_API_KEY',
      'No API key configured for video provider: seedance',
    ],
    [
      'no model',
      connection('seedance', { origin: 'request' }),
      400,
      'MISSING_MODEL',
      'No model configured for video provider: seedance',
    ],
  ])('POST /api/generate/video answers %s', async (_case, slot, status, errorCode, error) => {
    mocks.resolveMediaSlot.mockResolvedValue(slot);
    const { POST } = await import('@/app/api/generate/video/route');
    const response = await POST(post('/api/generate/video', { prompt: 'A river' }));
    expect(await answer(response)).toEqual({
      status,
      body: { success: false, errorCode, error },
    });
    expect(mocks.generateVideo).not.toHaveBeenCalled();
  });
});
