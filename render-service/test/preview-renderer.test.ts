import { describe, expect, it, vi } from 'vitest';
import type { Frame, Page } from 'puppeteer-core';
import {
  buildPreviewHtml,
  type PreviewScene,
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
});
