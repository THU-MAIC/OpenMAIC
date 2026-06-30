import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';
import { applySlideEditOperation } from '@/lib/edit/slide-ops';
import { createDefaultImageElement } from '@/lib/edit/slide-edit-elements';
import type { Scene, SlideContent } from '@/lib/types/stage';
import {
  makeSlideFixture,
  RATIO_PX2_INCH,
  RATIO_PX2_PT,
  VIEWPORT_RATIO,
  VIEWPORT_SIZE,
} from './fixtures';

const DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

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

async function readSlideXml(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const entry = zip.file('ppt/slides/slide1.xml');
  if (!entry) throw new Error('PPTX did not contain ppt/slides/slide1.xml');
  return entry.async('string');
}

/**
 * Per-op round-trip for `element.reorder`. The renderer paints elements in
 * array order, and so does the PPTX exporter — a text element becomes a
 * `<p:sp>` and an image a `<p:pic>`, emitted in the slide's element order. So
 * the relative position of `<p:sp>` vs `<p:pic>` in slide1.xml IS the z-order.
 */
describe('round-trip: element.reorder z-order', () => {
  it('serializes element order; reorder flips which element is painted first', async () => {
    const { scene, content } = makeSlideFixture(); // a single text element
    // Append an image → order is [text, image]: text (sp) painted first.
    const withImage = applySlideEditOperation(content, {
      type: 'element.add',
      element: createDefaultImageElement('img-z', DATA_URL),
    });

    const before = await readSlideXml(await exportSlideContent(withImage, scene));
    const spBefore = before.indexOf('<p:sp>');
    const picBefore = before.indexOf('<p:pic>');
    expect(spBefore).toBeGreaterThanOrEqual(0);
    expect(picBefore).toBeGreaterThanOrEqual(0);
    // Baseline: text (sp) precedes image (pic) — guards against a tautology.
    expect(spBefore).toBeLessThan(picBefore);

    // Send the image to the back (index 0) → order is [image, text].
    const reordered = applySlideEditOperation(withImage, {
      type: 'element.reorder',
      elementId: 'img-z',
      index: 0,
    });
    const after = await readSlideXml(await exportSlideContent(reordered, scene));
    const spAfter = after.indexOf('<p:sp>');
    const picAfter = after.indexOf('<p:pic>');
    // Now the image (pic) precedes the text (sp).
    expect(picAfter).toBeLessThan(spAfter);
  });
});
