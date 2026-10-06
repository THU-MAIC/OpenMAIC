// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  standaloneFixtureScenes,
  standaloneFixtureStage,
} from '../fixtures/standalone-html-classroom';

const mocks = vi.hoisted(() => ({
  saveAs: vi.fn(),
  fetchStageMeta: vi.fn(),
  buildStandaloneHtmlExport: vi.fn(),
  state: { stage: undefined as unknown, scenes: [] as unknown[] },
}));

vi.mock('file-saver', () => ({ saveAs: mocks.saveAs }));
vi.mock('sonner', () => ({
  toast: { loading: vi.fn(() => 'toast'), success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('@/lib/store/stage', () => ({ useStageStore: { getState: () => mocks.state } }));
vi.mock('@/lib/classroom/stage-meta-client', () => ({ fetchStageMeta: mocks.fetchStageMeta }));
vi.mock('@/lib/export/standalone-html/build-standalone-html', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/export/standalone-html/build-standalone-html')>();
  return { ...actual, buildStandaloneHtmlExport: mocks.buildStandaloneHtmlExport };
});

import { useExportHtml } from '@/lib/export/use-export-html';
import { STAGE_META_TIMEOUT_MS } from '@/lib/export/standalone-html/build-standalone-html';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ReturnType<typeof useExportHtml> | undefined;
const capture = (value: ReturnType<typeof useExportHtml>) => {
  latest = value;
};
function Probe({ onValue }: { onValue: typeof capture }) {
  onValue(useExportHtml());
  return null;
}

let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.state = {
    stage: standaloneFixtureStage('stage-hook'),
    scenes: standaloneFixtureScenes('stage-hook'),
  };
  // A stage-meta request that never settles.
  mocks.fetchStageMeta.mockImplementation(() => new Promise(() => {}));
  mocks.buildStandaloneHtmlExport.mockResolvedValue({
    html: '<!doctype html>',
    fileName: 'course.html',
    inlineFailures: [],
    unresolvedMedia: [],
  });
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(Probe, { onValue: capture })));
});

afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
});

describe('useExportHtml', () => {
  it('finishes the export and clears the busy state when the stage-meta lookup stalls', async () => {
    let done: Promise<void> | undefined;
    await act(async () => {
      done = latest!.exportStandaloneHtml();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest!.exporting).toBe(true);
    expect(mocks.saveAs).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STAGE_META_TIMEOUT_MS);
      await done;
    });

    expect(mocks.fetchStageMeta).toHaveBeenCalledTimes(1);
    expect(mocks.buildStandaloneHtmlExport).toHaveBeenCalledTimes(1);
    expect(mocks.buildStandaloneHtmlExport.mock.calls[0][2]).toMatchObject({
      classroomUrl: undefined,
    });
    expect(mocks.saveAs).toHaveBeenCalledTimes(1);
    expect(latest!.exporting).toBe(false);
  });

  it('does not look up stage metadata for a course without PBL', async () => {
    mocks.state = {
      ...mocks.state,
      scenes: standaloneFixtureScenes('stage-hook').filter((scene) => scene.type !== 'pbl'),
    };
    await act(async () => {
      await latest!.exportStandaloneHtml();
    });
    expect(mocks.fetchStageMeta).not.toHaveBeenCalled();
    expect(mocks.saveAs).toHaveBeenCalledTimes(1);
    expect(latest!.exporting).toBe(false);
  });
});
