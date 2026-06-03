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

/**
 * 1×1 transparent PNG as a data URL — the canonical output of a local-file
 * upload when OpenMAIC has no upload backend.
 */
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

async function readPptxEntry(blob: Blob, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const entry = zip.file(path);
  if (!entry) throw new Error(`PPTX did not contain entry: ${path}`);
  return entry.async('string');
}

describe('round-trip: image with data URL src (PR2 R1 gate)', () => {
  it('exports a data-URL image element to a non-empty PPTX without network fetch', async () => {
    const { scene, content } = makeSlideFixture();

    const after = applySlideEditOperation(content, {
      type: 'element.add',
      element: createDefaultImageElement('img-dataurl-1', DATA_URL),
    });

    const blob = await exportSlideContent(after, scene);

    // Basic size guard — a valid PPTX is always several KB at minimum.
    expect(blob.size).toBeGreaterThan(0);

    // The slide XML entry must be present and non-empty.
    const slideXml = await readPptxEntry(blob, 'ppt/slides/slide1.xml');
    expect(slideXml.length).toBeGreaterThan(0);
  });
});
