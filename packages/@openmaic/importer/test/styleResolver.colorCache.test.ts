import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { resolveColor } from '../src/serializer/StyleResolver';
import { minimalCtx } from './helpers';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

describe('StyleResolver · color cache key (#702)', () => {
  it('does not collide for distinct scrgbClr fills under the same render context', () => {
    const ctx = minimalCtx();
    const redNode = parseXml(
      `<a:solidFill ${NS}><a:scrgbClr r="100000" g="0" b="0"/></a:solidFill>`,
    );
    const blueNode = parseXml(
      `<a:solidFill ${NS}><a:scrgbClr r="0" g="0" b="100000"/></a:solidFill>`,
    );

    const red = resolveColor(redNode, ctx);
    const blue = resolveColor(blueNode, ctx);

    expect(red.color.toLowerCase()).toBe('ff0000');
    expect(blue.color.toLowerCase()).toBe('0000ff');
    expect(ctx.colorCache.size).toBe(2);
  });

  it('does not collide for distinct hslClr fills under the same render context', () => {
    const ctx = minimalCtx();
    // 0 deg = red, 240 deg (14400000 / 60000) = blue
    const redNode = parseXml(
      `<a:solidFill ${NS}><a:hslClr hue="0" sat="100000" lum="50000"/></a:solidFill>`,
    );
    const blueNode = parseXml(
      `<a:solidFill ${NS}><a:hslClr hue="14400000" sat="100000" lum="50000"/></a:solidFill>`,
    );

    const red = resolveColor(redNode, ctx);
    const blue = resolveColor(blueNode, ctx);

    expect(red.color.toLowerCase()).toBe('ff0000');
    expect(blue.color.toLowerCase()).toBe('0000ff');
    expect(ctx.colorCache.size).toBe(2);
  });

  it('does not collide for sysClr differing only by lastClr', () => {
    const ctx = minimalCtx();
    const sysNode1 = parseXml(
      `<a:solidFill ${NS}><a:sysClr val="windowText" lastClr="112233"/></a:solidFill>`,
    );
    const sysNode2 = parseXml(
      `<a:solidFill ${NS}><a:sysClr val="windowText" lastClr="445566"/></a:solidFill>`,
    );

    const color1 = resolveColor(sysNode1, ctx);
    const color2 = resolveColor(sysNode2, ctx);

    expect(color1.color.toLowerCase()).toBe('112233');
    expect(color2.color.toLowerCase()).toBe('445566');
    expect(ctx.colorCache.size).toBe(2);
  });

  it('handles bare sysClr nodes without wrapper element', () => {
    const ctx = minimalCtx();
    const sysNode1 = parseXml(`<a:sysClr ${NS} val="windowText" lastClr="112233"/>`);
    const sysNode2 = parseXml(`<a:sysClr ${NS} val="windowText" lastClr="445566"/>`);

    const color1 = resolveColor(sysNode1, ctx);
    const color2 = resolveColor(sysNode2, ctx);

    expect(color1.color.toLowerCase()).toBe('112233');
    expect(color2.color.toLowerCase()).toBe('445566');
    expect(ctx.colorCache.size).toBe(2);
  });

  it('handles bare scrgbClr nodes without wrapper element', () => {
    const ctx = minimalCtx();
    const node1 = parseXml(`<a:scrgbClr ${NS} r="100000" g="0" b="0"/>`);
    const node2 = parseXml(`<a:scrgbClr ${NS} r="0" g="0" b="100000"/>`);

    const color1 = resolveColor(node1, ctx);
    const color2 = resolveColor(node2, ctx);

    expect(color1.color.toLowerCase()).toBe('ff0000');
    expect(color2.color.toLowerCase()).toBe('0000ff');
    expect(ctx.colorCache.size).toBe(2);
  });

  it('handles bare hslClr nodes without wrapper element', () => {
    const ctx = minimalCtx();
    const node1 = parseXml(`<a:hslClr ${NS} hue="0" sat="100000" lum="50000"/>`);
    const node2 = parseXml(`<a:hslClr ${NS} hue="14400000" sat="100000" lum="50000"/>`);

    const color1 = resolveColor(node1, ctx);
    const color2 = resolveColor(node2, ctx);

    expect(color1.color.toLowerCase()).toBe('ff0000');
    expect(color2.color.toLowerCase()).toBe('0000ff');
    expect(ctx.colorCache.size).toBe(2);
  });

  it('correctly resolves distinct colors for scrgbClr, hslClr, and sysClr shapes from fixture PPTX', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { parse } = await import('../src');
    type ShapeWithColorFill = import('../src/adapter/types').Shape & {
      fill: import('../src/adapter/types').ColorFill;
    };
    const fixturePath = path.resolve(__dirname, 'fixtures/color-cache-collision.pptx');
    const buffer = fs.readFileSync(fixturePath);
    const result = await parse(buffer.buffer);

    const slide = result.slides[0];
    const shapes = slide.elements.filter(
      (el): el is ShapeWithColorFill =>
        el.type === 'shape' &&
        'fill' in el &&
        el.fill?.type === 'color' &&
        el.fill.value !== 'transparent',
    );

    // Expected 6 distinct shape fills:
    // 2 scrgbClr (Red vs Blue), 2 hslClr (Red vs Blue), 2 sysClr (Orange vs Cyan)
    expect(shapes).toHaveLength(6);
    expect(shapes[0].fill.value.toLowerCase()).toBe('#ff0000');
    expect(shapes[1].fill.value.toLowerCase()).toBe('#0000ff');
    expect(shapes[2].fill.value.toLowerCase()).toBe('#ff0000');
    expect(shapes[3].fill.value.toLowerCase()).toBe('#0000ff');
    expect(shapes[4].fill.value.toLowerCase()).toBe('#ff5500');
    expect(shapes[5].fill.value.toLowerCase()).toBe('#00aaff');
  });
});
