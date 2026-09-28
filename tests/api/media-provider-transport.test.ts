/**
 * Image/video generation and verification routes run every provider request
 * through the strict provider transport.
 *
 * These tests drive the real routes, the real adapters (OpenAI Image for the
 * image routes, Seedance for the video routes), the real SSRF guard and the
 * real pinned transport against loopback HTTP servers. Stubbed:
 *
 *  - `@/lib/server/provider-config` (partially), so each test chooses whether
 *    the provider is server-managed and what the server resolves;
 *  - `@/lib/server/usage-storage`, so usage recording is a no-op;
 *  - `node:dns`, so a hostname can answer the URL-layer guard and the
 *    connect-time lookup differently (DNS rebinding); and
 *  - the global `fetch`, replaced with a spy that must never be called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

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
  isServerConfiguredProvider: vi.fn(),
  managedBaseUrl: { value: undefined as string | undefined },
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-config')>();
  const baseUrl = (_id: string, clientBaseUrl?: string) =>
    clientBaseUrl ?? mocks.managedBaseUrl.value;
  const apiKey = (_id: string, clientKey?: string) => clientKey ?? 'server-key';
  const model = (_id: string, clientModel?: string) => clientModel ?? 'server-model';
  return {
    ...actual,
    isServerConfiguredProvider: mocks.isServerConfiguredProvider,
    isServerProviderDisabled: () => false,
    resolveImageApiKey: apiKey,
    resolveImageBaseUrl: baseUrl,
    resolveImageModel: model,
    resolveServerImageProviderId: () => undefined,
    resolveVideoApiKey: apiKey,
    resolveVideoBaseUrl: baseUrl,
    resolveVideoModel: model,
    resolveServerVideoProviderId: () => undefined,
  };
});

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
  headers: Record<string, string>,
  body: Record<string, unknown> = {},
) {
  const request = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const res = await handler(request as unknown as NextRequest);
  return { status: res.status, json: await res.json() };
}

const imageHeaders = (baseUrl: string) => ({
  'x-image-provider': 'openai-image',
  'x-image-model': 'gpt-image-2',
  'x-api-key': 'client-key',
  'x-base-url': baseUrl,
});

const videoHeaders = (baseUrl: string) => ({
  'x-video-provider': 'seedance',
  'x-video-model': 'seedance-test',
  'x-api-key': 'client-key',
  'x-base-url': baseUrl,
});

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
    mocks.isServerConfiguredProvider.mockReset();
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    mocks.managedBaseUrl.value = undefined;
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
    globalFetch.mockReset();
    globalFetch.mockRejectedValue(new Error('global fetch must not be used'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(async () => {
    expect(globalFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    await closeLoopbackServers();
  });

  describe('with the operator local-network opt-in', () => {
    beforeEach(() => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';
    });

    it('generates an image through the pinned transport', async () => {
      const provider = await answering(200, '{"data":[{"url":"https://cdn.example/x.png"}]}');

      const res = await call(
        generateImagePOST,
        '/api/generate/image',
        imageHeaders(provider.origin),
        {
          prompt: 'a cat',
        },
      );

      expect(res.status).toBe(200);
      expect(res.json.result.url).toBe('https://cdn.example/x.png');
      expect(provider.lastUrl()).toBe('/images/generations');
      expect(provider.lastHeaders()!.authorization).toBe('Bearer client-key');
    });

    it('never echoes an image provider error body', async () => {
      const provider = await answering(500, 'internal-secret-body');

      const res = await call(
        generateImagePOST,
        '/api/generate/image',
        imageHeaders(provider.origin),
        {
          prompt: 'a cat',
        },
      );

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

      const res = await call(
        generateImagePOST,
        '/api/generate/image',
        imageHeaders(provider.origin),
        {
          prompt: 'a cat',
        },
      );

      expect(res.status).toBe(400);
      expect(res.json.errorCode).toBe('CONTENT_SENSITIVE');
      expect(JSON.stringify(res.json)).not.toContain('internal-secret');
    });

    it('refuses an image provider redirect and never follows it', async () => {
      const target = await answering(200, '{"data":[{"url":"https://cdn.example/x.png"}]}');
      const origin = await answering(307, '', { Location: `${target.origin}/images/generations` });

      const res = await call(
        generateImagePOST,
        '/api/generate/image',
        imageHeaders(origin.origin),
        {
          prompt: 'a cat',
        },
      );

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
          imageHeaders(provider.origin),
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

      const res = await call(
        verifyImagePOST,
        '/api/verify-image-provider',
        imageHeaders(origin.origin),
      );

      expect(res.json.error).toBe('OpenAI Image connectivity error: Redirects are not allowed');
      expect(target.requests()).toBe(0);
    });

    it('answers a refused video provider connection with the fixed message', async () => {
      const res = await call(
        verifyVideoPOST,
        '/api/verify-video-provider',
        videoHeaders(`http://127.0.0.1:${await closedPort()}`),
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

    it('verifies a video provider through the pinned transport', async () => {
      const provider = await answering(404, '{"error":"task not found"}');

      const res = await call(
        verifyVideoPOST,
        '/api/verify-video-provider',
        videoHeaders(provider.origin),
      );

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

      const res = await call(
        generateVideoPOST,
        '/api/generate/video',
        videoHeaders(provider.origin),
        {
          prompt: 'a cat',
        },
      );

      expect(res).toEqual({
        status: 500,
        json: { success: false, errorCode: 'INTERNAL_ERROR', error: 'Video generation failed' },
      });
      expect(provider.lastUrl()).toBe('/api/v3/contents/generations/tasks');
    });
  });

  it('ignores the client base URL for a server-managed image provider', async () => {
    // No opt-in: a server-managed base URL is operator configuration and may
    // point at a local network.
    const managed = await answering(200, '{}');
    const clientTarget = await answering(200, '{}');
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.managedBaseUrl.value = managed.origin;

    const res = await call(
      verifyImagePOST,
      '/api/verify-image-provider',
      imageHeaders(clientTarget.origin),
    );

    expect(res.status).toBe(200);
    expect(managed.requests()).toBe(1);
    expect(managed.lastHeaders()!.authorization).toBe('Bearer server-key');
    expect(clientTarget.requests()).toBe(0);
  });

  it('generates through a server-managed local provider without the opt-in', async () => {
    const managed = await answering(200, '{"data":[{"url":"https://cdn.example/x.png"}]}');
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.managedBaseUrl.value = managed.origin;

    const res = await call(generateImagePOST, '/api/generate/image', imageHeaders(''), {
      prompt: 'a cat',
    });

    expect(res.status).toBe(200);
    expect(managed.requests()).toBe(1);
  });

  it('still refuses cloud metadata as a server-managed base URL', async () => {
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.managedBaseUrl.value = 'http://169.254.169.254/v1';

    const res = await call(generateImagePOST, '/api/generate/image', imageHeaders(''), {
      prompt: 'a cat',
    });

    expect(res.json).toEqual({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      error: 'Image generation failed',
    });
  });

  it.each([
    ['generate image', generateImagePOST, '/api/generate/image', imageHeaders],
    ['verify video', verifyVideoPOST, '/api/verify-video-provider', videoHeaders],
  ] as const)(
    '%s refuses a client-supplied loopback base URL without the opt-in',
    async (_name, handler, path, headers) => {
      const target = await answering(200, '{"data":[{"url":"https://cdn.example/x.png"}]}');

      const res = await call(handler, path, headers(target.origin), { prompt: 'a cat' });

      expect(res.status).toBe(403);
      expect(res.json.errorCode).toBe('INVALID_URL');
      expect(target.requests()).toBe(0);
    },
  );

  it.each([
    ['generate image', generateImagePOST, '/api/generate/image', imageHeaders],
    ['verify image', verifyImagePOST, '/api/verify-image-provider', imageHeaders],
    ['generate video', generateVideoPOST, '/api/generate/video', videoHeaders],
    ['verify video', verifyVideoPOST, '/api/verify-video-provider', videoHeaders],
  ] as const)(
    '%s refuses a host that rebinds to loopback between validation and connect',
    async (_name, handler, path, headers) => {
      const trap = await answering(200, '{"data":[{"url":"https://cdn.example/x.png"}]}');

      const res = await call(handler, path, headers(`http://rebind.test:${trap.port}`), {
        prompt: 'a cat',
      });

      expect(mocks.callbackLookup).toHaveBeenCalledWith(
        'rebind.test',
        expect.anything(),
        expect.any(Function),
      );
      expect(res.json.success).toBe(false);
      expect(trap.requests()).toBe(0);
    },
  );

  it('refuses a client base URL with a query string before any request', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const target = await answering(200, '{}');

    const res = await call(
      generateImagePOST,
      '/api/generate/image',
      imageHeaders(`${target.origin}/internal?`),
      { prompt: 'a cat' },
    );

    expect(res.status).toBe(403);
    expect(res.json.error).toBe('Base URL must not contain a query string or fragment');
    expect(target.requests()).toBe(0);
  });
});
