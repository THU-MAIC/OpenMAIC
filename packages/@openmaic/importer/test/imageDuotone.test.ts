import { expect, it } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { minimalCtx } from './helpers';
import { applyDuotoneToDataUrl } from '../src/serializer/imageDuotone';
const src = 'data:image/png;base64,AQID';
it('maps image luminance to the two resolved colors and preserves source alpha', () => {
  const duo = parseXml(
    '<a:duotone xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:srgbClr val="808080"/><a:prstClr val="white"/></a:duotone>',
  );
  const out = decodeURIComponent(applyDuotoneToDataUrl(src, duo, minimalCtx()));
  expect(out).toContain('feColorMatrix');
  expect(out).toContain('tableValues="0.5019607843137255 1"');
  expect(out).toContain('<feFuncA type="identity"');
  expect(out).toContain(src);
});
it('leaves ordinary images unchanged', () => {
  expect(applyDuotoneToDataUrl(src, parseXml('<blip/>').child('duotone'), minimalCtx())).toBe(src);
});
