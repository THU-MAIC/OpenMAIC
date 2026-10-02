import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { parseShapeNode } from '../src/model/nodes/ShapeNode';
import { renderShape } from '../src/serializer/shapeSerializer';
import { minimalCtx } from './helpers';

async function render(
  material = 'clear',
  camera = 'orthographicFront',
  fill = '<a:solidFill><a:srgbClr val="F7BFC8"/></a:solidFill>',
  rotation = '',
  light = '<a:lightRig rig="chilly" dir="t"><a:rot lat="0" lon="0" rev="18480000"/></a:lightRig>',
) {
  return renderShape(
    parseShapeNode(
      parseXml(`<p:sp xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:nvSpPr><p:cNvPr id="11" name="round rectangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2734595" cy="1050794"/></a:xfrm>
    <a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>${fill}
    <a:scene3d><a:camera prst="${camera}">${rotation}</a:camera>${light}</a:scene3d>
    <a:sp3d prstMaterial="${material}"><a:bevelT h="63500" prst="relaxedInset"/></a:sp3d></p:spPr>
    <p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`),
    ),
    minimalCtx(),
    0,
  );
}

describe('clear material front-face compatibility', () => {
  it('approximates the pale neutral WPS surface instead of the opaque pink base fill', async () => {
    expect((await render()).fill).toEqual({ type: 'color', value: '#F9F6F7' });
  });
  it('preserves existing fill alpha', async () => {
    expect(
      (
        await render(
          'clear',
          'orthographicFront',
          '<a:solidFill><a:srgbClr val="F7BFC8"><a:alpha val="50000"/></a:srgbClr></a:solidFill>',
        )
      ).fill,
    ).toEqual({ type: 'color', value: '#F9F6F780' });
  });
  it('does not approximate unverified lighting or camera revolution', async () => {
    expect(
      (
        await render(
          'clear',
          'orthographicFront',
          undefined,
          '',
          '<a:lightRig rig="chilly" dir="b"/>',
        )
      ).fill,
    ).toEqual({ type: 'color', value: '#F7BFC8' });
    expect(
      (
        await render(
          'clear',
          'orthographicFront',
          undefined,
          '',
          '<a:lightRig rig="chilly" dir="t"/>',
        )
      ).fill,
    ).toEqual({ type: 'color', value: '#F7BFC8' });
    expect(
      (
        await render(
          'clear',
          'orthographicFront',
          undefined,
          '<a:rot lat="0" lon="0" rev="60000"/>',
        )
      ).fill,
    ).toEqual({ type: 'color', value: '#F7BFC8' });
  });
  it('leaves other materials, rotated cameras, and no-fill unchanged', async () => {
    expect((await render('plastic')).fill).toEqual({ type: 'color', value: '#F7BFC8' });
    expect((await render('clear', 'perspectiveFront')).fill).toEqual({
      type: 'color',
      value: '#F7BFC8',
    });
    expect(
      (
        await render(
          'clear',
          'orthographicFront',
          undefined,
          '<a:rot lat="60000" lon="0" rev="0"/>',
        )
      ).fill,
    ).toEqual({ type: 'color', value: '#F7BFC8' });
    expect((await render('clear', 'orthographicFront', '<a:noFill/>')).fill).toEqual({
      type: 'color',
      value: 'transparent',
    });
  });
});
