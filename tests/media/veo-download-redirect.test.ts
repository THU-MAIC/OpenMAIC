/**
 * The Veo file URI may answer with a redirect to storage (Google's example
 * downloads it with `curl -L`). With a `downloadFetchImpl` injected, the
 * adapter follows it through the per-hop redirect loop: the hop is
 * re-validated and the API key does not cross to the other origin. Without
 * one, the download keeps refusing redirects. DNS lookups are stubbed like the
 * fetch-with-redirect-validation tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock('node:dns', () => ({
  promises: {
    lookup: lookupMock,
  },
}));

const FILE_URI = 'https://veo.example/v1beta/files/abc:download?alt=media';
const STORAGE_URL = 'https://storage.public.example/veo/abc.mp4';

function doneOperation(): Response {
  return new Response(
    JSON.stringify({
      name: 'operations/veo-redirect',
      done: true,
      response: {
        generateVideoResponse: { generatedSamples: [{ video: { uri: FILE_URI } }] },
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function redirectToStorage(): Response {
  return new Response(null, { status: 302, headers: { Location: STORAGE_URL } });
}

describe('Veo video download redirect', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    lookupMock.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === 'storage.public.example') {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      throw new Error(`ENOTFOUND ${hostname}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follows a cross-origin 302 through the injected transport without the API key', async () => {
    const { generateWithVeo } = await import('@/lib/media/adapters/veo-adapter');
    const { fetchWithRedirectValidation } =
      await import('@/lib/server/fetch-with-redirect-validation');
    const hopFetch = vi
      .fn()
      .mockResolvedValueOnce(redirectToStorage())
      .mockResolvedValueOnce(
        new Response(new Uint8Array([112, 111, 108, 108, 101, 100]), {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' },
        }),
      );
    fetchMock.mockResolvedValueOnce(doneOperation());

    const result = await generateWithVeo(
      {
        providerId: 'veo',
        apiKey: 'veo-key',
        baseUrl: 'https://veo.example',
        model: 'veo-3.1-generate-preview',
        downloadFetchImpl: (input, init) =>
          fetchWithRedirectValidation(input, init, { fetchImpl: hopFetch }),
      },
      { prompt: 'a paper city' },
    );

    expect(result.url).toBe('data:video/mp4;base64,cG9sbGVk');
    expect(hopFetch).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = hopFetch.mock.calls[0];
    expect(String(firstUrl)).toBe(FILE_URI);
    expect(new Headers(firstInit.headers).get('x-goog-api-key')).toBe('veo-key');
    const [secondUrl, secondInit] = hopFetch.mock.calls[1];
    expect(String(secondUrl)).toBe(STORAGE_URL);
    expect(new Headers(secondInit.headers).has('x-goog-api-key')).toBe(false);
    // Only the submit went through the global fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses the redirect when no download transport is injected', async () => {
    const { generateWithVeo } = await import('@/lib/media/adapters/veo-adapter');
    fetchMock.mockResolvedValueOnce(doneOperation()).mockResolvedValueOnce(redirectToStorage());

    await expect(
      generateWithVeo(
        {
          providerId: 'veo',
          apiKey: 'veo-key',
          baseUrl: 'https://veo.example',
          model: 'veo-3.1-generate-preview',
        },
        { prompt: 'a paper city' },
      ),
    ).rejects.toThrow('Veo: Redirects are not allowed (HTTP 302)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
