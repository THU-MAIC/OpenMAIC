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
 * Per-op round-trip for `slide.update` background. A solid background becomes a
 * `<p:bg>` solid fill; an image background becomes a `<p:bg>` blip fill.
 */
describe('round-trip: slide.update background', () => {
  it('serializes a solid background into a <p:bg> solid fill', async () => {
    const { scene, content } = makeSlideFixture();

    const before = await readSlideXml(await exportSlideContent(content, scene));
    // Guard: the default fixture's background is white, not the red we set.
    expect(before).not.toContain('<a:srgbClr val="FF0000"/>');

    const after = await readSlideXml(
      await exportSlideContent(
        applySlideEditOperation(content, {
          type: 'slide.update',
          patch: { background: { type: 'solid', color: '#ff0000' } },
        }),
        scene,
      ),
    );
    expect(after).toContain('<p:bg>');
    expect(after).toContain('<a:srgbClr val="FF0000"/>');
  });

  it('serializes an image background into a <p:bg> blip fill', async () => {
    const { scene, content } = makeSlideFixture();

    const before = await readSlideXml(await exportSlideContent(content, scene));
    // Guard: the default (solid white) fixture background is not a blip fill.
    expect(before).not.toContain('<a:blipFill');

    const after = await readSlideXml(
      await exportSlideContent(
        applySlideEditOperation(content, {
          type: 'slide.update',
          patch: { background: { type: 'image', image: { src: DATA_URL, size: 'cover' } } },
        }),
        scene,
      ),
    );
    expect(after).toContain('<p:bg>');
    expect(after).toContain('<a:blipFill');
  });
});
