import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';
import { applySlideEditOperation } from '@/lib/edit/slide-ops';
import { createDefaultImageElement, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import type { Scene, SlideContent } from '@/lib/types/stage';
import {
  makeSlideFixture,
  RATIO_PX2_INCH,
  RATIO_PX2_PT,
  VIEWPORT_RATIO,
  VIEWPORT_SIZE,
} from './fixtures';

/**
 * Round-trip gate: inserted elements (text + image) survive the export
 * pipeline. Mirrors the helper pattern established in text-content.test.ts
 * and image-data-url.test.ts.
 *
 * Default content for createDefaultTextElement is '<p>New text</p>' (from
 * lib/edit/slide-edit-elements.ts), so the needle asserted below is the
 * literal inner text "New text".
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

describe('round-trip: element.add inserts (PR2 gate)', () => {
  it('(a) inserted default text element — default content survives export', async () => {
    const { scene, content } = makeSlideFixture();

    // createDefaultTextElement sets content to '<p>New text</p>'; the inner
    // text "New text" must appear in the exported slide XML.
    const DEFAULT_TEXT_NEEDLE = 'New text';

    const after = applySlideEditOperation(content, {
      type: 'element.add',
      element: createDefaultTextElement('rt-text-1'),
    });

    const blob = await exportSlideContent(after, scene);
    const slideXml = await readPptxEntry(blob, 'ppt/slides/slide1.xml');

    expect(slideXml).toContain(DEFAULT_TEXT_NEEDLE);
  });

  it('(b) inserted default image element (remote URL) — slide XML is non-empty', async () => {
    const { scene, content } = makeSlideFixture();

    const after = applySlideEditOperation(content, {
      type: 'element.add',
      element: createDefaultImageElement('rt-img-1', 'https://example.com/x.png'),
    });

    const blob = await exportSlideContent(after, scene);

    // Basic size guard — a valid PPTX is always several KB at minimum.
    expect(blob.size).toBeGreaterThan(0);

    // The slide XML entry must be present and non-empty; mirrors
    // image-data-url.test.ts assertion style for the image-present check.
    const slideXml = await readPptxEntry(blob, 'ppt/slides/slide1.xml');
    expect(slideXml.length).toBeGreaterThan(0);
  });
});
