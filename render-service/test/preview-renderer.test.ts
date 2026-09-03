import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Frame, Page } from 'puppeteer-core';
import {
  ChromiumPreviewRenderer,
  PreviewTimeoutError,
  buildSlideClientBundle,
  buildPreviewHtml,
  closeBrowserBounded,
  injectInteractiveStorageShim,
  mountSlideClient,
  type PreviewScene,
  waitForInteractiveFrame,
} from '../src/preview-renderer.js';

const originalExecutable = process.env.PRODUCER_HEADLESS_SHELL_PATH;

afterEach(() => {
  vi.useRealTimers();
  if (originalExecutable === undefined) delete process.env.PRODUCER_HEADLESS_SHELL_PATH;
  else process.env.PRODUCER_HEADLESS_SHELL_PATH = originalExecutable;
});

const viewport = { width: 1280, height: 720, deviceScaleFactor: 1 };

function chartScene(): PreviewScene {
  return {
    id: 'chart-scene',
    stageId: 'stage-1',
    order: 1,
    title: 'Chart preview',
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#2563eb'],
          fontColor: '#111',
          fontName: 'Inter',
        },
        elements: [
          {
            id: 'chart-1',
            type: 'chart',
            left: 100,
            top: 100,
            width: 500,
            height: 300,
            rotate: 0,
            chartType: 'bar',
            data: { labels: ['A'], legends: ['Series'], series: [[1]] },
          },
        ],
      },
    },
    actions: [],
  } as unknown as PreviewScene;
}

describe('preview renderer browser readiness', () => {
  it('uses an empty browser mount root instead of server-rendering SlideCanvas', () => {
    const html = buildPreviewHtml(chartScene(), { id: 'stage-1', name: 'Charts' }, viewport);

    expect(html).toContain('id="preview-slide-root"');
    expect(html).not.toContain('class="chart"');
    expect(html).not.toContain('slide-element-chart-1');
  });

  it('waits for the interactive frame to complete and settles its nested assets', async () => {
    const evaluate = vi.fn(async () => undefined);
    const waitForFunction = vi.fn(async () => undefined);
    const frame = { evaluate, waitForFunction } as unknown as Frame;
    const contentFrame = vi.fn(async () => frame);
    const waitForSelector = vi.fn(async () => ({ contentFrame }));
    const page = { waitForSelector } as unknown as Page;

    await waitForInteractiveFrame(page);

    expect(waitForSelector).toHaveBeenCalledWith('iframe');
    expect(contentFrame).toHaveBeenCalledOnce();
    expect(waitForFunction).toHaveBeenCalledOnce();
    expect(waitForFunction.mock.calls[0]?.[0].toString()).toContain('about:srcdoc');
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0]?.[0].toString()).toContain('document.images');
    expect(evaluate.mock.calls[0]?.[0].toString()).toContain('document.fonts');
  });

  it('retries the slide-client build after a rejected memoized promise', async () => {
    const failedBuild = vi.fn(async () => {
      throw new Error('transient esbuild failure');
    });
    await expect(buildSlideClientBundle(failedBuild as never)).rejects.toThrow(
      'transient esbuild failure',
    );

    const successfulBuild = vi.fn(async () => ({ outputFiles: [{ text: 'ready bundle' }] }));
    await expect(buildSlideClientBundle(successfulBuild as never)).resolves.toBe('ready bundle');
    expect(failedBuild).toHaveBeenCalledOnce();
    expect(successfulBuild).toHaveBeenCalledOnce();
  });

  it('fails a slide mount immediately when the page reports an in-page crash', async () => {
    let pageErrorHandler: ((error: Error) => void) | undefined;
    const page = {
      on: vi.fn((_event: string, handler: (error: Error) => void) => {
        pageErrorHandler = handler;
      }),
      off: vi.fn(() => {
        pageErrorHandler = undefined;
      }),
      addScriptTag: vi.fn(async () => {
        pageErrorHandler?.(new Error('SlideCanvas mount crashed'));
      }),
      waitForFunction: vi.fn(() => new Promise<void>(() => {})),
    } as unknown as Page;

    await expect(mountSlideClient(page, 'broken bundle')).rejects.toThrow(
      'SlideCanvas mount crashed',
    );
    expect(page.on).toHaveBeenCalledWith('pageerror', expect.any(Function));
    expect(page.off).toHaveBeenCalledWith('pageerror', expect.any(Function));
  });

  it('installs usable in-memory storage before authored interactive scripts', () => {
    const patched = injectInteractiveStorageShim(
      '<!doctype html><html><head><script>localStorage.setItem("answer", 42); window.result = localStorage.getItem("answer");</script></head></html>',
    );
    const scripts = [...patched.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(
      (match) => match[1],
    );
    expect(patched.indexOf('data-preview-storage-shim')).toBeLessThan(
      patched.indexOf('localStorage.setItem'),
    );

    const context: Record<string, unknown> = {};
    context.window = context;
    Object.defineProperty(context, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    Object.defineProperty(context, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    for (const script of scripts) runInNewContext(script, context);

    expect(context.result).toBe('42');
  });

  it('bounds protocol calls and force-kills Chromium when the preview aborts', async () => {
    process.env.PRODUCER_HEADLESS_SHELL_PATH = '/test/chromium-headless-shell';
    const kill = vi.fn();
    const close = vi.fn(() => new Promise<void>(() => {}));
    const newPage = vi.fn(() => new Promise<Page>(() => {}));
    const browser = {
      newPage,
      close,
      process: () => ({ kill }),
    } as unknown as Browser;
    const launch = vi.fn(async () => browser);
    const renderer = new ChromiumPreviewRenderer({
      browserLauncher: { launch } as never,
    });
    const abort = new AbortController();
    const rendered = renderer.render({
      scene: {
        id: 'interactive-1',
        stageId: 'stage-1',
        order: 1,
        title: 'Widget',
        type: 'interactive',
        content: { type: 'interactive', html: '<!doctype html><p>Ready</p>' },
        actions: [],
      },
      stage: { id: 'stage-1', name: 'Course' },
      viewport,
      signal: abort.signal,
      deadlineMs: 40,
    });
    await vi.waitFor(() => expect(newPage).toHaveBeenCalledOnce());

    const started = Date.now();
    abort.abort(new PreviewTimeoutError('Preview exceeded the deadline'));
    await expect(rendered).rejects.toThrow(PreviewTimeoutError);

    expect(Date.now() - started).toBeLessThan(800);
    expect(launch.mock.calls[0]?.[0]).toMatchObject({ protocolTimeout: 1_040 });
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(close).toHaveBeenCalledOnce();
  });

  it('force-kills Chromium when the bounded browser close times out', async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const close = vi.fn(() => new Promise<void>(() => {}));
    const browser = { close, process: () => ({ kill }) } as unknown as Browser;

    const closing = closeBrowserBounded(browser);
    expect(close).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    await closing;

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });
});
