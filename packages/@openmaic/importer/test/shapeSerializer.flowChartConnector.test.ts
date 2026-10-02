import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { parseShapeNode } from '../src/model/nodes/ShapeNode';
import { renderShape } from '../src/serializer/shapeSerializer';
import { transformParsedToSlides } from '../src/import-pipeline/transformParsedToSlides';
import { createMockImportContext } from '../src/import-pipeline/mockContext';
import { minimalCtx } from './helpers';

async function importPreset(preset: string) {
  const shape = await renderShape(
    parseShapeNode(
      parseXml(`<p:sp xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:nvSpPr><p:cNvPr id="18" name="circle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="4338384" y="3126766"/><a:ext cx="2732400" cy="2703600"/></a:xfrm>
    <a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom>
    <a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="EC5F74"/></a:gs><a:gs pos="100000"><a:srgbClr val="F6B4BE"/></a:gs></a:gsLst><a:lin ang="18900000" scaled="1"/></a:gradFill>
    <a:ln w="88900" cmpd="thinThick"><a:solidFill><a:srgbClr val="C0C0C0"/></a:solidFill></a:ln></p:spPr>
    <p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`),
    ),
    minimalCtx(),
    0,
  );
  const json = {
    size: { width: 960, height: 540 },
    themeColors: [],
    slides: [
      {
        fill: { type: 'color', value: '#ffffff' },
        note: '',
        layoutElements: [],
        elements: [shape],
      },
    ],
  };
  const { slides } = await transformParsedToSlides(
    json as Parameters<typeof transformParsedToSlides>[0],
    createMockImportContext({ viewportWidth: 1280 }),
  );
  return { shape, element: slides[0].elements[0] };
}

describe('flowchart nodes versus connector lines', () => {
  it.each(['flowChartConnector', 'flowChartOffpageConnector'])(
    'retains %s as a filled area through the full pipeline',
    async (preset) => {
      const { shape, element } = await importPreset(preset);
      expect(shape.fill.type).toBe('gradient');
      expect(element.type).toBe('shape');
      if (element.type !== 'shape') throw new Error('Expected area shape');
      expect(element.gradient?.colors).toHaveLength(2);
      expect(element.path).toContain('Z');
      if (preset === 'flowChartConnector') expect(element.path).toContain('A');
    },
  );
  it('preserves the inverse diagonal path of lineInv', async () => {
    const { shape, element } = await importPreset('lineInv');
    expect(element.type).toBe('shape');
    if (element.type !== 'shape' || shape.type !== 'shape') {
      throw new Error('Expected inverse path shape');
    }
    expect(element.path).toBe(shape.path);
    expect(element.path).toMatch(/^M[\d.]+,0 L0,[\d.]+$/);
  });
  it.each([
    'line',
    'straightConnector1',
    'bentConnector2',
    'bentConnector5',
    'curvedConnector2',
    'curvedConnector5',
  ])('keeps %s as a line', async (preset) => {
    const { shape, element } = await importPreset(preset);
    expect(shape.fill).toEqual({ type: 'color', value: 'transparent' });
    expect(element.type).toBe('line');
  });
});
