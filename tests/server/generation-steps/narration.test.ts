import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import { synthesizeNarration } from '@/lib/server/generation/steps/narration';
import type { MediaConnection } from '@/lib/server/model-config/media';

import { jsonRequest, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({
  generateTTS: vi.fn(),
  resolveMediaSlot: vi.fn(),
  recordGenerationUsage: vi.fn(),
}));

vi.mock('@/lib/audio/tts-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: mocks.generateTTS,
}));
vi.mock('@/lib/server/model-config/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-config/media')>()),
  resolveMediaSlot: mocks.resolveMediaSlot,
}));
vi.mock('@/lib/server/usage-storage', () => ({
  recordGenerationUsage: mocks.recordGenerationUsage,
}));

const connection: MediaConnection = {
  providerId: 'openai-tts',
  modelId: 'gpt-4o-mini-tts',
  apiKey: 'server-key',
  managed: true,
  userEndpoint: false,
  origin: 'configuration',
};

describe('narration step', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.generateTTS.mockReset();
    mocks.generateTTS.mockResolvedValue({ audio: new Uint8Array([1, 2, 3]), format: 'mp3' });
    mocks.resolveMediaSlot.mockReset();
    mocks.resolveMediaSlot.mockResolvedValue(connection);
    mocks.recordGenerationUsage.mockReset();
  });

  it('speaks with the requested voice through the slot provider and records the usage', async () => {
    const trace: { providerId?: string; voice?: string } = {};
    const result = await synthesizeNarration(
      { text: 'Hello class', audioId: 'a1', connection, requestedVoice: 'nova', speed: 1.2, trace },
      { log: testLogger() },
    );

    expect(result).toEqual({
      audio: new Uint8Array([1, 2, 3]),
      format: 'mp3',
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
    });
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai-tts',
        voice: 'nova',
        speed: 1.2,
        apiKey: 'server-key',
        managed: true,
      }),
      'Hello class',
    );
    expect(trace).toEqual({ providerId: 'openai-tts', voice: 'nova' });
    expect(mocks.recordGenerationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'tts', quantity: 'Hello class'.length }),
    );
  });

  it("uses the provider's default voice for a voice chosen for another provider", async () => {
    await synthesizeNarration(
      {
        text: 'Hello',
        audioId: 'a1',
        connection,
        requestedProviderId: 'another-tts',
        requestedVoice: 'someone',
      },
      { log: testLogger() },
    );
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'alloy' }),
      'Hello',
    );
  });

  it.each([
    [{ ...connection, apiKey: undefined }, 'missing-api-key'],
    [{ ...connection, providerId: 'browser-native-tts' }, 'client-side-provider'],
  ] as const)('refuses what it cannot synthesize (%#)', async (refused, reason) => {
    const failure = await synthesizeNarration(
      { text: 'Hello', audioId: 'a1', connection: refused, requestedVoice: 'nova' },
      { log: testLogger() },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StepRefusal);
    expect((failure as StepRefusal).reason).toBe(reason);
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('answers the route exactly as the step does', async () => {
    const body = { text: 'Hello class', audioId: 'a1', ttsVoice: 'nova', ttsSpeed: 1.2 };
    const { POST } = await import('@/app/api/generate/tts/route');
    const response = await POST(jsonRequest('http://localhost/api/generate/tts', body));
    expect(response.status).toBe(200);
    const routedCall = mocks.generateTTS.mock.calls[0];

    mocks.generateTTS.mockClear();
    const stepped = await synthesizeNarration(
      { text: 'Hello class', audioId: 'a1', connection, requestedVoice: 'nova', speed: 1.2 },
      { log: testLogger() },
    );
    expect(await response.json()).toEqual({
      success: true,
      audioId: 'a1',
      base64: Buffer.from(stepped.audio).toString('base64'),
      format: stepped.format,
    });
    expect(mocks.generateTTS.mock.calls[0]).toEqual(routedCall);
  });

  it('answers a refusal with the 400 the route always answered', async () => {
    mocks.resolveMediaSlot.mockResolvedValue({ ...connection, apiKey: undefined });
    const { POST } = await import('@/app/api/generate/tts/route');
    const response = await POST(
      jsonRequest('http://localhost/api/generate/tts', { text: 'Hi', audioId: 'a1' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      errorCode: 'MISSING_API_KEY',
      error: 'No API key configured for TTS provider: openai-tts',
    });
  });
});
