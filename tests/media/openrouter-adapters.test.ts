/**
 * OpenRouter image/video adapter contract tests.
 *
 * These pin the two things that are easy to get silently wrong: the request
 * shape sent to OpenRouter, and the job state machine on the video side
 * (submit → poll → download bytes). `fetch` is stubbed, so nothing bills.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateWithOpenRouterImage } from '@/lib/media/adapters/openrouter-image-adapter';
import { generateWithOpenRouterVideo } from '@/lib/media/adapters/openrouter-video-adapter';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenRouter image adapter', () => {
  it('posts to /images and returns the inline base64 image', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ created: 1, data: [{ b64_json: 'AAAA', media_type: 'image/png' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateWithOpenRouterImage(
      { providerId: 'openrouter-image', apiKey: 'k', model: 'openai/gpt-image-2' },
      { prompt: 'a fox', aspectRatio: '16:9' },
    );

    expect(result.base64).toBe('AAAA');
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'openai/gpt-image-2',
      prompt: 'a fox',
      aspect_ratio: '16:9',
      n: 1,
    });
  });

  it('throws when the response carries no image data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ created: 1, data: [] })),
    );
    await expect(
      generateWithOpenRouterImage(
        { providerId: 'openrouter-image', apiKey: 'k', model: 'openai/gpt-image-2' },
        { prompt: 'a fox' },
      ),
    ).rejects.toThrow(/no image data/i);
  });
});

describe('OpenRouter video adapter', () => {
  it('submits, polls until completed, then downloads the clip', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/videos')) {
        return jsonResponse({ id: 'job-1', status: 'pending', polling_url: 'x' }, 202);
      }
      if (url.endsWith('/videos/job-1')) {
        // First poll still running, second poll done.
        const done = calls.filter((c) => c.endsWith('/videos/job-1')).length > 1;
        return jsonResponse({ id: 'job-1', status: done ? 'completed' : 'in_progress' });
      }
      // Content download → raw bytes.
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = generateWithOpenRouterVideo(
      { providerId: 'openrouter-video', apiKey: 'k', model: 'google/veo-3.1' },
      { prompt: 'a fox running', aspectRatio: '16:9', duration: 5 },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;

    expect(result.url).toBe(`data:video/mp4;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
    expect(result.duration).toBe(5);
    expect(result.width).toBe(1280);
    expect(calls.at(-1)).toBe('https://openrouter.ai/api/v1/videos/job-1/content?index=0');

    const submitBody = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(submitBody).toMatchObject({
      model: 'google/veo-3.1',
      prompt: 'a fox running',
      aspect_ratio: '16:9',
      duration: 5,
    });
  });

  it('fails fast when the job reports a terminal failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/videos')
          ? jsonResponse({ id: 'job-2', status: 'pending', polling_url: 'x' }, 202)
          : jsonResponse({ id: 'job-2', status: 'failed', error: 'content policy' }),
      ),
    );

    const promise = generateWithOpenRouterVideo(
      { providerId: 'openrouter-video', apiKey: 'k', model: 'google/veo-3.1' },
      { prompt: 'nope' },
    );
    const assertion = expect(promise).rejects.toThrow(/failed: content policy/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});
