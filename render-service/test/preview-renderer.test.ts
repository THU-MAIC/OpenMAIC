import { describe, expect, it, vi } from 'vitest';
import puppeteer from 'puppeteer-core';
import type { Frame, Page } from 'puppeteer-core';
import {
  analyzeLayoutSnapshot,
  buildPreviewHtml,
  collectLayoutDiagnostics,
  minimumTextPxForPreview,
  type PreviewScene,
  waitForDocumentAssets,
  waitForInteractiveFrame,
} from '../src/preview-renderer.js';

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
  it('keeps the readable-type threshold in screen pixels when a slide scales down', () => {
    expect(minimumTextPxForPreview('slide', viewport)).toBe(16);
    expect(
      minimumTextPxForPreview('slide', { width: 390, height: 844, deviceScaleFactor: 1 }),
    ).toBe(16);
  });

  it('reports viewport, text-fit, and readable-type violations without flagging intended scroll regions', () => {
    const diagnostics = analyzeLayoutSnapshot({
      viewport: { width: 1280, height: 720 },
      document: { scrollWidth: 1400, scrollHeight: 900, clientWidth: 1280, clientHeight: 720 },
      minimumTextPx: 16,
      nodes: [
        {
          selector: '#outside',
          rect: { x: 1200, y: 40, width: 140, height: 80 },
          clientWidth: 140,
          clientHeight: 80,
          scrollWidth: 140,
          scrollHeight: 80,
          fontSize: 18,
          containsText: true,
          hasDirectText: true,
          isIntentionalScroller: false,
          insideIntentionalScroller: false,
        },
        {
          selector: '#clipped-copy',
          rect: { x: 40, y: 40, width: 200, height: 48 },
          clientWidth: 200,
          clientHeight: 48,
          scrollWidth: 260,
          scrollHeight: 64,
          fontSize: 12,
          containsText: true,
          hasDirectText: true,
          isIntentionalScroller: false,
          insideIntentionalScroller: false,
        },
        {
          selector: '#intentional-scroller',
          rect: { x: 1200, y: 300, width: 200, height: 120 },
          clientWidth: 200,
          clientHeight: 120,
          scrollWidth: 420,
          scrollHeight: 240,
          fontSize: 16,
          containsText: true,
          hasDirectText: false,
          isIntentionalScroller: true,
          insideIntentionalScroller: false,
        },
        {
          selector: '#intentional-scroll-item',
          rect: { x: 40, y: 760, width: 200, height: 48 },
          clientWidth: 200,
          clientHeight: 48,
          scrollWidth: 260,
          scrollHeight: 64,
          fontSize: 12,
          containsText: true,
          hasDirectText: true,
          isIntentionalScroller: false,
          insideIntentionalScroller: true,
        },
      ],
    });

    expect(diagnostics.pass).toBe(false);
    expect(diagnostics.issues.map((issue) => issue.code)).toEqual([
      'document-overflow',
      'element-outside-viewport',
      'text-overflow',
      'small-text',
      'element-outside-viewport',
      'small-text',
    ]);
    expect(diagnostics.issues).not.toContainEqual(
      expect.objectContaining({ code: 'text-overflow', selector: '#intentional-scroller' }),
    );
    expect(diagnostics.issues).not.toContainEqual(
      expect.objectContaining({
        code: 'element-outside-viewport',
        selector: '#intentional-scroll-item',
      }),
    );
  });

  it('reports overflow owned by a constrained ancestor around nested text', () => {
    const diagnostics = analyzeLayoutSnapshot({
      viewport: { width: 390, height: 844 },
      document: { scrollWidth: 390, scrollHeight: 844, clientWidth: 390, clientHeight: 844 },
      minimumTextPx: 16,
      nodes: [
        {
          selector: '#nested-constraint',
          rect: { x: 20, y: 20, width: 120, height: 28 },
          clientWidth: 120,
          clientHeight: 28,
          scrollWidth: 280,
          scrollHeight: 28,
          fontSize: 18,
          containsText: true,
          hasDirectText: false,
          isIntentionalScroller: false,
          insideIntentionalScroller: false,
        },
      ],
    });

    expect(diagnostics.issues).toContainEqual(
      expect.objectContaining({ code: 'text-overflow', selector: '#nested-constraint' }),
    );
  });

  it('judges slide type after ancestor canvas scaling, not from authored CSS pixels', () => {
    const diagnostics = analyzeLayoutSnapshot({
      viewport: { width: 390, height: 844 },
      document: { scrollWidth: 390, scrollHeight: 844, clientWidth: 390, clientHeight: 844 },
      minimumTextPx: 16,
      nodes: [
        {
          selector: '#scaled-label',
          rect: { x: 20, y: 20, width: 120, height: 24 },
          clientWidth: 120,
          clientHeight: 24,
          scrollWidth: 120,
          scrollHeight: 24,
          fontSize: 41,
          renderScale: 0.39,
          containsText: true,
          hasDirectText: true,
          isIntentionalScroller: false,
          insideIntentionalScroller: false,
        },
      ],
    });

    expect(diagnostics.issues).toContainEqual(
      expect.objectContaining({ code: 'small-text', selector: '#scaled-label' }),
    );
  });

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
    expect(evaluate.mock.calls[0]?.[0].toString()).not.toContain('__name');
  });

  it.runIf(Boolean(process.env.PUPPETEER_EXECUTABLE_PATH))(
    'collects nested clipping while preserving intentional scroll overflow in Chrome',
    async () => {
      const browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
        await page.setContent(`<!doctype html><html><body>
          <div id="clip" style="width:120px;height:28px;overflow:hidden">
            <p style="width:280px;margin:0;font-size:18px;white-space:nowrap">Nested text exceeds its owner</p>
          </div>
          <div id="scroll" style="width:200px;height:80px;overflow:auto">
            <p id="tiny" style="width:400px;margin:0;font-size:12px">Tiny text in intended scroll content</p>
          </div>
        </body></html>`);

        const diagnostics = await collectLayoutDiagnostics(
          page,
          { width: 390, height: 844, deviceScaleFactor: 1 },
          16,
        );

        expect(diagnostics.issues).toContainEqual(
          expect.objectContaining({ code: 'text-overflow', selector: '#clip' }),
        );
        expect(diagnostics.issues).toContainEqual(
          expect.objectContaining({ code: 'small-text', selector: '#tiny' }),
        );
        expect(diagnostics.issues).not.toContainEqual(
          expect.objectContaining({ code: 'text-overflow', selector: '#scroll' }),
        );
      } finally {
        await browser.close();
      }
    },
  );

  it.runIf(Boolean(process.env.PUPPETEER_EXECUTABLE_PATH))(
    'executes the asset-settling callback in the real browser realm',
    async () => {
      const browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      try {
        const page = await browser.newPage();
        await page.setContent('<!doctype html><html><body><p>Ready</p></body></html>');
        await expect(waitForDocumentAssets(page)).resolves.toBeUndefined();
      } finally {
        await browser.close();
      }
    },
  );
});
