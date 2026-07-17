import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateWithGrokVideo } from '@/lib/media/adapters/grok-video-adapter';
import { generateWithHappyHorse } from '@/lib/media/adapters/happyhorse-adapter';
import { generateWithKling } from '@/lib/media/adapters/kling-adapter';
import { generateWithMiniMaxVideo } from '@/lib/media/adapters/minimax-video-adapter';
import { generateWithSeedance } from '@/lib/media/adapters/seedance-adapter';
import { generateWithVeo } from '@/lib/media/adapters/veo-adapter';

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

  it('keeps Seedance task routing and success extraction unchanged', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'seed-task' })).mockResolvedValueOnce(
      jsonResponse({
        id: 'seed-task',
        model: 'doubao-seedance-2-0-260128',
        status: 'succeeded',
        content: { video_url: 'https://cdn.example.com/seed.mp4' },
        resolution: '720p',
        ratio: '16:9',
        duration: 5,
      }),
    );

    const promise = generateWithSeedance(
      { providerId: 'seedance', apiKey: 'seed-key' },
      { prompt: 'a paper city', aspectRatio: '16:9', resolution: '720p', duration: 5 },
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
  });

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
      { providerId: 'seedance', apiKey: 'seed-key' },
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
      { providerId: 'kling', apiKey: 'access:secret', baseUrl: 'https://kling.example' },
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
      { providerId: 'kling', apiKey: 'access:secret', baseUrl: 'https://kling.example' },
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
      { providerId: 'kling', apiKey: 'access:secret', baseUrl: 'https://kling.example' },
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
      { providerId: 'grok-video', apiKey: 'grok-key', baseUrl: 'https://grok.example/v1' },
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
      { providerId: 'grok-video', apiKey: 'grok-key', baseUrl: 'https://grok.example/v1' },
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
      { providerId: 'grok-video', apiKey: 'grok-key', baseUrl: 'https://grok.example/v1' },
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
      { providerId: 'happyhorse', apiKey: 'horse-key' },
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
      { providerId: 'happyhorse', apiKey: 'horse-key' },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'HappyHorse video generation timed out after 600s (task: horse-timeout)',
    );

    await vi.advanceTimersByTimeAsync(600_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(41);
  });

  it('returns an immediately completed Veo operation without waiting or polling', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        name: 'operations/veo-immediate',
        done: true,
        response: {
          videos: [{ bytesBase64Encoded: 'dmlkZW8=', mimeType: 'video/mp4' }],
        },
      }),
    );

    const result = await generateWithVeo(
      { providerId: 'veo', apiKey: 'veo-key', baseUrl: 'https://veo.example' },
      { prompt: 'a paper city', aspectRatio: '16:9', duration: 8 },
    );

    expect(result).toEqual({
      url: 'data:video/mp4;base64,dmlkZW8=',
      duration: 8,
      width: 1280,
      height: 720,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an immediately failed Veo operation without waiting or polling', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        name: 'operations/veo-failed',
        done: true,
        error: { code: 13, message: 'render failed', status: 'INTERNAL' },
      }),
    );

    await expect(
      generateWithVeo(
        { providerId: 'veo', apiKey: 'veo-key', baseUrl: 'https://veo.example' },
        { prompt: 'a paper city' },
      ),
    ).rejects.toThrow('Veo generation failed: 13 - render failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps Veo operation routing and polled success extraction unchanged', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ name: 'operations/veo-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          name: 'operations/veo-task',
          done: true,
          response: {
            videos: [{ bytesBase64Encoded: 'cG9sbGVk', mimeType: 'video/webm' }],
          },
        }),
      );

    const promise = generateWithVeo(
      { providerId: 'veo', apiKey: 'veo-key', baseUrl: 'https://veo.example' },
      { prompt: 'a paper city', aspectRatio: '9:16', duration: 8 },
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toEqual({
      url: 'data:video/webm;base64,cG9sbGVk',
      duration: 8,
      width: 720,
      height: 1280,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      operationName: 'operations/veo-task',
    });
  });

  it('preserves the Veo timeout message and exact poll count', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ name: 'operations/veo-timeout' }))
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ name: 'operations/veo-timeout', done: false })),
      );
    const promise = generateWithVeo(
      { providerId: 'veo', apiKey: 'veo-key', baseUrl: 'https://veo.example' },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'Veo video generation timed out after 10 minutes',
    );

    await vi.advanceTimersByTimeAsync(600_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(61);
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
      { providerId: 'minimax-video', apiKey: 'minimax-key' },
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
      { providerId: 'minimax-video', apiKey: 'minimax-key' },
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'MiniMax Video: timeout after 120 polls, last status: Processing',
    );

    await vi.advanceTimersByTimeAsync(600_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(121);
  });
});
