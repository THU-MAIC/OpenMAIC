import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { EventEmitter } from 'node:events';

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  accessDocument: vi.fn(),
  fetch: vi.fn(),
  saveAs: vi.fn(),
  toast: { loading: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/video-export-app/build-export-zip', () => ({ buildExportZip: mocks.build }));
vi.mock('@/lib/document-store', () => ({ accessDocument: mocks.accessDocument }));
vi.mock('file-saver', () => ({ saveAs: mocks.saveAs }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/lib/store/stage', async () => {
  const { createStore } = await import('zustand/vanilla');
  return { useStageStore: createStore(() => ({ stage: null, scenes: [] })) };
});
vi.mock('@/lib/store/media-generation', async () => {
  const { createStore } = await import('zustand/vanilla');
  return { useMediaGenerationStore: createStore(() => ({ tasks: {} })) };
});
vi.mock('@/lib/utils/database', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('video-render-cache-test');
  db.version(1).stores({ audioFiles: 'id', mediaFiles: 'id', unrelated: 'id' });
  return { db };
});
vi.mock('@/lib/i18n/config', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});
// Exercise the real submit/poll/download loop without its three-second sleeps.
vi.mock('@/lib/media/polled-task', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/polled-task')>();
  return {
    ...actual,
    runPolledTask: (options: Parameters<typeof actual.runPolledTask>[0]) =>
      actual.runPolledTask({ ...options, intervalMs: 0 }),
  };
});

import { useVideoRenderStore } from '@/lib/store/video-render';
import { useStageStore } from '@/lib/store/stage';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { db } from '@/lib/utils/database';
import i18n from '@/lib/i18n/config';
import { notifyAssetReplaced } from '@/lib/media/asset-replacement-events';
import type { Locale } from '@/lib/i18n';

const t = vi.fn((key: string, _options?: Record<string, unknown>) => key);
const start = (locale: Locale = 'en-US') => useVideoRenderStore.getState().startRender(t, locale);
const options = () => useVideoRenderStore.getState();
const makeZip = () => ({
  zipBlob: new Blob(['archive']),
  stageName: 'Course',
  missingCount: 2,
  errorCount: 1,
});
const stage = (id: string) =>
  ({ id, name: 'Course' }) as NonNullable<ReturnType<typeof useStageStore.getState>['stage']>;
function rejectSubmit(status = 429) {
  mocks.fetch.mockResolvedValue(Response.json({ error: 'rejected' }, { status }));
}
function acceptAndFinish(status: 'succeeded' | 'failed' = 'succeeded') {
  mocks.fetch
    .mockReset()
    .mockResolvedValueOnce(Response.json({ jobId: 'job-1' }))
    .mockResolvedValueOnce(Response.json({ jobId: 'job-1', status, progress: 1 }))
    .mockResolvedValue(new Response(new Blob(['mp4'])));
}
function uploadedForm(index: number): FormData {
  return mocks.fetch.mock.calls[index][1].body;
}

beforeEach(async () => {
  options().reset();
  options().setOptions({
    resolution: '1080p',
    fps: 30,
    quality: 'standard',
    burnInSubtitles: false,
  });
  useStageStore.setState({ stage: stage('stage-a'), scenes: [] });
  useMediaGenerationStore.setState({ tasks: {} });
  await Promise.all(
    ['audioFiles', 'mediaFiles', 'unrelated'].map((name) => db.table(name).clear()),
  );
  vi.clearAllMocks();
  mocks.fetch.mockReset();
  mocks.accessDocument.mockReset().mockResolvedValue(undefined);
  mocks.build.mockReset().mockImplementation(async () => makeZip());
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => {
  options().reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await db.delete();
});

describe('video render ZIP retry cache', () => {
  it('reuses the archive after 429, submits changed fps/quality, and preserves warnings', async () => {
    const append = vi.spyOn(FormData.prototype, 'append');
    rejectSubmit();
    await start();
    expect(mocks.saveAs).not.toHaveBeenCalled();
    options().setOptions({ fps: 60, quality: 'high' });
    acceptAndFinish();
    mocks.toast.loading.mockClear();
    await start();
    expect(mocks.build).toHaveBeenCalledOnce();
    const projects = append.mock.calls.filter(([key]) => key === 'project');
    expect(projects).toHaveLength(2);
    expect(projects[1][1]).toBe(projects[0][1]);
    expect(uploadedForm(0).get('fps')).toBe('60');
    expect(uploadedForm(0).get('quality')).toBe('high');
    expect(mocks.toast.loading.mock.calls.some(([key]) => key === 'export.videoCompiling')).toBe(
      false,
    );
    expect(mocks.toast.warning).toHaveBeenCalledWith('export.videoWarnings');
    expect(t).toHaveBeenCalledWith('export.videoWarnings', { assets: 2, diagnostics: 1 });
    expect(mocks.saveAs).toHaveBeenCalledOnce();
    expect(options().status).toBe('succeeded');
    rejectSubmit();
    await start();
    expect(mocks.build).toHaveBeenCalledTimes(2); // success released the slot
  });

  it.each([
    ['scene edit', () => useStageStore.setState({ scenes: [] })],
    ['stage edit', () => useStageStore.setState({ stage: stage('stage-a') })],
    ['stage switch', () => useStageStore.setState({ stage: stage('stage-b') })],
    ['media task change', () => useMediaGenerationStore.setState({ tasks: {} })],
    ['resolution', () => options().setOptions({ resolution: '720p' })],
    ['subtitles', () => options().setOptions({ burnInSubtitles: true })],
    ['language event', () => (i18n as unknown as EventEmitter).emit('languageChanged', 'fr-FR')],
    ['reset', () => options().reset()],
  ])('recompiles after %s', async (_name, change) => {
    rejectSubmit();
    await start();
    change();
    await start();
    expect(mocks.build).toHaveBeenCalledTimes(2);
  });

  it.each(['resolution', 'burnInSubtitles'] as const)(
    'releases the ZIP when %s changes and changes back before retry',
    async (key) => {
      const unsubscribe = vi.spyOn(Dexie.on('storagemutated'), 'unsubscribe');
      rejectSubmit();
      await start();
      const previous = options().options;
      options().setOptions(
        key === 'resolution' ? { resolution: '720p' } : { burnInSubtitles: true },
      );
      expect(unsubscribe).toHaveBeenCalledOnce();
      options().setOptions(previous);
      await start();
      expect(mocks.build).toHaveBeenCalledTimes(2);
    },
  );

  it('recompiles a document-only rename and downloads with the new name', async () => {
    const originalStage = useStageStore.getState().stage;
    rejectSubmit();
    await start();
    mocks.accessDocument.mockResolvedValue({ document: { stage: { name: 'Renamed course' } } });
    mocks.build.mockResolvedValueOnce({ ...makeZip(), stageName: 'Renamed course' });
    await start(); // Another 429 retains the freshly renamed ZIP.
    expect(mocks.build).toHaveBeenCalledTimes(2);
    expect(useStageStore.getState().stage).toBe(originalStage);
    acceptAndFinish();
    await start();
    expect(mocks.build).toHaveBeenCalledTimes(2);
    expect(mocks.accessDocument).toHaveBeenCalledWith('stage-a');
    expect(mocks.saveAs).toHaveBeenCalledWith(expect.any(Blob), 'Renamed course.mp4');
  });

  it('rechecks a document rename that happened during the preceding compilation', async () => {
    let finish!: (result: ReturnType<typeof makeZip>) => void;
    mocks.build.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    rejectSubmit();
    const pending = start();
    await vi.waitFor(() => expect(mocks.build).toHaveBeenCalledOnce());
    await start();
    expect(mocks.build).toHaveBeenCalledOnce();
    mocks.accessDocument.mockResolvedValue({ document: { stage: { name: 'Renamed course' } } });
    finish(makeZip());
    await pending;
    mocks.build.mockResolvedValueOnce({ ...makeZip(), stageName: 'Renamed course' });
    await start();
    expect(mocks.build).toHaveBeenCalledTimes(2);
  });

  it('ignores duplicate starts while a cached name check is pending, and rejects an invalidated slot', async () => {
    rejectSubmit();
    await start();
    let finish!: (value: undefined) => void;
    mocks.accessDocument.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = start();
    await start();
    expect(mocks.accessDocument).toHaveBeenCalledOnce();
    expect(mocks.build).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    useStageStore.setState({ scenes: [] });
    finish(undefined);
    await pending;
    expect(mocks.build).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('also compares the passed export locale, and keeps identical options reusable', async () => {
    rejectSubmit();
    await start();
    options().setOptions({ resolution: '1080p', burnInSubtitles: false });
    await start();
    expect(mocks.build).toHaveBeenCalledOnce();
    await start('fr-FR');
    expect(mocks.build).toHaveBeenCalledTimes(2);
  });

  it.each(['audioFiles', 'mediaFiles'])(
    'invalidates on committed same-id %s writes',
    async (table) => {
      await db.table(table).put({ id: 'same-id', blob: new Blob(['before']) });
      rejectSubmit();
      await start();
      await db.table(table).put({ id: 'same-id', blob: new Blob(['after']) });
      await start();
      expect(mocks.build).toHaveBeenCalledTimes(2);
    },
  );

  it('ignores unrelated database writes and current-scene selection', async () => {
    rejectSubmit();
    await start();
    await db.table('unrelated').put({ id: 'other' });
    useStageStore.setState({ currentSceneId: 'different-slide' });
    await start();
    expect(mocks.build).toHaveBeenCalledOnce();
  });

  it('invalidates when the asset pool reports a same-id replacement', async () => {
    rejectSubmit();
    await start();
    await notifyAssetReplaced('audio-id', {
      invalidate: vi.fn(),
      resolve: vi.fn(),
      release: vi.fn(),
    });
    await start();
    expect(mocks.build).toHaveBeenCalledTimes(2);
  });

  it.each([400, 413, 501])('drops the archive after submit HTTP %s', async (status) => {
    rejectSubmit(status);
    await start();
    rejectSubmit();
    await start();
    expect(mocks.build).toHaveBeenCalledTimes(2);
    expect(mocks.saveAs).toHaveBeenCalledTimes(status === 501 ? 1 : 0);
  });

  it('preserves network-error ZIP fallback, then recompiles rather than retaining it', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('offline'));
    await start();
    expect(mocks.saveAs).toHaveBeenCalledOnce();
    expect(mocks.saveAs.mock.calls[0][1]).toBe('Course-video.zip');
    rejectSubmit();
    await start();
    expect(mocks.build).toHaveBeenCalledTimes(2);
  });

  it('retains the ZIP for a retryable 503', async () => {
    rejectSubmit(503);
    await start();
    await start();
    expect(mocks.build).toHaveBeenCalledOnce();
    expect(mocks.saveAs).not.toHaveBeenCalled();
  });

  it('retains the ZIP after a started job fails and still cancels that job', async () => {
    acceptAndFinish('failed');
    await start();
    expect(mocks.fetch).toHaveBeenCalledWith('/api/export-video/render/job-1', {
      method: 'DELETE',
    });
    rejectSubmit();
    await start();
    expect(mocks.build).toHaveBeenCalledOnce();
  });

  it.each(['edit', 'switch-back', 'reset', 'options'])(
    'does not repopulate a cache invalidated during compilation: %s',
    async (change) => {
      const unsubscribe = vi.spyOn(Dexie.on('storagemutated'), 'unsubscribe');
      let finish!: (result: ReturnType<typeof makeZip>) => void;
      mocks.build.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      rejectSubmit();
      const pending = start();
      await vi.waitFor(() => expect(mocks.build).toHaveBeenCalledOnce());
      if (change === 'edit') useStageStore.setState({ scenes: [] });
      if (change === 'switch-back') {
        useStageStore.setState({ stage: stage('stage-b') });
        useStageStore.setState({ stage: stage('stage-a') });
      }
      if (change === 'reset') options().reset();
      if (change === 'options') {
        options().setOptions({ resolution: '720p' });
        options().setOptions({ resolution: '1080p' });
      }
      finish(makeZip());
      await pending;
      // A stale compile must not retain a ZIP or its listeners at all.
      expect(unsubscribe).toHaveBeenCalledOnce();
      await start();
      expect(mocks.build).toHaveBeenCalledTimes(2);
    },
  );

  it('drops a cached archive when content changes while submission is pending', async () => {
    let finish!: (response: Response) => void;
    mocks.fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = start();
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    useStageStore.setState({ scenes: [] });
    finish(Response.json({ error: 'busy' }, { status: 429 }));
    await pending;
    rejectSubmit();
    await start();
    expect(mocks.build).toHaveBeenCalledTimes(2);
  });

  it('does not keep listeners after compilation fails', async () => {
    const unsubscribe = vi.spyOn(Dexie.on('storagemutated'), 'unsubscribe');
    mocks.build.mockRejectedValueOnce(new Error('compile failed'));
    await start();
    expect(options().error).toBe('compile');
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    rejectSubmit();
    await start();
    expect(mocks.build).toHaveBeenCalledTimes(2);
  });

  it('releases change listeners when idle, but keeps them across retries', async () => {
    const subscribe = vi.spyOn(useStageStore, 'subscribe');
    const unsubscribe = vi.fn();
    subscribe.mockReturnValue(unsubscribe);
    const storageUnsubscribe = vi.spyOn(Dexie.on('storagemutated'), 'unsubscribe');
    rejectSubmit();
    await start();
    await start();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();
    options().reset();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(storageUnsubscribe).toHaveBeenCalledOnce();
    await start();
    expect(subscribe).toHaveBeenCalledTimes(2);
    options().reset();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
