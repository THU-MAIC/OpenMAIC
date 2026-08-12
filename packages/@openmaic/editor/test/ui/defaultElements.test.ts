import { describe, expect, it } from 'vitest';
import type { SlideContent } from '@openmaic/dsl';
import { applyEditorTransaction, createEditorTransaction } from '../../src/core';
import {
  createDefaultAudioElement,
  createDefaultChartElement,
  createDefaultImageElement,
  createDefaultLatexElement,
  createDefaultLineElement,
  createDefaultTableElement,
  createDefaultTextElement,
  createDefaultVideoElement,
  fitImageSize,
} from '../../src/ui/adapters/defaultElements';

const emptyContent: SlideContent = {
  type: 'slide' as const,
  canvas: {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#111', fontName: 'Inter' },
    elements: [],
  },
};

describe('built-in editor element factories', () => {
  it('creates complete media elements with stable defaults', () => {
    expect(createDefaultVideoElement('video-1', { src: 'a.mp4', ext: 'mp4' })).toMatchObject({
      id: 'video-1',
      type: 'video',
      autoplay: false,
      src: 'a.mp4',
      ext: 'mp4',
    });
    expect(createDefaultAudioElement('audio-1', { src: 'a.mp3' })).toMatchObject({
      id: 'audio-1',
      type: 'audio',
      autoplay: false,
      loop: false,
      fixedRatio: true,
      src: 'a.mp3',
    });
  });

  it('preserves natural image ratios while fitting large sources into 600 by 400', () => {
    expect(fitImageSize(1200, 600)).toEqual({ width: 600, height: 300 });
    expect(fitImageSize(600, 1200)).toEqual({ width: 200, height: 400 });
    expect(fitImageSize(120, 80)).toEqual({ width: 120, height: 80 });
    expect(
      createDefaultImageElement('portrait', 'portrait.png', { width: 600, height: 1200 }),
    ).toMatchObject({ width: 200, height: 400 });
  });

  it('clamps table dimensions and creates stable cell ids', () => {
    const table = createDefaultTableElement('table-1', 2, 3);
    const minimum = createDefaultTableElement('minimum', 0, -1);

    expect(table.data).toHaveLength(2);
    expect(table.data[0]).toHaveLength(3);
    expect(table.data[1][2].id).toBe('table-1-cell-1-2');
    expect(minimum.data).toHaveLength(1);
    expect(minimum.data[0]).toHaveLength(1);
  });

  it.each([
    ['broken', { isBroken: true }, { broken: [0, 200] }],
    ['double broken', { isBroken2: true }, { broken2: [100, 0] }],
    ['curve', { isCurve: true }, { curve: [0, 200] }],
    [
      'cubic',
      { isCubic: true },
      {
        cubic: [
          [200, 0],
          [0, 200],
        ],
      },
    ],
  ] as const)('preserves %s preset geometry for a diagonal drag', (_label, preset, controls) => {
    const line = createDefaultLineElement(
      'line-1',
      { start: [100, 200], end: [300, 400] },
      { path: '', style: 'solid', points: ['', ''], ...preset },
    );

    expect(line).toMatchObject({ start: [0, 0], end: [200, 200], ...controls });
  });

  it('creates insertable DSL elements accepted by the transaction core', () => {
    const elements = [
      createDefaultTextElement('text-1', { left: 10, top: 20, width: 200, height: 60 }),
      createDefaultImageElement('image-1', 'image.png'),
      createDefaultChartElement('chart-1', 'bar'),
      createDefaultLatexElement('latex-1', {
        latex: 'x^2',
        html: '<span>x²</span>',
        width: 120,
        height: 60,
      }),
    ];

    let content = emptyContent;
    for (const element of elements) {
      content = applyEditorTransaction(
        content,
        createEditorTransaction({
          origin: 'toolbar',
          operations: [{ type: 'element.add', element }],
        }),
      );
    }

    expect(content.canvas.elements.map((element) => element.id)).toEqual([
      'text-1',
      'image-1',
      'chart-1',
      'latex-1',
    ]);
  });
});
