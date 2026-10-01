import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepRefusal } from '@/lib/server/generation/steps/context';
import { generateImageStep } from '@/lib/server/generation/steps/image';
import { generateVideoStep } from '@/lib/server/generation/steps/video';
import type { MediaConnection } from '@/lib/server/model-config/media';

import { jsonRequest, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
  resolveMediaSlot: vi.fn(),
  recordGenerationUsage: vi.fn(),
}));

vi.mock('@/lib/media/image-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media/image-providers')>()),
  generateImage: mocks.generateImage,
}));
vi.mock('@/lib/media/video-providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/media/video-providers')>()),
  generateVideo: mocks.generateVideo,
}));
vi.mock('@/lib/server/model-config/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-config/media')>()),
  resolveMediaSlot: mocks.resolveMediaSlot,
}));
vi.mock('@/lib/server/usage-storage', () => ({
  recordGenerationUsage: mocks.recordGenerationUsage,
}));

const imageConnection: MediaConnection = {
  providerId: 'seedream',
  apiKey: 'image-key',
  managed: true,
  userEndpoint: false,
  origin: 'configuration',
};
const videoConnection: MediaConnection = {
  providerId: 'seedance',
  apiKey: 'video-key',
  managed: true,
  userEndpoint: false,
  origin: 'configuration',
};

const imageResult = { url: 'https://cdn.example.com/a.png', width: 1024, height: 576 };
const videoResult = { url: 'https://cdn.example.com/a.mp4', width: 1280, height: 720, duration: 5 };

/**
 * The provider config without its fetch transports: the route runs on a fresh
 * module registry, so its transports are other instances of the same functions.
 */
function providerCall(call: unknown[] | undefined) {
  const [config, ...rest] = call ?? [];
  const {
    fetchImpl: _fetchImpl,
    downloadFetchImpl: _downloadFetchImpl,
    ...plain
  } = config as Record<string, unknown>;
  return [plain, ...rest];
}

describe('image step', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.generateImage.mockReset();
    mocks.generateImage.mockResolvedValue(imageResult);
    mocks.resolveMediaSlot.mockReset();
    mocks.resolveMediaSlot.mockResolvedValue(imageConnection);
    mocks.recordGenerationUsage.mockReset();
  });

  it("generates with the slot's first catalogue model when the slot names none", async () => {
    const result = await generateImageStep(
      { options: { prompt: 'A leaf', aspectRatio: '16:9' }, connection: imageConnection },
      { log: testLogger() },
    );
    expect(result).toEqual(imageResult);
    const [config, options] = providerCall(mocks.generateImage.mock.calls[0]);
    expect(config).toMatchObject({ providerId: 'seedream', apiKey: 'image-key' });
    expect((config as { model?: string }).model).toBeTruthy();
    expect(options).toMatchObject({ prompt: 'A leaf' });
    expect(mocks.recordGenerationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', quantity: 1 }),
    );
  });

  it('refuses a keyed provider without a key', async () => {
    const failure = await generateImageStep(
      { options: { prompt: 'A leaf' }, connection: { ...imageConnection, apiKey: undefined } },
      { log: testLogger() },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StepRefusal);
    expect((failure as StepRefusal).reason).toBe('missing-api-key');
  });

  it('answers the route exactly as the step does', async () => {
    const body = { prompt: 'A leaf', aspectRatio: '16:9' as const };
    const { POST } = await import('@/app/api/generate/image/route');
    const response = await POST(jsonRequest('http://localhost/api/generate/image', body));
    const routedCall = providerCall(mocks.generateImage.mock.calls[0]);
    mocks.generateImage.mockClear();
    const stepped = await generateImageStep(
      { options: body, connection: imageConnection },
      { log: testLogger() },
    );
    expect(await response.json()).toEqual({ success: true, result: stepped });
    expect(providerCall(mocks.generateImage.mock.calls[0])).toEqual(routedCall);
  });

  it('answers a refusal with the 401 the route always answered', async () => {
    mocks.resolveMediaSlot.mockResolvedValue({ ...imageConnection, apiKey: undefined });
    const { POST } = await import('@/app/api/generate/image/route');
    const response = await POST(
      jsonRequest('http://localhost/api/generate/image', { prompt: 'A leaf' }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ errorCode: 'MISSING_API_KEY' });
  });
});

describe('video step', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.generateVideo.mockReset();
    mocks.generateVideo.mockResolvedValue(videoResult);
    mocks.resolveMediaSlot.mockReset();
    mocks.resolveMediaSlot.mockResolvedValue(videoConnection);
    mocks.recordGenerationUsage.mockReset();
  });

  it('calls the provider exactly as before when no task control is asked for', async () => {
    const result = await generateVideoStep(
      { options: { prompt: 'A river' }, connection: videoConnection },
      { log: testLogger() },
    );
    expect(result).toEqual(videoResult);
    expect(mocks.generateVideo.mock.calls[0]).toHaveLength(2);
    expect(mocks.recordGenerationUsage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'video', quantity: 5 }),
    );
  });

  it('hands the provider task hooks to the provider wait', async () => {
    const onProviderTask = vi.fn();
    await generateVideoStep(
      { options: { prompt: 'A river' }, connection: videoConnection, onProviderTask },
      { log: testLogger() },
    );
    expect(mocks.generateVideo.mock.calls[0]![2]).toEqual({
      onSubmitted: onProviderTask,
      resumeTaskId: undefined,
    });

    await generateVideoStep(
      { options: { prompt: 'A river' }, connection: videoConnection, resumeTaskId: 'task-7' },
      { log: testLogger() },
    );
    expect(mocks.generateVideo.mock.calls[1]![2]).toEqual({
      onSubmitted: undefined,
      resumeTaskId: 'task-7',
    });
  });

  it('refuses a provider without a key', async () => {
    const failure = await generateVideoStep(
      { options: { prompt: 'A river' }, connection: { ...videoConnection, apiKey: undefined } },
      { log: testLogger() },
    ).catch((error: unknown) => error);
    expect((failure as StepRefusal).reason).toBe('missing-api-key');
  });

  it('answers the route exactly as the step does', async () => {
    const body = { prompt: 'A river', duration: 5 };
    const { POST } = await import('@/app/api/generate/video/route');
    const response = await POST(jsonRequest('http://localhost/api/generate/video', body));
    const routedCall = providerCall(mocks.generateVideo.mock.calls[0]);
    mocks.generateVideo.mockClear();
    const stepped = await generateVideoStep(
      { options: body, connection: videoConnection },
      { log: testLogger() },
    );
    expect(await response.json()).toEqual({ success: true, result: stepped });
    expect(providerCall(mocks.generateVideo.mock.calls[0])).toEqual(routedCall);
  });
});
