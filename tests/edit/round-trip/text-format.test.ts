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
 * Round-trip gate: formatted text (bold) survives the export pipeline.
 *
 * Discovery (mandatory per task spec): the exported slide1.xml was inspected
 * via a temporary console.log test. The OpenMAIC exporter (pptxgenjs) emits
 * bold as the `b="1"` attribute on `<a:rPr>`, e.g.:
 *   <a:rPr lang="en-US" sz="1152" b="1" dirty="0">
 * The assertions below are pinned to this observed real output.
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

describe('round-trip: formatted text (PR2 gate)', () => {
  it('preserves bold text and emits b="1" on the run property after text.updateContent', async () => {
    const { scene, content, textElementId } = makeSlideFixture();

    const NEEDLE = 'RT_BOLD_NEEDLE';

    const after = applySlideEditOperation(content, {
      type: 'text.updateContent',
      elementId: textElementId,
      content: `<p><strong>${NEEDLE}</strong></p>`,
    });

    const blob = await exportSlideContent(after, scene);
    const slideXml = await readPptxEntry(blob, 'ppt/slides/slide1.xml');

    // The needle text must survive serialisation.
    expect(slideXml).toContain(NEEDLE);

    // The exporter (pptxgenjs) encodes bold as b="1" on the <a:rPr> element.
    // Pinned to observed real output: <a:rPr lang="en-US" sz="1152" b="1" dirty="0">
    expect(slideXml).toContain('b="1"');
  });
});
