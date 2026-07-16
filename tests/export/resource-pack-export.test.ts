import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { buildResourcePackZip } from '@/lib/export/use-export-pptx';
import type { Scene } from '@/lib/types/stage';

// Scenes with no external assets, so inlineHtmlAssets does no network fetches.
const interactiveHtml = '<!DOCTYPE html><html><body><h1>Spin the frame</h1></body></html>';

function interactiveScene(overrides: Partial<Scene> = {}): Scene {
  return {
    id: 's1',
    stageId: 'stg1',
    title: 'Interactive demo',
    order: 1,
    type: 'interactive',
    content: { type: 'interactive', url: '', html: interactiveHtml },
    ...overrides,
  } as unknown as Scene;
}

async function readZipFiles(blob: Blob): Promise<Record<string, Uint8Array>> {
  // JSZip in Node can't consume a web Blob directly — convert to ArrayBuffer first.
  const buf = await blob.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const entries: Record<string, Uint8Array> = {};
  const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  await Promise.all(
    files.map(async (name) => {
      entries[name] = await zip.files[name].async('uint8array');
    }),
  );
  return entries;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('buildResourcePackZip', () => {
  describe('interactive-only deck (no slides)', () => {
    it('does not invoke the PPTX builder', async () => {
      const getPptxBlob = vi.fn(async () => new Blob(['pptx-bytes']));

      const result = await buildResourcePackZip([interactiveScene()], [], [], {
        viewportRatio: 0.5625,
        viewportSize: 960,
        ratioPx2Inch: 96,
        ratioPx2Pt: 96 / 72,
        fileName: 'demo',
        getPptxBlob,
      });

      expect(result.empty).toBe(false);
      expect(getPptxBlob).not.toHaveBeenCalled();
    });

    it('ships a ZIP containing the interactive HTML page and no PPTX', async () => {
      const getPptxBlob = vi.fn(async () => new Blob(['pptx-bytes']));

      const result = await buildResourcePackZip([interactiveScene()], [], [], {
        viewportRatio: 0.5625,
        viewportSize: 960,
        ratioPx2Inch: 96,
        ratioPx2Pt: 96 / 72,
        fileName: 'demo',
        getPptxBlob,
      });

      expect(result.blob).not.toBeNull();
      expect(result.skippedPptx).toBe(true);

      const files = await readZipFiles(result.blob!);
      const names = Object.keys(files);
      // The interactive HTML page made it into the ZIP.
      expect(names.some((n) => n.startsWith('interactive/'))).toBe(true);
      const htmlEntry = names.find((n) => n.startsWith('interactive/'))!;
      expect(decode(files[htmlEntry])).toBe(interactiveHtml);
      // No PPTX shipped for an interactive-only deck.
      expect(names.some((n) => n.endsWith('.pptx'))).toBe(false);
    });
  });

  describe('deck with slides', () => {
    it('invokes the PPTX builder and includes the PPTX in the ZIP', async () => {
      // jszip reliably round-trips Uint8Array entries in Node; a Blob-backed
      // entry can confuse loadAsync when reading back.
      const pptxBytes = new Uint8Array([1, 2, 3, 4]);
      const getPptxBlob = vi.fn(async () => new Blob([pptxBytes]));

      const slideScene = {
        id: 's2',
        stageId: 'stg1',
        title: 'A slide',
        order: 1,
        type: 'slide',
        content: { type: 'slide', canvas: { width: 960, height: 540, elements: [] } },
      } as unknown as Scene;

      // The real slides' content isn't read — getPptxBlob is mocked, so the
      // builder only needs slides.length > 0 to decide PPTX is included.
      const placeholderSlide = { id: 'sl1' } as unknown as Parameters<
        typeof buildResourcePackZip
      >[1][number];

      const result = await buildResourcePackZip([slideScene], [placeholderSlide], [slideScene], {
        viewportRatio: 0.5625,
        viewportSize: 960,
        ratioPx2Inch: 96,
        ratioPx2Pt: 96 / 72,
        fileName: 'deck',
        getPptxBlob,
      });

      expect(result.empty).toBe(false);
      expect(result.skippedPptx).toBe(false);
      expect(getPptxBlob).toHaveBeenCalledTimes(1);

      // The PPTX entry is present in the generated ZIP.
      const buf = await result.blob!.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      expect(Object.keys(zip.files)).toContain('deck.pptx');
    });
  });

  describe('empty deck (no slides, no interactive pages)', () => {
    it('returns empty and does not build anything', async () => {
      const getPptxBlob = vi.fn(async () => new Blob(['pptx-bytes']));

      const result = await buildResourcePackZip([], [], [], {
        viewportRatio: 0.5625,
        viewportSize: 960,
        ratioPx2Inch: 96,
        ratioPx2Pt: 96 / 72,
        fileName: 'empty',
        getPptxBlob,
      });

      expect(result.empty).toBe(true);
      expect(result.blob).toBeNull();
      expect(getPptxBlob).not.toHaveBeenCalled();
    });
  });

  describe('interactive scene without html', () => {
    it('treats an interactive scene lacking an html payload as non-exportable', async () => {
      const getPptxBlob = vi.fn(async () => new Blob(['pptx-bytes']));
      const sceneNoHtml = interactiveScene({
        content: { type: 'interactive', url: 'https://example.com', html: '' },
      });

      const result = await buildResourcePackZip([sceneNoHtml], [], [], {
        viewportRatio: 0.5625,
        viewportSize: 960,
        ratioPx2Inch: 96,
        ratioPx2Pt: 96 / 72,
        fileName: 'demo',
        getPptxBlob,
      });

      // No html + no slides ⇒ nothing to ship.
      expect(result.empty).toBe(true);
      expect(result.blob).toBeNull();
      expect(getPptxBlob).not.toHaveBeenCalled();
    });
  });

  describe('multiple interactive scenes', () => {
    it('numbers each HTML page and sanitizes titles in the filename', async () => {
      const getPptxBlob = vi.fn(async () => new Blob(['pptx-bytes']));
      const scenes = [
        interactiveScene({ id: 'a', title: 'First/Widget', order: 1 }),
        interactiveScene({ id: 'b', title: 'Second', order: 2 }),
        interactiveScene({ id: 'c', title: 'Third: Map', order: 3 }),
      ];

      const result = await buildResourcePackZip(scenes, [], [], {
        viewportRatio: 0.5625,
        viewportSize: 960,
        ratioPx2Inch: 96,
        ratioPx2Pt: 96 / 72,
        fileName: 'demo',
        getPptxBlob,
      });

      expect(result.empty).toBe(false);
      const files = await readZipFiles(result.blob!);
      const names = Object.keys(files);
      // Three distinct HTML pages, zero-padded indices, forbidden chars scrubbed.
      // Regex /[\\/:*?"<>|]/g replaces / and : with _, but spaces are kept.
      expect(names).toContain('interactive/01_First_Widget.html');
      expect(names).toContain('interactive/02_Second.html');
      expect(names).toContain('interactive/03_Third_ Map.html');
      // No name collision: all three pages survived.
      expect(names.filter((n) => n.startsWith('interactive/'))).toHaveLength(3);
    });
  });
});
