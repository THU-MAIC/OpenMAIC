import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateWithGrokVideo } from '@/lib/media/adapters/grok-video-adapter';
import { generateWithHappyHorse } from '@/lib/media/adapters/happyhorse-adapter';
import { generateWithKling } from '@/lib/media/adapters/kling-adapter';
import { generateWithMiniMaxVideo } from '@/lib/media/adapters/minimax-video-adapter';
import { generateWithSeedance } from '@/lib/media/adapters/seedance-adapter';

const fetchMock = vi.fn();

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('polled video adapter compatibility', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(['doubao-seedance-2-0-260128', 'doubao-seedance-1-0-lite-t2v-250428'])(
    'keeps Seedance task routing and success extraction unchanged for %s',
    async (model) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'seed-task' })).mockResolvedValueOnce(
        jsonResponse({
          id: 'seed-task',
          model,
          status: 'succeeded',
          content: { video_url: 'https://cdn.example.com/seed.mp4' },
          resolution: '720p',
          ratio: '16:9',
          duration: 5,
        }),
      );

      const promise = generateWithSeedance(
        { providerId: 'seedance', apiKey: 'seed-key', model },
        { prompt: 'a paper city', aspectRatio: '16:9', resolution: '720p', duration: 5 },
      );

      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model).toBe(model);
      await vi.advanceTimersByTimeAsync(1);

      await expect(promise).resolves.toEqual({
        url: 'https://cdn.example.com/seed.mp4',
        duration: 5,
        width: 1280,
        height: 720,
      });
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/seed-task',
      );
    },
  );

  it('preserves the Seedance timeout message and exact poll count', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'seed-timeout' })).mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          id: 'seed-timeout',
          model: 'doubao-seedance-2-0-260128',
          status: 'running',
        }),
      ),
    );
    const promise = generateWithSeedance(
      { providerId: 'seedance', apiKey: 'seed-key', model: 'doubao-seedance-2-0-260128' },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'Seedance video generation timed out after 300s (task: seed-timeout)',
    );

    await vi.advanceTimersByTimeAsync(300_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(61);
  });

  it('keeps Kling task routing and success extraction unchanged', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          message: 'success',
          data: { task_id: 'kling-task', task_status: 'submitted' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          message: 'success',
          data: {
            task_id: 'kling-task',
            task_status: 'succeed',
            task_result: {
              videos: [
                {
                  id: 'video-1',
                  url: 'https://cdn.example.com/kling.mp4',
                  duration: '5',
                },
              ],
            },
          },
        }),
      );

    const promise = generateWithKling(
      {
        providerId: 'kling',
        apiKey: 'access:secret',
        baseUrl: 'https://kling.example',
        model: 'kling-v2-6',
      },
      { prompt: 'a paper city', aspectRatio: '16:9', duration: 5 },
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toEqual({
      url: 'https://cdn.example.com/kling.mp4',
      duration: 5,
      width: 1280,
      height: 720,
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://kling.example/v1/videos/text2video/kling-task',
    );
  });

  it('preserves the Kling timeout message and exact poll count', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          message: 'success',
          data: { task_id: 'kling-timeout', task_status: 'submitted' },
        }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            code: 0,
            message: 'success',
            data: { task_id: 'kling-timeout', task_status: 'processing' },
          }),
        ),
      );
    const promise = generateWithKling(
      {
        providerId: 'kling',
        apiKey: 'access:secret',
        baseUrl: 'https://kling.example',
        model: 'kling-v2-6',
      },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'Kling video generation timed out after 600s (task: kling-timeout)',
    );

    await vi.advanceTimersByTimeAsync(600_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(121);
  });

  it('preserves the Kling terminal failure message', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          message: 'success',
          data: { task_id: 'kling-failed', task_status: 'submitted' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          message: 'success',
          data: {
            task_id: 'kling-failed',
            task_status: 'failed',
            task_status_msg: 'content rejected',
          },
        }),
      );
    const promise = generateWithKling(
      {
        providerId: 'kling',
        apiKey: 'access:secret',
        baseUrl: 'https://kling.example',
        model: 'kling-v2-6',
      },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'Kling video generation failed: content rejected',
    );

    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps Grok task routing and success extraction unchanged', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request_id: 'grok-request' }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'done',
          video: { url: 'https://cdn.example.com/grok.mp4', duration: 6 },
          model: 'grok-imagine-video',
        }),
      );

    const promise = generateWithGrokVideo(
      {
        providerId: 'grok-video',
        apiKey: 'grok-key',
        baseUrl: 'https://grok.example/v1',
        model: 'grok-imagine-video',
      },
      { prompt: 'a paper city', aspectRatio: '16:9', duration: 6 },
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toEqual({
      url: 'https://cdn.example.com/grok.mp4',
      duration: 6,
      width: 1280,
      height: 720,
    });
    expect(fetchMock.mock.calls[1][0]).toBe('https://grok.example/v1/videos/grok-request');
  });

  it('preserves the Grok timeout message and exact poll count', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request_id: 'grok-timeout' }))
      .mockImplementation(() => Promise.resolve(jsonResponse({ status: 'pending', progress: 50 })));
    const promise = generateWithGrokVideo(
      {
        providerId: 'grok-video',
        apiKey: 'grok-key',
        baseUrl: 'https://grok.example/v1',
        model: 'grok-imagine-video',
      },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'Grok video generation timed out after 600s (request: grok-timeout)',
    );

    await vi.advanceTimersByTimeAsync(600_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(61);
  });

  it('preserves the Grok terminal failure message', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ request_id: 'grok-failed' }))
      .mockResolvedValueOnce(
        jsonResponse({ status: 'failed', progress: 42, model: 'grok-imagine-video' }),
      );
    const promise = generateWithGrokVideo(
      {
        providerId: 'grok-video',
        apiKey: 'grok-key',
        baseUrl: 'https://grok.example/v1',
        model: 'grok-imagine-video',
      },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'Grok video generation failed: {"status":"failed","progress":42,"model":"grok-imagine-video"}',
    );

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps HappyHorse task routing and success extraction unchanged', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          output: { task_id: 'horse-task', task_status: 'PENDING' },
          request_id: 'request-1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          output: {
            task_id: 'horse-task',
            task_status: 'SUCCEEDED',
            video_url: 'https://cdn.example.com/horse.mp4',
          },
          usage: { duration: 5, SR: 720, ratio: '16:9' },
        }),
      );

    const promise = generateWithHappyHorse(
      { providerId: 'happyhorse', apiKey: 'horse-key', model: 'happyhorse-1.0-t2v' },
      { prompt: 'a paper city', aspectRatio: '16:9', resolution: '720p', duration: 5 },
    );

    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toEqual({
      url: 'https://cdn.example.com/horse.mp4',
      duration: 5,
      width: 1280,
      height: 720,
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://dashscope.aliyuncs.com/api/v1/tasks/horse-task',
    );
  });

  it('preserves the HappyHorse timeout message and exact poll count', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ output: { task_id: 'horse-timeout', task_status: 'PENDING' } }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ output: { task_id: 'horse-timeout', task_status: 'RUNNING' } }),
        ),
      );
    const promise = generateWithHappyHorse(
      { providerId: 'happyhorse', apiKey: 'horse-key', model: 'happyhorse-1.0-t2v' },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'HappyHorse video generation timed out after 600s (task: horse-timeout)',
    );

    await vi.advanceTimersByTimeAsync(600_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(41);
  });

  it('preserves the MiniMax terminal failure message', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ task_id: 'minimax-failed', base_resp: { status_code: 0, status_msg: '' } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: 'minimax-failed',
          status: 'Fail',
          base_resp: { status_code: 1008, status_msg: 'quota exceeded' },
        }),
      );
    const promise = generateWithMiniMaxVideo(
      { providerId: 'minimax-video', apiKey: 'minimax-key', model: 'MiniMax-Hailuo-2.3' },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'MiniMax Video generation failed: quota exceeded',
    );

    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves the MiniMax timeout message with the last status and exact poll count', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ task_id: 'minimax-timeout', base_resp: { status_code: 0, status_msg: '' } }),
      )
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            task_id: 'minimax-timeout',
            status: 'Processing',
            base_resp: { status_code: 0, status_msg: '' },
          }),
        ),
      );
    const promise = generateWithMiniMaxVideo(
      { providerId: 'minimax-video', apiKey: 'minimax-key', model: 'MiniMax-Hailuo-2.3' },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'MiniMax Video: timeout after 120 polls, last status: Processing',
    );

    await vi.advanceTimersByTimeAsync(600_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(121);
  });

  it('routes MiniMax H3 models through the v2 task API', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'h3-task' })).mockResolvedValueOnce(
      jsonResponse({
        task: { status: 'succeeded', content: { url: 'https://cdn.example.com/h3.mp4' } },
      }),
    );
    const promise = generateWithMiniMaxVideo(
      {
        providerId: 'minimax-video',
        apiKey: 'gateway-key',
        baseUrl: 'https://gateway.example/minimax/',
        model: 'minimax-h3',
      },
      { prompt: 'a paper city', aspectRatio: '9:16', resolution: '1080p', duration: 10 },
    );

    const [submitUrl, submitInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toBe('https://gateway.example/minimax/v2/video_generation');
    expect(submitInit.headers).toMatchObject({ Authorization: 'Bearer gateway-key' });
    expect(JSON.parse(submitInit.body as string)).toEqual({
      model: 'minimax-h3',
      resolution: '768P',
      duration: 6,
      ratio: '9:16',
      content: [{ type: 'text', text: 'a paper city' }],
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toEqual({
      url: 'https://cdn.example.com/h3.mp4',
      duration: 6,
      width: 768,
      height: 1366,
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://gateway.example/minimax/v2/query/video_generation/h3-task',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports MiniMax H3 v2 dimensions for the requested aspect ratio', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: 'h3-square' }))
      .mockResolvedValueOnce(
        jsonResponse({ status: 'succeeded', content: { url: 'https://cdn.example.com/sq.mp4' } }),
      );
    const promise = generateWithMiniMaxVideo(
      {
        providerId: 'minimax-video',
        apiKey: 'gateway-key',
        baseUrl: 'https://gateway.example/minimax',
        model: 'minimax-h3',
      },
      { prompt: 'a paper city', aspectRatio: '1:1' },
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toEqual({
      url: 'https://cdn.example.com/sq.mp4',
      duration: 6,
      width: 768,
      height: 768,
    });
  });

  it('reports a terminal MiniMax H3 v2 failure with its error message', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: 'h3-failed' }))
      .mockResolvedValueOnce(
        jsonResponse({ status: 'failed', error: { message: 'content moderation' } }),
      );
    const promise = generateWithMiniMaxVideo(
      {
        providerId: 'minimax-video',
        apiKey: 'gateway-key',
        baseUrl: 'https://gateway.example/minimax',
        model: 'minimax-h3-max',
      },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'MiniMax Video generation failed: content moderation',
    );

    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/minimax/v2/video_generation');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
