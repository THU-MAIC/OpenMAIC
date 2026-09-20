import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildZip: vi.fn(),
  saveAs: vi.fn(),
  loading: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('@/lib/video-export-app/build-export-zip', () => ({ buildExportZip: mocks.buildZip }));
vi.mock('file-saver', () => ({ saveAs: mocks.saveAs }));
vi.mock('sonner', () => ({ toast: mocks }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));

import { useVideoRenderStore } from '@/lib/store/video-render';
import { NoScenesError } from '@/lib/video-export-app/export-options';

const t = (key: string) => key;
const start = () => useVideoRenderStore.getState().startRender(t, 'en-US');
const fetchMock = vi.fn();

describe('video render failure presentation and lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    useVideoRenderStore.getState().reset();
    mocks.loading.mockReturnValue('render-toast');
    mocks.buildZip.mockReset().mockResolvedValue({
      zipBlob: new Blob(['zip fixture']),
      stageName: 'Example',
      missingCount: 0,
      errorCount: 0,
    });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    [429, 'queue_full', 'export.videoQueueFull'],
    [429, 'per_identity_limit', 'export.videoRenderInProgress'],
    [413, undefined, 'export.videoTooLarge'],
  ])(
    'localizes rejection %i / %s without duplicating English prose',
    async (status, reason, key) => {
      fetchMock.mockResolvedValueOnce(
        Response.json(
          {
            error: 'Rejected',
            details: 'Service diagnostic',
            reason,
          },
          { status },
        ),
      );
      await start();
      expect(mocks.error).toHaveBeenCalledWith(key, { id: 'render-toast' });
      expect(useVideoRenderStore.getState()).toMatchObject({
        status: 'failed',
        error: 'Rejected: Service diagnostic',
      });
      expect(mocks.saveAs).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [429, undefined],
    [429, 'future_limit'],
    [502, undefined],
    [502, 'queue_full'],
  ])(
    'keeps unrecognized %i / %s generic without exposing upstream diagnostics',
    async (status, reason) => {
      fetchMock.mockResolvedValueOnce(
        Response.json(
          {
            error: 'Rejected',
            details:
              'Check PRODUCER_HEADLESS_SHELL_PATH: /srv/render/private.zip at https://internal.example/render',
            reason,
          },
          { status },
        ),
      );
      await start();
      expect(mocks.error).toHaveBeenCalledWith('export.videoFailed', {
        id: 'render-toast',
      });
      expect(mocks.saveAs).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('retains an HTTP diagnostic for a non-JSON error response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('gateway error', { status: 502 }));
    await start();
    expect(mocks.error).toHaveBeenCalledWith('export.videoFailed', {
      id: 'render-toast',
    });
    expect(useVideoRenderStore.getState().error).toBe('HTTP 502');
  });

  it.each(['unconfigured', 'browser-network-failure'])(
    'preserves ZIP fallback for %s',
    async (kind) => {
      if (kind === 'unconfigured')
        fetchMock.mockResolvedValueOnce(
          Response.json({ error: 'Not configured' }, { status: 501 }),
        );
      else fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await start();
      expect(mocks.saveAs).toHaveBeenCalledWith(expect.any(Blob), 'Example-video.zip');
      expect(useVideoRenderStore.getState()).toMatchObject({ status: 'idle', error: null });
      expect(mocks.info).toHaveBeenCalledWith('export.videoServiceUnavailable', {
        id: 'render-toast',
      });
      expect(mocks.error).not.toHaveBeenCalled();
    },
  );

  it('retains the compile diagnostic without exposing it in the toast', async () => {
    mocks.buildZip.mockRejectedValueOnce(new Error('Unable to read narration audio'));
    await start();
    expect(useVideoRenderStore.getState().error).toBe('Unable to read narration audio');
    expect(mocks.error).toHaveBeenCalledWith('export.videoFailed', {
      id: 'render-toast',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the existing no-scenes message', async () => {
    mocks.buildZip.mockRejectedValueOnce(new NoScenesError('No scenes to export'));
    await start();
    expect(mocks.error).toHaveBeenCalledWith('export.videoNoScenes', { id: 'render-toast' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['job-failed', 'ffmpeg failed: /srv/render/jobs/private/output.mp4'],
    ['job-cancelled', 'Producer stopped: /srv/render/jobs/private/project.zip'],
    ['poll-http-error', 'Internal gateway: https://internal.example/render'],
    ['poll-network-error', 'Failed to fetch'],
    ['download-failed', 'download HTTP 502'],
    ['timeout', 'render-video timed out after 1200 polls'],
  ])('keeps %s generic and still cancels the accepted job', async (kind, message) => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ jobId: 'job-1' }, { status: 202 });
      if (init?.method === 'DELETE') return Response.json({ cancelled: true });
      if (url.endsWith('/download')) return new Response(null, { status: 502 });
      if (kind === 'poll-network-error') throw new TypeError(message);
      if (kind === 'poll-http-error') return Response.json({ error: message }, { status: 502 });
      return Response.json(
        kind === 'job-failed'
          ? { status: 'failed', error: message }
          : kind === 'job-cancelled'
            ? { status: 'cancelled', error: message }
            : { status: kind === 'timeout' ? 'running' : 'succeeded' },
      );
    });
    const pending = start();
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(kind === 'timeout' ? 3_600_000 : 3000);
    await pending;
    expect(fetchMock).toHaveBeenCalledWith('/api/export-video/render/job-1', { method: 'DELETE' });
    expect(mocks.error).toHaveBeenCalledWith('export.videoFailed', {
      id: 'render-toast',
    });
    expect(useVideoRenderStore.getState()).toMatchObject({ status: 'failed', error: message });
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });

  it('allows a rejected submission to retry successfully without stale errors or duplicate submits', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: 'Busy', reason: 'queue_full' }, { status: 429 }),
    );
    await start();
    expect(mocks.error).toHaveBeenLastCalledWith('export.videoQueueFull', { id: 'render-toast' });

    fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ jobId: 'job-2' }, { status: 202 });
      if (url.endsWith('/download')) return new Response(new Blob(['mp4 fixture']));
      return Response.json({ status: 'succeeded', progress: 1 });
    });
    const pending = start();
    await vi.dynamicImportSettled();
    expect(useVideoRenderStore.getState().error).toBeNull();
    await start(); // Ignored while the first retry is rendering.
    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(fetchMock.mock.calls.filter((args) => args[1]?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter((args) => args[1]?.method === 'DELETE')).toHaveLength(0);
    expect(useVideoRenderStore.getState()).toMatchObject({ status: 'succeeded', error: null });
    expect(mocks.success).toHaveBeenCalledWith('export.videoMp4Success', { id: 'render-toast' });
    expect(mocks.saveAs).toHaveBeenCalledWith(expect.any(Blob), 'Example.mp4');
  });
});
