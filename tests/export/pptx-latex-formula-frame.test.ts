import JSZip from 'jszip';
import { DOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import type { PPTLatexElement, Slide } from '@openmaic/dsl';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';
import { LONG_DERIVATION_FORMULAS } from './fixtures/long-formula-derivation';

const RATIO_PX2_INCH = 96;
const EMU_PER_INCH = 914400;
const EMU_PER_PX = EMU_PER_INCH / RATIO_PX2_INCH;

/**
 * A tight box, the case #1905 hit: the formula fills the element, so a text
 * frame inset or a wrapping body breaks the equation onto extra lines.
 */
const FORMULA_BOX = { left: 80, top: 120, width: 720, height: 48 };

function latexSlide(latex: string): Slide {
  const element: PPTLatexElement = {
    id: 'formula',
    type: 'latex',
    left: FORMULA_BOX.left,
    top: FORMULA_BOX.top,
    width: FORMULA_BOX.width,
    height: FORMULA_BOX.height,
    rotate: 0,
    latex,
    align: 'center',
  };
  return {
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
}

describe('PPTX block formula frames (#1905)', () => {
  it.each(Object.entries(LONG_DERIVATION_FORMULAS))(
    'exports %s as one no-wrap equation frame the width of the element',
    async (_name, latex) => {
      const blob = await buildPptxBlob(
        [latexSlide(latex)],
        [],
        0.5625,
        960,
        RATIO_PX2_INCH,
        96 / 72,
      );
      const xml = await (await JSZip.loadAsync(await blob.arrayBuffer()))
        .file('ppt/slides/slide1.xml')!
        .async('string');
      const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;

      // One equation shape. The formula is not rewritten into manual OMML breaks.
      expect(doc.getElementsByTagName('a14:m')).toHaveLength(1);
      expect(xml).not.toContain('<m:brk');
      expect(xml).toContain('<m:oMath');

      // The first a:ext on the slide is the group transform (cx="0"). The
      // equation lives in mc:Choice and mc:Fallback p:sp shapes.
      const shapes = Array.from(doc.getElementsByTagName('p:sp'));
      expect(shapes.length).toBeGreaterThan(0);
      for (const shape of shapes) {
        const extent = shape.getElementsByTagName('a:ext')[0];
        expect(extent.getAttribute('cx')).toBe(String(FORMULA_BOX.width * EMU_PER_PX));
        expect(extent.getAttribute('cy')).toBe(String(FORMULA_BOX.height * EMU_PER_PX));

        // Default insets (91440 EMU each side) make the text frame narrower
        // than the element, and wrap="square" lets PowerPoint and WPS break
        // a long equation onto several lines.
        const body = shape.getElementsByTagName('a:bodyPr')[0];
        expect(body.getAttribute('wrap')).toBe('none');
        expect(body.getAttribute('lIns')).toBe('0');
        expect(body.getAttribute('tIns')).toBe('0');
        expect(body.getAttribute('rIns')).toBe('0');
        expect(body.getAttribute('bIns')).toBe('0');
        expect(body.getElementsByTagName('a:spAutoFit')).toHaveLength(1);
      }
    },
  );
});
