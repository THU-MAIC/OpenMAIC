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
  vi.clearAllMocks();
  mocks.state = {
    stage: standaloneFixtureStage('stage-hook'),
    scenes: standaloneFixtureScenes('stage-hook'),
  };
  // Would stall forever if the export ever asked for stage metadata.
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
});

describe('useExportHtml', () => {
  it('links PBL scenes to the classroom without any stage-meta request, then clears the busy state', async () => {
    const fetchSpy = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await act(async () => {
        await latest!.exportStandaloneHtml();
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(mocks.fetchStageMeta).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.buildStandaloneHtmlExport).toHaveBeenCalledTimes(1);
    expect(mocks.buildStandaloneHtmlExport.mock.calls[0][2]).toMatchObject({
      classroomUrl: `${window.location.origin}/classroom/stage-hook`,
    });
    expect(mocks.saveAs).toHaveBeenCalledTimes(1);
    expect(latest!.exporting).toBe(false);
  });

  it('clears the busy state when the export fails', async () => {
    mocks.buildStandaloneHtmlExport.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await latest!.exportStandaloneHtml();
    });
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(latest!.exporting).toBe(false);
  });
});
