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
  toast: {
    loading: vi.fn(() => 'toast'),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('file-saver', () => ({ saveAs: mocks.saveAs }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
    locale: 'en-US',
  }),
}));
vi.mock('@/lib/store/stage', () => ({ useStageStore: { getState: () => mocks.state } }));
vi.mock('@/lib/classroom/stage-meta-client', () => ({ fetchStageMeta: mocks.fetchStageMeta }));
vi.mock('@/lib/export/standalone-html/build-standalone-html', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/export/standalone-html/build-standalone-html')>();
  return { ...actual, buildStandaloneHtmlExport: mocks.buildStandaloneHtmlExport };
});

import {
  classroomHasNarration,
  classroomHasPlaybackMedia,
  useExportHtml,
} from '@/lib/export/use-export-html';
import {
  STANDALONE_HTML_SIZE_WARNING_BYTES,
  StandaloneHtmlTooLargeError,
} from '@/lib/export/standalone-html/limits';
import type { Scene } from '@/lib/types/stage';

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
    format: 'html',
    blob: new Blob(['<!doctype html>'], { type: 'text/html' }),
    fileName: 'course.html',
    inlineFailures: [],
    unresolvedMedia: [],
    missingAudioCount: 0,
    byteSize: 1024,
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
        await latest!.exportStandaloneHtml({ includeNarration: false });
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
      await latest!.exportStandaloneHtml({ includeNarration: true });
    });
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(latest!.exporting).toBe(false);
  });

  it.each([true, false])('passes the narration choice (%s) to the export', async (choice) => {
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: choice });
    });
    expect(mocks.buildStandaloneHtmlExport.mock.calls[0][2]).toMatchObject({
      includeNarration: choice,
    });
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
  });

  it('warns when the file is larger than the size threshold', async () => {
    mocks.buildStandaloneHtmlExport.mockResolvedValueOnce({
      format: 'html',
      blob: new Blob(['<!doctype html>'], { type: 'text/html' }),
      fileName: 'course.html',
      inlineFailures: [],
      unresolvedMedia: [],
      missingAudioCount: 0,
      byteSize: STANDALONE_HTML_SIZE_WARNING_BYTES + 1,
    });
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: true });
    });
    expect(mocks.saveAs).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'export.htmlLarge {"size":"100"}',
      expect.objectContaining({ id: 'toast' }),
    );
  });

  it('asks for the ZIP fallback with the localized README', async () => {
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: true });
    });
    expect(mocks.buildStandaloneHtmlExport.mock.calls[0][2]).toMatchObject({
      format: 'auto',
      zipReadme: 'export.htmlZipReadme',
    });
  });

  it('saves the ZIP and explains why, and how to open it, when the classroom fell back to it', async () => {
    const zip = new Blob(['PK'], { type: 'application/zip' });
    mocks.buildStandaloneHtmlExport.mockResolvedValueOnce({
      format: 'zip',
      blob: zip,
      fileName: 'course.zip',
      inlineFailures: [],
      unresolvedMedia: [],
      missingAudioCount: 1,
      byteSize: 420 * 1024 * 1024,
      singleFileBytes: 560 * 1024 * 1024,
    });
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: true });
    });
    expect(mocks.saveAs).toHaveBeenCalledWith(zip, 'course.zip');
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    expect(mocks.toast.warning).toHaveBeenCalledTimes(1);
    expect(mocks.toast.warning).toHaveBeenCalledWith('export.htmlZipFallback {"size":"560"}', {
      id: 'toast',
      description: 'export.htmlZipFallbackDesc export.narrationMissing {"count":1}',
      duration: expect.any(Number),
    });
    expect(mocks.toast.warning.mock.calls[0][1].duration).toBeGreaterThanOrEqual(10_000);
    expect(latest!.exporting).toBe(false);
  });

  it('explains, without saving, when the file would be too large', async () => {
    mocks.buildStandaloneHtmlExport.mockRejectedValueOnce(
      new StandaloneHtmlTooLargeError(450 * 1024 * 1024),
    );
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: true });
    });
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'export.htmlTooLarge {"size":"450"}',
      expect.objectContaining({ id: 'toast' }),
    );
    expect(latest!.exporting).toBe(false);
  });

  it('explains a ZIP whose page alone would be too large', async () => {
    mocks.buildStandaloneHtmlExport.mockRejectedValueOnce(
      new StandaloneHtmlTooLargeError(420 * 1024 * 1024, 'page'),
    );
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: true });
    });
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'export.htmlPageTooLarge {"size":"420"}',
      expect.objectContaining({ id: 'toast' }),
    );
  });

  it('suggests nothing about narration for a silent export whose page is too large', async () => {
    mocks.buildStandaloneHtmlExport.mockRejectedValueOnce(
      new StandaloneHtmlTooLargeError(420 * 1024 * 1024, 'page'),
    );
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: false });
    });
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'export.htmlPageTooLargeSilent {"size":"420"}',
      expect.objectContaining({ id: 'toast' }),
    );
  });

  it('reports missing narration in its own words, not as an external asset', async () => {
    mocks.buildStandaloneHtmlExport.mockResolvedValueOnce({
      format: 'html',
      blob: new Blob(['<!doctype html>'], { type: 'text/html' }),
      fileName: 'course.html',
      inlineFailures: [],
      unresolvedMedia: [],
      missingAudioCount: 2,
      byteSize: 1024,
    });
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: true });
    });
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'export.narrationMissing {"count":2}',
      expect.objectContaining({ id: 'toast' }),
    );
  });

  it('reports bundling failures and missing narration together', async () => {
    mocks.buildStandaloneHtmlExport.mockResolvedValueOnce({
      blob: new Blob(['<!doctype html>'], { type: 'text/html' }),
      fileName: 'course.html',
      inlineFailures: ['https://x.example/a.png'],
      unresolvedMedia: [],
      missingAudioCount: 1,
      byteSize: 1024,
    });
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: true });
    });
    const message = mocks.toast.warning.mock.calls[0][0] as string;
    expect(message).toContain('export.inlinePartial {"count":1}');
    expect(message).toContain('export.narrationMissing {"count":1}');
  });

  it('only suggests exporting without narration when narration was included', async () => {
    const large = {
      blob: new Blob(['<!doctype html>'], { type: 'text/html' }),
      fileName: 'course.html',
      inlineFailures: [],
      unresolvedMedia: [],
      missingAudioCount: 0,
      byteSize: STANDALONE_HTML_SIZE_WARNING_BYTES + 1,
    };
    mocks.buildStandaloneHtmlExport.mockResolvedValueOnce(large);
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: false });
    });
    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'export.htmlLargeSilent {"size":"100"}',
      expect.objectContaining({ id: 'toast' }),
    );

    mocks.buildStandaloneHtmlExport.mockRejectedValueOnce(
      new StandaloneHtmlTooLargeError(450 * 1024 * 1024),
    );
    await act(async () => {
      await latest!.exportStandaloneHtml({ includeNarration: false });
    });
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'export.htmlTooLargeSilent {"size":"450"}',
      expect.objectContaining({ id: 'toast' }),
    );
  });
});

describe('classroomHasNarration', () => {
  const withActions = (actions: unknown[]) => [{ id: 's', actions }] as unknown as Scene[];

  it('is true when a speech has stored or legacy narration audio', () => {
    expect(classroomHasNarration(withActions([{ type: 'speech', text: 'a', audioId: 'x' }]))).toBe(
      true,
    );
    expect(
      classroomHasNarration(
        withActions([{ type: 'speech', text: 'a', audioUrl: 'https://cdn.example/a.mp3' }]),
      ),
    ).toBe(true);
  });

  it('is false for text-only speech and other actions', () => {
    expect(
      classroomHasNarration(
        withActions([
          { type: 'speech', text: 'a' },
          { type: 'spotlight', elementId: 'e' },
        ]),
      ),
    ).toBe(false);
    expect(classroomHasNarration([])).toBe(false);
  });
});

describe('classroomHasPlaybackMedia', () => {
  const slide = (elements: unknown[], actions: unknown[] = []) =>
    [{ id: 's', actions, content: { type: 'slide', canvas: { elements } } }] as unknown as Scene[];

  it('is true for narration audio or a slide video', () => {
    expect(
      classroomHasPlaybackMedia(slide([], [{ type: 'speech', text: 'a', audioId: 'x' }])),
    ).toBe(true);
    expect(classroomHasPlaybackMedia(slide([{ type: 'video', id: 'v' }]))).toBe(true);
  });

  it('is false with neither', () => {
    expect(classroomHasPlaybackMedia(slide([{ type: 'text', id: 't' }]))).toBe(false);
    expect(
      classroomHasPlaybackMedia([
        { id: 'q', actions: [], content: { type: 'quiz', questions: [] } },
      ] as unknown as Scene[]),
    ).toBe(false);
    expect(classroomHasPlaybackMedia([])).toBe(false);
  });
});
