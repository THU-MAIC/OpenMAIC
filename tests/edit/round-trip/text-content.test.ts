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
 * Round-trip harness — apply ops to a fixture SlideContent, run the
 * existing export pipeline (`buildPptxBlob`), and inspect the resulting
 * PPTX bytes via JSZip to verify the ops survived serialization.
 *
 * Caveat (documented for future PRs): the OpenMAIC codebase has no
 * PPTX → Slide reimport path, so this harness is one-way (export side
 * only). The "round-trip" property at the design-principle level is
 * verified end-to-end by opening exports in a desktop tool; CI here
 * catches export-pipeline regressions for each op as slide-surface PRs
 * land. The shape `(fixture + ops) → blob → XML assertion` is the
 * contract slide-surface PRs extend with per-op cases.
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

describe('round-trip harness (export side)', () => {
  it('exports a noop fixture to a non-empty PPTX with the slide1 entry present', async () => {
    const { scene, content } = makeSlideFixture();
    const blob = await exportSlideContent(content, scene);
    expect(blob.size).toBeGreaterThan(0);
    // PPTX format always emits ppt/slides/slide1.xml for the first slide.
    const slideXml = await readPptxEntry(blob, 'ppt/slides/slide1.xml');
    expect(slideXml.length).toBeGreaterThan(0);
  });

  it('captures the new text after applying text.updateContent', async () => {
    const { scene, content, textElementId } = makeSlideFixture();
    // A distinctive needle so the assertion does not accidentally match
    // pptxgenjs boilerplate or the original default text.
    const NEEDLE = 'roundtrip-needle-abc123';
    const after = applySlideEditOperation(content, {
      type: 'text.updateContent',
      elementId: textElementId,
      content: `<p>${NEEDLE}</p>`,
    });
    const blob = await exportSlideContent(after, scene);
    const slideXml = await readPptxEntry(blob, 'ppt/slides/slide1.xml');
    expect(slideXml).toContain(NEEDLE);
  });
});
