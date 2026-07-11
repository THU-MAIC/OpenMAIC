import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VIDEO_PROVIDERS, normalizeVideoOptions } from '@/lib/media/video-providers';
import { generateWithMiniMaxVideo } from '@/lib/media/adapters/minimax-video-adapter';

describe('MiniMax video provider', () => {
  it('does not expose Hailuo 2.3 Fast in the current T2V-only model list', () => {
    const modelIds = VIDEO_PROVIDERS['minimax-video'].models.map((model) => model.id);

    expect(modelIds).toContain('MiniMax-Hailuo-2.3');
    expect(modelIds).not.toContain('MiniMax-Hailuo-2.3-Fast');
  });
});

describe('MiniMax video resolution mapping', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // The normalized default ('720p', the first supportedResolutions entry) must
  // submit MiniMax's real mid tier 768P — Hailuo 2.3 rejects 720P with
  // "2013 ... does not support resolution 720P". Regression for that bug.
  it.each([
    ['720p', '768P'],
    ['1080p', '1080P'],
    [undefined, '768P'],
  ])('maps OpenMAIC %s to MiniMax %s in the submit body', async (input, expected) => {
    vi.stubGlobal('fetch', fetchMock);
    // Submit returns a task_id; the first poll reports Success with a file, and
    // the file-retrieve returns a url — a clean single-pass generation so we can
    // inspect the submit request body (the part under test).
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ task_id: 't1', base_resp: { status_code: 0 } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'Success',
            file_id: 'f1',
            video_width: 1280,
            video_height: 720,
            base_resp: { status_code: 0 },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            file: { file_id: 'f1', download_url: 'https://cdn.example.com/v.mp4' },
            base_resp: { status_code: 0 },
          }),
          { status: 200 },
        ),
      );

    const promise = generateWithMiniMaxVideo(
      { providerId: 'minimax-video', apiKey: 'k', model: 'MiniMax-Hailuo-2.3' },
      normalizeVideoOptions('minimax-video', {
        prompt: 'hi',
        ...(input ? { resolution: input as '720p' | '1080p' } : {}),
      }),
    );
    // Drain the single inter-poll setTimeout so the loop reaches the response.
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result.url).toBe('https://cdn.example.com/v.mp4');

    const submitBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(submitBody.resolution).toBe(expected);
  });
});
