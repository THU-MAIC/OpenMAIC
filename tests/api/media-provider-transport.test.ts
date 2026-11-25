/**
 * Image/video generation and verification routes run every provider request
 * through the strict provider transport.
 *
 * These tests drive the real routes, the real adapters (OpenAI Image for the
 * image routes, Seedance for the video routes), the real SSRF guard and the
 * real pinned transport against loopback HTTP servers. Stubbed:
 *
 *  - `@/lib/server/usage-storage`, so usage recording is a no-op;
 *  - `node:dns`, so a hostname can answer the URL-layer guard and the
 *    connect-time lookup differently (DNS rebinding); and
 *  - the global `fetch`, replaced with a spy that must never be called.
 */
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

import { POST as generateImagePOST } from '@/app/api/generate/image/route';
import { POST as generateVideoPOST } from '@/app/api/generate/video/route';
import { POST as verifyImagePOST } from '@/app/api/verify-image-provider/route';
import { POST as verifyVideoPOST } from '@/app/api/verify-video-provider/route';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import {
  answerWith,
  closedPort,
  closeLoopbackServers,
  LOOPBACK_ANSWER,
  PUBLIC_ANSWER,
  startLoopback,
} from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: vi.fn() }));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

type RouteHandler = (req: NextRequest) => Promise<Response>;

async function call(
  handler: RouteHandler,
  path: string,
  provider: { capability: 'image' | 'video'; baseUrl: string },
  body: Record<string, unknown> = {},
) {
  const { capability, baseUrl } = provider;
  const preset = capability === 'image' ? 'openai-image' : 'seedance';
  const model = capability === 'image' ? 'gpt-image-2' : 'seedance-test';
  setDeploymentConfigForTests({
    layer: {
      source: 'deployment',
      config: {
        providers: { service: { preset, baseUrl, apiKey: 'server-key', models: [model] } },
        slots: { [capability]: `service:${model}` },
      },
    },
    legacy: false,
    notices: [],
  });
  const request = new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(path.startsWith('/api/verify-') ? { provider: 'service', model } : body),
  });
  const res = await handler(request);
  return { status: res.status, json: await res.json() };
}

const image = (baseUrl: string) => ({ capability: 'image' as const, baseUrl });
const video = (baseUrl: string) => ({ capability: 'video' as const, baseUrl });

function answering(status: number, body: string, headers: Record<string, string> = {}) {
  return startLoopback((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body);
  });
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('media provider routes on the strict transport', () => {
  beforeEach(() => {
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
    globalFetch.mockReset();
    globalFetch.mockRejectedValue(new Error('global fetch must not be used'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(async () => {
    expect(globalFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setDeploymentConfigForTests();
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    await closeLoopbackServers();
  });

  describe('with the operator local-network opt-in', () => {
    beforeEach(() => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';
    });

    it('generates an image through the provider transport', async () => {
      const provider = await answering(200, '{"data":[{"url":"https://cdn.example/x.png"}]}');

      const res = await call(generateImagePOST, '/api/generate/image', image(provider.origin), {
        prompt: 'a cat',
      });

      expect(res.status).toBe(200);
      expect(res.json.result.url).toBe('https://cdn.example/x.png');
      expect(provider.lastUrl()).toBe('/images/generations');
      expect(provider.lastHeaders()!.authorization).toBe('Bearer server-key');
    });

    it('never echoes an image provider error body', async () => {
      const provider = await answering(500, 'internal-secret-body');

      const res = await call(generateImagePOST, '/api/generate/image', image(provider.origin), {
        prompt: 'a cat',
      });

      expect(res).toEqual({
        status: 500,
        json: { success: false, errorCode: 'INTERNAL_ERROR', error: 'Image generation failed' },
      });
    });

    it('keeps the content-safety classification with a fixed message', async () => {
      const provider = await answering(
        400,
        '{"error":{"code":"OutputImageSensitiveContentDetected","message":"internal-secret"}}',
      );

      const res = await call(generateImagePOST, '/api/generate/image', image(provider.origin), {
        prompt: 'a cat',
      });

      expect(res.status).toBe(400);
      expect(res.json.errorCode).toBe('CONTENT_SENSITIVE');
      expect(JSON.stringify(res.json)).not.toContain('internal-secret');
    });

    it('refuses an image provider redirect and never follows it', async () => {
      const target = await answering(200, '{"data":[{"url":"https://cdn.example/x.png"}]}');
      const origin = await answering(307, '', { Location: `${target.origin}/images/generations` });

      const res = await call(generateImagePOST, '/api/generate/image', image(origin.origin), {
        prompt: 'a cat',
      });

      expect(res.json).toEqual({
        success: false,
        errorCode: 'INTERNAL_ERROR',
        error: 'Image generation failed',
      });
      expect(origin.requests()).toBe(1);
      expect(target.requests()).toBe(0);
    });

    it.each([401, 403])(
      'verifies an image provider %i with a fixed message and no body',
      async (status) => {
        const provider = await answering(status, 'internal-secret-body');

        const res = await call(
          verifyImagePOST,
          '/api/verify-image-provider',
          image(provider.origin),
        );

        expect(res).toEqual({
          status: 500,
          json: {
            success: false,
            errorCode: 'UPSTREAM_ERROR',
            error: `OpenAI Image auth failed (${status}), please check the API Key`,
          },
        });
        expect(provider.lastUrl()).toBe('/models/gpt-image-2');
      },
    );

    it('verifies an image provider redirect as refused without following it', async () => {
      const target = await answering(200, '{}');
      const origin = await answering(302, '', { Location: `${target.origin}/models/x` });

      const res = await call(verifyImagePOST, '/api/verify-image-provider', image(origin.origin));

      expect(res.json.error).toBe('OpenAI Image connectivity error: Redirects are not allowed');
      expect(target.requests()).toBe(0);
    });

    it('answers a refused video provider connection with the fixed message', async () => {
      const res = await call(
        verifyVideoPOST,
        '/api/verify-video-provider',
        video(`http://127.0.0.1:${await closedPort()}`),
      );

      expect(res).toEqual({
        status: 500,
        json: {
          success: false,
          errorCode: 'UPSTREAM_ERROR',
          error:
            'Seedance connectivity error: cannot reach the provider, please check the Base URL',
        },
      });
    });

    it('verifies a video provider through the provider transport', async () => {
      const provider = await answering(404, '{"error":"task not found"}');

      const res = await call(verifyVideoPOST, '/api/verify-video-provider', video(provider.origin));

      expect(res).toEqual({
        status: 200,
        json: { success: true, message: 'Connected to Seedance' },
      });
      expect(provider.lastUrl()).toBe(
        '/api/v3/contents/generations/tasks/connectivity-test-nonexistent',
      );
    });

    it('never echoes a video provider error body', async () => {
      const provider = await answering(500, 'internal-secret-body');

      const res = await call(generateVideoPOST, '/api/generate/video', video(provider.origin), {
        prompt: 'a cat',
      });

      expect(res).toEqual({
        status: 500,
        json: { success: false, errorCode: 'INTERNAL_ERROR', error: 'Video generation failed' },
      });
      expect(provider.lastUrl()).toBe('/api/v3/contents/generations/tasks');
    });
  });

  it('generates through a server-managed local provider without the opt-in', async () => {
    const managed = await answering(200, '{"data":[{"url":"https://cdn.example/x.png"}]}');

    const res = await call(generateImagePOST, '/api/generate/image', image(managed.origin), {
      prompt: 'a cat',
    });

    expect(res.status).toBe(200);
    expect(managed.requests()).toBe(1);
  });

  it('still refuses cloud metadata as a server-managed base URL', async () => {
    const res = await call(
      generateImagePOST,
      '/api/generate/image',
      image('http://169.254.169.254/v1'),
      {
        prompt: 'a cat',
      },
    );

    expect(res.json).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Image generation failed',
    });
  });

  it.each([
    '/api/generate/image',
    '/api/verify-image-provider',
    '/api/generate/video',
    '/api/verify-video-provider',
  ])('%s refuses an obsolete endpoint header before any provider request', async (path) => {
    vi.stubEnv('ACCESS_CODE', '');
    const response = await middleware(
      new NextRequest(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'x-base-url': 'https://provider.example.test' },
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('x-base-url');
    expect(mocks.callbackLookup).not.toHaveBeenCalled();
  });
});
