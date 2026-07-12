import { afterEach, describe, expect, it, vi } from 'vitest';

import { testGrokImageConnectivity } from '@/lib/media/adapters/grok-image-adapter';
import { testGrokVideoConnectivity } from '@/lib/media/adapters/grok-video-adapter';
import { testHappyHorseConnectivity } from '@/lib/media/adapters/happyhorse-adapter';
import { testKlingConnectivity } from '@/lib/media/adapters/kling-adapter';
import { testMiniMaxImageConnectivity } from '@/lib/media/adapters/minimax-image-adapter';
import { testMiniMaxVideoConnectivity } from '@/lib/media/adapters/minimax-video-adapter';
import { testNanoBananaConnectivity } from '@/lib/media/adapters/nano-banana-adapter';
import { testQwenImageConnectivity } from '@/lib/media/adapters/qwen-image-adapter';
import { testSeedanceConnectivity } from '@/lib/media/adapters/seedance-adapter';
import { testSeedreamConnectivity } from '@/lib/media/adapters/seedream-adapter';
import { testVeoConnectivity } from '@/lib/media/adapters/veo-adapter';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

type ConnectivityResult = { success: boolean; message: string };

interface AuthOnlyCase {
  name: string;
  providerName: string;
  probe: () => Promise<ConnectivityResult>;
  assertRequest: () => void;
}

const authOnlyCases: AuthOnlyCase[] = [
  {
    name: 'Seedream',
    providerName: 'Seedream',
    probe: () =>
      testSeedreamConnectivity({
        providerId: 'seedream',
        apiKey: 'seedream-key',
        baseUrl: 'https://seedream.example.com/api/plan/v3/',
        model: 'seedream-test',
      }),
    assertRequest: () => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://seedream.example.com/api/plan/v3/images/generations',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer seedream-key',
          },
          body: JSON.stringify({ model: 'seedream-test', prompt: '', size: '1x1' }),
        },
      );
    },
  },
  {
    name: 'Qwen Image',
    providerName: 'Qwen Image',
    probe: () =>
      testQwenImageConnectivity({
        providerId: 'qwen-image',
        apiKey: 'qwen-key',
        baseUrl: 'https://qwen.example.com',
        model: 'qwen-test',
      }),
    assertRequest: () => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://qwen.example.com/api/v1/services/aigc/multimodal-generation/generation',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer qwen-key',
          },
          body: JSON.stringify({
            model: 'qwen-test',
            input: { messages: [{ role: 'user', content: [{ text: '' }] }] },
            parameters: { size: '1*1' },
          }),
        },
      );
    },
  },
  {
    name: 'Grok Image',
    providerName: 'Grok Image',
    probe: () =>
      testGrokImageConnectivity({
        providerId: 'grok-image',
        apiKey: 'grok-image-key',
        baseUrl: 'https://grok-image.example.com/v1',
        model: 'grok-image-test',
      }),
    assertRequest: () => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://grok-image.example.com/v1/images/generations',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer grok-image-key',
          },
          body: JSON.stringify({ model: 'grok-image-test', prompt: '', n: 1 }),
        },
      );
    },
  },
  {
    name: 'Grok Video',
    providerName: 'Grok Video',
    probe: () =>
      testGrokVideoConnectivity({
        providerId: 'grok-video',
        apiKey: 'grok-video-key',
        baseUrl: 'https://grok-video.example.com/v1',
        model: 'grok-video-test',
      }),
    assertRequest: () => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://grok-video.example.com/v1/videos/generations',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer grok-video-key',
          },
          body: JSON.stringify({ model: 'grok-video-test', prompt: '' }),
        },
      );
    },
  },
  {
    name: 'Seedance',
    providerName: 'Seedance',
    probe: () =>
      testSeedanceConnectivity({
        providerId: 'seedance',
        apiKey: 'seedance-key',
        baseUrl: 'https://seedance.example.com/api/plan/v3/',
      }),
    assertRequest: () => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://seedance.example.com/api/plan/v3/contents/generations/tasks/connectivity-test-nonexistent',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer seedance-key' },
        },
      );
    },
  },
  {
    name: 'Kling',
    providerName: 'Kling',
    probe: () =>
      testKlingConnectivity({
        providerId: 'kling',
        apiKey: 'access-key:secret-key',
        baseUrl: 'https://kling.example.com',
      }),
    assertRequest: () => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://kling.example.com/v1/videos/text2video/connectivity-test',
        {
          method: 'GET',
          headers: {
            Authorization: expect.stringMatching(/^Bearer [^.]+\.[^.]+\.[^.]+$/),
          },
        },
      );
    },
  },
  {
    name: 'HappyHorse',
    providerName: 'HappyHorse',
    probe: () =>
      testHappyHorseConnectivity({
        providerId: 'happyhorse',
        apiKey: 'happyhorse-key',
        baseUrl: 'https://happyhorse.example.com/',
      }),
    assertRequest: () => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://happyhorse.example.com/api/v1/tasks/connectivity-test-nonexistent',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer happyhorse-key' },
        },
      );
    },
  },
];

afterEach(() => {
  fetchMock.mockReset();
});

describe('auth-only connectivity probe characterization', () => {
  it.each(authOnlyCases)(
    '$name preserves its request and treats a non-auth HTTP error as connected',
    async ({ providerName, probe, assertRequest }) => {
      fetchMock.mockResolvedValueOnce(
        new Response('server error', { status: 500, statusText: 'Internal Server Error' }),
      );

      await expect(probe()).resolves.toEqual({
        success: true,
        message: `Connected to ${providerName}`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      assertRequest();
    },
  );

  it.each(authOnlyCases)(
    '$name preserves its 401 verdict and message',
    async ({ providerName, probe }) => {
      fetchMock.mockResolvedValueOnce(new Response('invalid key', { status: 401 }));

      await expect(probe()).resolves.toEqual({
        success: false,
        message: `${providerName} auth failed (401): invalid key`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(authOnlyCases)(
    '$name preserves its network-error verdict and message',
    async ({ providerName, probe }) => {
      fetchMock.mockRejectedValueOnce(new Error('offline'));

      await expect(probe()).resolves.toEqual({
        success: false,
        message: `${providerName} connectivity error: Error: offline`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps Kling credential parsing inside the connectivity error boundary', async () => {
    const result = await testKlingConnectivity({
      providerId: 'kling',
      apiKey: 'malformed-key',
    });

    expect(result).toEqual({
      success: false,
      message: 'Kling connectivity error: Error: Kling apiKey must be "accessKey:secretKey" format',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('non-matching connectivity probe sentinels', () => {
  it('keeps MiniMax Image strict for non-2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ base_resp: { status_msg: 'image unavailable' } }), {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    await expect(
      testMiniMaxImageConnectivity({ providerId: 'minimax-image', apiKey: 'minimax-key' }),
    ).resolves.toEqual({ success: false, message: 'API error: image unavailable' });
  });

  it('keeps MiniMax Video strict for non-2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ base_resp: { status_msg: 'video unavailable' } }), {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    await expect(
      testMiniMaxVideoConnectivity({ providerId: 'minimax-video', apiKey: 'minimax-key' }),
    ).resolves.toEqual({ success: false, message: 'API error: video unavailable' });
  });

  const googleCases = [
    {
      name: 'Veo',
      probe: () =>
        testVeoConnectivity({
          providerId: 'veo',
          apiKey: 'google-key',
          baseUrl: 'https://google.example.com',
          model: 'veo-test',
        }),
      successMessage: 'Connected to Veo (veo-test)',
      failureMessage:
        'Invalid API key or unauthorized (400). Check your API Key and Base URL match the same provider.',
    },
    {
      name: 'Nano Banana',
      probe: () =>
        testNanoBananaConnectivity({
          providerId: 'nano-banana',
          apiKey: 'google-key',
          baseUrl: 'https://google.example.com',
          model: 'nano-test',
        }),
      successMessage: 'Connected to Nano Banana (nano-test)',
      failureMessage:
        'Invalid API key or unauthorized (400). Check your API Key and Base URL match the same provider.',
    },
  ];

  it.each(googleCases)(
    '$name keeps its query-to-header auth fallback',
    async ({ probe, successMessage }) => {
      fetchMock
        .mockResolvedValueOnce(new Response('query auth failed', { status: 401 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      await expect(probe()).resolves.toEqual({ success: true, message: successMessage });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://google.example.com/v1beta/models?key=google-key',
        { method: 'GET' },
      );
      expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://google.example.com/v1beta/models', {
        method: 'GET',
        headers: { 'x-goog-api-key': 'google-key' },
      });
    },
  );

  it.each(googleCases)(
    '$name keeps treating a final 400 as an invalid-key failure',
    async ({ probe, failureMessage }) => {
      fetchMock
        .mockResolvedValueOnce(new Response('bad query key', { status: 400 }))
        .mockResolvedValueOnce(new Response('bad header key', { status: 400 }));

      await expect(probe()).resolves.toEqual({ success: false, message: failureMessage });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
});
