// @vitest-environment jsdom
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { PPTShapeElement, Slide } from '@openmaic/dsl';
import { shapeToTextFallback } from '@openmaic/geometry';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';

const shape: PPTShapeElement = {
  id: 'shape',
  type: 'shape',
  left: 40,
  top: 60,
  width: 200,
  height: 100,
  rotate: 25,
  viewBox: [100, 100],
  path: 'M0 0 Z1 1',
  fixedRatio: false,
  fill: '#14243c',
  text: {
    content: '<p>保留的文字</p>',
    defaultColor: '#ffffff',
    defaultFontName: 'Arial',
    align: 'bottom',
  },
};
async function exported(element: Slide['elements'][number] | null) {
  const slide: Slide = {
    id: 'slide',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: { fontName: 'Arial', fontColor: '#000', backgroundColor: '#fff', themeColors: ['#000'] },
    elements: element ? [element] : [],
  };
  const blob = await buildPptxBlob([slide], [], 0.5625, 1000, 100, 1);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const relationships = (await zip.file('ppt/slides/_rels/slide1.xml.rels')?.async('string')) ?? '';
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  expect(document.getElementsByTagName('parsererror')).toHaveLength(0);
  return {
    xml,
    relationships,
    nodes: Array.from(document.getElementsByTagName('p:sp'), (node) => node.outerHTML),
  };
}
describe('PPTX shared bad-shape recovery', () => {
  it.each([
    { path: 'M0 0 Z1 1' },
    { path: 'M0 0 L100 100', viewBox: [0, 100] as [number, number] },
    { path: 'M0 0 Z1 1', special: true },
  ])('exports historical bad geometry identically to generated fallback text', async (patch) => {
    const bad = { ...shape, ...patch };
    const before = structuredClone(bad);
    const historical = await exported(bad);
    const generated = await exported(shapeToTextFallback(bad));
    expect(historical.xml).toContain('保留的文字');
    expect(historical.nodes).toEqual(generated.nodes);
    expect(historical.xml).toContain('anchor="b"');
    expect(historical.xml).toContain('14243C');
    expect(historical.xml).not.toMatch(/NaN|Infinity/);
    expect(bad).toEqual(before);
  });
  it('omits bad shapes without labels', async () => {
    expect((await exported({ ...shape, text: undefined })).nodes).toEqual([]);
  });
  it.each([
    {
      link: { type: 'web' as const, target: 'https://example.org/lesson' },
      target: 'https://example.org/lesson',
    },
    { link: { type: 'slide' as const, target: 'slide' }, target: 'slide1.xml' },
  ])('preserves $link.type links in recovered text', async ({ link, target }) => {
    const bad = { ...shape, link };
    const historical = await exported(bad);
    const generated = await exported(shapeToTextFallback(bad));
    expect(historical.nodes).toEqual(generated.nodes);
    const linkId = historical.xml.match(/<a:hlinkClick r:id="(rId\d+)"/)?.[1];
    expect(linkId).toBeDefined();
    expect(historical.relationships).toContain(`Id="${linkId}"`);
    expect(historical.relationships).toContain(`Target="${target}"`);
  });
});
