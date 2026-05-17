import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildPptxBlob } from '@/lib/export/use-export-pptx';
import { applySlideEditOperation } from '@/lib/edit/slide-ops';
import {
  createDefaultImageElement,
  createDefaultTextElement,
} from '@/lib/edit/slide-edit-elements';
import type { Scene, SlideContent } from '@/lib/types/stage';
import {
  makeSlideFixture,
  RATIO_PX2_INCH,
  RATIO_PX2_PT,
  VIEWPORT_RATIO,
  VIEWPORT_SIZE,
} from './fixtures';

/**
 * Round-trip gate: tests element.add on default text and image elements.
 *
 * (a) Text element: verifies default content survives PPTX export.
 * (b) Image element with remote URL: verifies that the export pipeline
 *     does NOT crash when network-fetched images cannot be embedded (CI has no network);
 *     the real image round-trip (data-URL) is covered by image-data-url.test.ts.
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

    // (a) Tests that createDefaultTextElement's default content ('<p>New text</p>')
    // survives the PPTX export pipeline — verifies element.add and export don't
    // lose or corrupt the text element's content.
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

    // (b) Tests that element.add on a remote-URL image does NOT crash or corrupt
    // export. The remote URL cannot be fetched in CI (no network), so the exporter
    // logs "Failed to convert image to base64, skipping element" and omits the image.
    // This case gates that export pipeline is resilient; the REAL image round-trip
    // (data-URL, the PR2 local-upload path) is covered by image-data-url.test.ts
    // and is deliberately not duplicated here.

    // Basic size guard — a valid PPTX is always several KB at minimum.
    expect(blob.size).toBeGreaterThan(0);

    // The slide XML entry must be present and non-empty.
    const slideXml = await readPptxEntry(blob, 'ppt/slides/slide1.xml');
    expect(slideXml.length).toBeGreaterThan(0);
  });
});
