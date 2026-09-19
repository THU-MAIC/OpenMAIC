import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { parseShapeNode } from '../src/model/nodes/ShapeNode';
import { renderShape } from '../src/serializer/shapeSerializer';
import { transformParsedToSlides } from '../src/import-pipeline/transformParsedToSlides';
import { createMockImportContext } from '../src/import-pipeline/mockContext';
import { minimalCtx } from './helpers';

const resourceShape = readFileSync(
  new URL('./fixtures/slide18-resource-shape.xml', import.meta.url),
  'utf8',
);

describe('shape text auto-fit through the import pipeline', () => {
  it.each([
    ['<a:normAutofit fontScale="90000" />', '24.0'],
    ['<a:normAutofit />', '26.7'],
    ['<a:noAutofit />', '26.7'],
    ['<a:spAutoFit />', '26.7'],
  ])('honors %s without scaling the resource box or its insets', async (autoFit, fontSize) => {
    const xml = resourceShape.replace('<a:normAutofit fontScale="90000" />', autoFit);
    const parsed = await renderShape(parseShapeNode(parseXml(xml)), minimalCtx(), 0);
    expect(parsed.type).toBe('shape');
    const originalWidth = parsed.width;
    const originalHeight = parsed.height;
    const json = {
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
    };
    const { slides } = await transformParsedToSlides(
      json as unknown as Parameters<typeof transformParsedToSlides>[0],
      createMockImportContext({ viewportWidth: 1280 }),
    );
    const result = slides[0].elements[0];
    expect(result.type).toBe('shape');
    if (result.type !== 'shape') throw new Error('Expected a shape');
    // WPS: 20pt × 90% = 18pt, or 24 CSS px at 96dpi.
    const sizes = [...result.text!.content.matchAll(/font-size: ([\d.]+)px/g)].map((m) => m[1]);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sizes)).toEqual(new Set([fontSize]));
    expect(result.text!.content).toContain('padding: 4.8px 9.6px 4.8px 9.6px');
    expect(result.width).toBeCloseTo((originalWidth * 4) / 3);
    expect(result.height).toBeCloseTo((originalHeight * 4) / 3);
  });
});
