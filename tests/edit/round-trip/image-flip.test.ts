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

function slideWithImage(): { scene: Scene; content: SlideContent } {
  const { scene, content } = makeSlideFixture();
  const withImage = applySlideEditOperation(content, {
    type: 'element.add',
    element: createDefaultImageElement('img-1', DATA_URL),
  });
  return { scene, content: withImage };
}

/**
 * Per-op round-trip for the image `element.update` flip patch: flip becomes
 * `flipH`/`flipV` attributes on the pic's `<a:xfrm>`.
 */
describe('round-trip: image flip', () => {
  it('serializes flipH / flipV onto the pic xfrm', async () => {
    const { scene, content } = slideWithImage();

    const before = await readSlideXml(await exportSlideContent(content, scene));
    // Guard: an un-flipped image carries no flip attrs.
    expect(before).not.toContain('flipH="1"');
    expect(before).not.toContain('flipV="1"');

    const after = await readSlideXml(
      await exportSlideContent(
        applySlideEditOperation(content, {
          type: 'element.update',
          elementId: 'img-1',
          patch: { flipH: true, flipV: true },
        }),
        scene,
      ),
    );
    expect(after).toContain('flipH="1"');
    expect(after).toContain('flipV="1"');
  });
});
