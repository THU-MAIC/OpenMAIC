import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';
import { applySlideEditOperation } from '@/lib/edit/slide-ops';
import type { Scene, SlideContent } from '@/lib/types/stage';
import {
  makeSlideFixture,
  RATIO_PX2_INCH,
  RATIO_PX2_PT,
  VIEWPORT_RATIO,
  VIEWPORT_SIZE,
} from './fixtures';

/**
 * Per-op round-trip for the `element.update` geometry op (PR1's only
 * editing op). Asserts the moved/resized/rotated geometry survives the
 * export pipeline as the exact PPTX `<a:off>` / `<a:ext>` / `rot`
 * attributes — and that the un-edited fixture does NOT already carry them,
 * so the assertion proves the op drove the change rather than matching
 * boilerplate. See the harness note in `text-content.test.ts`.
 */
async function exportSlideContent(content: SlideContent, scene: Scene): Promise<Blob> {
  return buildPptxBlob(
    [content.canvas],
    [scene],
    VIEWPORT_RATIO,
    VIEWPORT_SIZE,
    RATIO_PX2_INCH,
    RATIO_PX2_PT,
  );
}

async function readPptxEntry(blob: Blob, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const entry = zip.file(path);
  if (!entry) throw new Error(`PPTX did not contain entry: ${path}`);
  return entry.async('string');
}

// PPTX uses EMU for position/size and 60000ths of a degree for rotation.
const px2emu = (px: number) => Math.round((px * 914400) / RATIO_PX2_INCH);
const deg2rot = (deg: number) => deg * 60000;

describe('round-trip: element.update geometry', () => {
  it('serializes moved/resized/rotated geometry into the slide xml', async () => {
    const { scene, content, textElementId } = makeSlideFixture();
    const GEO = { left: 333, top: 222, width: 444, height: 111, rotate: 45 };

    const before = await readPptxEntry(
      await exportSlideContent(content, scene),
      'ppt/slides/slide1.xml',
    );
    const offNeedle = `<a:off x="${px2emu(GEO.left)}" y="${px2emu(GEO.top)}"/>`;
    const extNeedle = `<a:ext cx="${px2emu(GEO.width)}" cy="${px2emu(GEO.height)}"/>`;
    const rotNeedle = `rot="${deg2rot(GEO.rotate)}"`;
    // Guard against a tautology: the default fixture must not already match.
    expect(before).not.toContain(offNeedle);
    expect(before).not.toContain(rotNeedle);

    const after = applySlideEditOperation(content, {
      type: 'element.update',
      elementId: textElementId,
      patch: GEO,
    });
    const slideXml = await readPptxEntry(
      await exportSlideContent(after, scene),
      'ppt/slides/slide1.xml',
    );

    expect(slideXml).toContain(offNeedle);
    expect(slideXml).toContain(extNeedle);
    expect(slideXml).toContain(rotNeedle);
  });
});
