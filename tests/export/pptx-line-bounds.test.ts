import JSZip from 'jszip';
import { DOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import type { PPTLineElement, Slide } from '@openmaic/dsl';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';

describe('PPTX line geometry', () => {
  it.each<{
    name: string;
    line: Partial<PPTLineElement>;
    origin: number[];
    size: number[];
    points: number[][];
  }>([
    {
      name: 'quadratic curve with a nonzero height',
      line: { curve: [20, 60] },
      origin: [952500, 952500],
      size: [381000, 571500],
      points: [
        [0, 0],
        [190500, 571500],
        [381000, 0],
      ],
    },
    {
      name: 'cubic curve with negative control points',
      line: {
        cubic: [
          [-10, 20],
          [50, -30],
        ],
      },
      origin: [857250, 666750],
      size: [571500, 476250],
      points: [
        [95250, 285750],
        [0, 476250],
        [571500, 0],
        [476250, 285750],
      ],
    },
    {
      name: 'horizontal double elbow without its unused control coordinate',
      line: { end: [100, 20], broken2: [-50, 500] },
      origin: [476250, 952500],
      size: [1428750, 190500],
      points: [
        [476250, 0],
        [0, 0],
        [0, 190500],
        [1428750, 190500],
      ],
    },
    {
      name: 'straight line with nonzero endpoint offsets',
      line: { start: [10, 5], end: [40, 25] },
      origin: [1047750, 1000125],
      size: [285750, 190500],
      points: [
        [0, 0],
        [285750, 190500],
      ],
    },
  ])('exports $name in the shape coordinate system', async ({ line, origin, size, points }) => {
    const element: PPTLineElement = {
      id: 'line',
      type: 'line',
      left: 100,
      top: 100,
      width: 2,
      start: [0, 0],
      end: [40, 0],
      style: 'solid',
      color: '#000000',
      points: ['', ''],
      ...line,
    };
    const slide: Slide = {
      id: 'slide',
      viewportSize: 960,
      viewportRatio: 0.5625,
      theme: {
        fontName: 'Arial',
        fontColor: '#000000',
        backgroundColor: '#ffffff',
        themeColors: ['#000000'],
      },
      elements: [element],
      background: { type: 'solid', color: '#ffffff' },
    };
    const blob = await buildPptxBlob([slide], [], 0.5625, 960, 96, 96 / 72);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
    const shape = doc.getElementsByTagName('p:spPr')[0];
    const coordinates = (tag: string, x: string, y: string) =>
      Array.from(shape.getElementsByTagName(tag), (node) => [
        Number(node.getAttribute(x)),
        Number(node.getAttribute(y)),
      ]);

    // 1 source pixel = 9525 EMU. Assert the emitted file, including translated
    // control points, so expanding the bounds cannot clip or move the line.
    expect(coordinates('a:off', 'x', 'y')).toEqual([origin]);
    expect(coordinates('a:ext', 'cx', 'cy')).toEqual([size]);
    expect(coordinates('a:path', 'w', 'h')).toEqual([size]);
    expect(coordinates('a:pt', 'x', 'y')).toEqual(points);
  });
});
