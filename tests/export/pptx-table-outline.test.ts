import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/device-storage/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: { mediaFiles: { get: vi.fn().mockResolvedValue(undefined) } },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  getAssetPool: () => ({ resolve: vi.fn().mockResolvedValue(null), release: vi.fn() }),
}));

import { buildPptxBlob } from '@/lib/export/use-export-pptx';

function tableSlide(table: Record<string, unknown>): Slide {
  return {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#ffffff' },
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#ffffff',
      themeColors: ['#111111'],
    },
    elements: [
      {
        id: 'table-1',
        type: 'table',
        left: 40,
        top: 40,
        width: 600,
        height: 120,
        rotate: 0,
        colWidths: [0.5, 0.5],
        data: [
          [
            { id: 'c1', colspan: 1, rowspan: 1, text: 'Para.' },
            { id: 'c2', colspan: 1, rowspan: 1, text: 'Topic sentence' },
          ],
          [
            { id: 'c3', colspan: 1, rowspan: 1, text: '1' },
            { id: 'c4', colspan: 1, rowspan: 1, text: 'Welcome to senior high.' },
          ],
        ],
        ...table,
      },
    ],
  } as unknown as Slide;
}

function sceneFor(slide: Slide): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: { type: 'slide', canvas: slide },
  } as Scene;
}

async function slideXml(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return zip.file('ppt/slides/slide1.xml')!.async('string');
}

describe('PPTX table export', () => {
  it('exports a table that has no outline instead of failing the whole deck', async () => {
    const slide = tableSlide({});

    const blob = await buildPptxBlob([slide], [sceneFor(slide)], 0.5625, 1000, 100, 1, 'stage-1');
    const xml = await slideXml(blob);

    expect(xml).toContain('Topic sentence');
    expect(xml).toContain('Welcome to senior high.');
  });

  it('still applies the border when the table has an outline', async () => {
    const slide = tableSlide({ outline: { width: 2, color: '#ff0000', style: 'solid' } });

    const blob = await buildPptxBlob([slide], [sceneFor(slide)], 0.5625, 1000, 100, 1, 'stage-1');
    const xml = await slideXml(blob);

    expect(xml).toContain('FF0000');
  });
});
