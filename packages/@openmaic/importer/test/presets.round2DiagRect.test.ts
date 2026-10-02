import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getPresetShapePath } from '../src/shapes/presets';
import { parseXml } from '../src/parser/XmlParser';
import { parseShapeNode } from '../src/model/nodes/ShapeNode';
import { renderShape } from '../src/serializer/shapeSerializer';
import { transformParsedToSlides } from '../src/import-pipeline/transformParsedToSlides';
import { createMockImportContext } from '../src/import-pipeline/mockContext';
import { minimalCtx } from './helpers';

// Clockwise from the top edge: top-right, bottom-right, bottom-left, top-left.
function arcs(path: string) {
  return [...path.matchAll(/A([\d.]+),([\d.]+) 0 0,1 ([\d.]+),([\d.]+)/g)].map((match) =>
    match.slice(1).map(Number),
  );
}

describe('round2DiagRect diagonal corner pairs', () => {
  it.each([
    [300, 100, 42648, 0, 42.648, 0],
    [100, 300, 25000, 10000, 25, 10],
    [300, 100, 0, 25000, 0, 25],
    [300, 100, 100000, -10000, 50, 0],
  ])('preserves both corner pairs at %s × %s with adjustments %s / %s', (w, h, a1, a2, r1, r2) => {
    const path = getPresetShapePath(
      'round2DiagRect',
      w,
      h,
      new Map([
        ['adj1', a1],
        ['adj2', a2],
      ]),
    )!;
    const actual = arcs(path);
    const expected = [
      [r2, r2, w, r2],
      [r1, r1, w - r1, h],
      [r2, r2, 0, h - r2],
      [r1, r1, r1, 0],
    ];
    expect(actual).toHaveLength(4);
    actual.forEach((arc, i) =>
      arc.forEach((value, j) => expect(value).toBeCloseTo(expected[i][j])),
    );
  });

  it('rounds top-left and bottom-right by default', () => {
    expect(arcs(getPresetShapePath('round2DiagRect', 300, 100)!)).toEqual([
      [0, 0, 300, 0],
      [16.667, 16.667, expect.closeTo(283.333), 100],
      [0, 0, 0, 100],
      [16.667, 16.667, 16.667, 0],
    ]);
  });

  it('retains the slide 8 heading corners through XML parsing and slide conversion', async () => {
    const xml = readFileSync(
      new URL('./fixtures/slide8-diagonal-rounded-heading.xml', import.meta.url),
      'utf8',
    );
    const parsed = await renderShape(parseShapeNode(parseXml(xml)), minimalCtx(), 0);
    if (parsed.type !== 'shape') throw new Error('Expected heading shape');
    const width = parsed.width;
    const height = parsed.height;
    const radius = Math.min(width, height) * 0.42648;
    const { slides } = await transformParsedToSlides(
      {
        size: { width: 960, height: 540 },
        themeColors: [],
        slides: [
          {
            elements: [parsed],
            layoutElements: [],
            note: '',
            fill: { type: 'color', value: '#fff' },
          },
        ],
      } as Parameters<typeof transformParsedToSlides>[0],
      createMockImportContext({ viewportWidth: 1280 }),
    );
    const element = slides[0].elements[0];
    if (element.type !== 'shape') throw new Error('Expected heading shape');
    expect(element.text?.content).toContain('为什么');
    expect(element.viewBox).toEqual([width, height]);
    const rounded = arcs(element.path).filter(([rx]) => rx > 0);
    expect(rounded).toHaveLength(2);
    expect(rounded[0][0]).toBeCloseTo(radius);
    expect(rounded[0][2]).toBeCloseTo(width - radius);
    expect(rounded[0][3]).toBeCloseTo(height);
    expect(rounded[1][0]).toBeCloseTo(radius);
    expect(rounded[1][2]).toBeCloseTo(radius);
    expect(rounded[1][3]).toBe(0);
  });
});
