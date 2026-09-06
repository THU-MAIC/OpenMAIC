import { describe, expect, it } from 'vitest';

import {
  indexGeneratedMediaReferences,
  isGeneratedMediaSatisfied,
  rewriteSlideMediaReference,
  rewriteStageMediaReference,
  sceneCarriesMediaReference,
} from '@/lib/media/generated-media-references';
import type { Scene, Stage } from '@/lib/types/stage';

function imageElement(id: string, src: string) {
  return { type: 'image', id, left: 0, top: 0, width: 10, height: 10, src, fixedRatio: false };
}

function videoElement(id: string, src: string, extra: Record<string, unknown> = {}) {
  return { type: 'video', id, left: 0, top: 0, width: 10, height: 10, src, ...extra };
}

function slide(elements: unknown[], background?: unknown) {
  return { id: 'slide-1', elements, ...(background ? { background } : {}) } as never;
}

function slideScene(order: number, elements: unknown[]): Scene {
  return {
    id: `scene-${order}`,
    stageId: 'stage',
    title: 'Scene',
    order,
    type: 'slide',
    content: { type: 'slide', canvas: slide(elements) },
  } as unknown as Scene;
}

describe('generated media references', () => {
  it('rewrites every slot that carries the placeholder', () => {
    const target = slide([
      imageElement('a', 'gen_img_1'),
      imageElement('b', 'https://example.test/kept.png'),
      videoElement('c', 'gen_img_1', { mediaRef: 'gen_img_1' }),
    ]);

    expect(
      rewriteSlideMediaReference(target, { placeholderRef: 'gen_img_1', assetId: 'ast_1' }),
    ).toBe(true);
    const elements = (target as unknown as { elements: Array<Record<string, string>> }).elements;
    expect(elements[0].src).toBe('ast_1');
    expect(elements[1].src).toBe('https://example.test/kept.png');
    expect(elements[2].src).toBe('ast_1');
    expect(elements[2].mediaRef).toBe('ast_1');
  });

  it('rewrites an image background', () => {
    const target = slide([], { type: 'image', image: { src: 'gen_img_bg' } });

    expect(
      rewriteSlideMediaReference(target, { placeholderRef: 'gen_img_bg', assetId: 'ast_bg' }),
    ).toBe(true);
    expect(
      (target as unknown as { background: { image: { src: string } } }).background.image.src,
    ).toBe('ast_bg');
  });

  it('reports no change when nothing carries the placeholder', () => {
    const target = slide([imageElement('a', 'ast_existing')]);

    expect(
      rewriteSlideMediaReference(target, { placeholderRef: 'gen_img_1', assetId: 'ast_1' }),
    ).toBe(false);
  });

  it('writes a generated poster onto the element it matched, and only when free', () => {
    const target = slide([
      videoElement('a', 'gen_vid_1', { mediaRef: 'gen_vid_1' }),
      videoElement('b', 'gen_vid_2', { poster: 'gen_vid_2_poster' }),
    ]);

    rewriteSlideMediaReference(target, {
      placeholderRef: 'gen_vid_1',
      assetId: 'ast_video',
      posterAssetId: 'ast_poster',
    });
    const elements = (target as unknown as { elements: Array<Record<string, string>> }).elements;
    expect(elements[0].poster).toBe('ast_poster');
    // Untouched: the rewrite never matched this element.
    expect(elements[1].poster).toBe('gen_vid_2_poster');
  });

  it('never overwrites an author-chosen poster', () => {
    const target = slide([
      videoElement('a', 'gen_vid_1', { poster: 'https://example.test/chosen.jpg' }),
    ]);

    rewriteSlideMediaReference(target, {
      placeholderRef: 'gen_vid_1',
      assetId: 'ast_video',
      posterAssetId: 'ast_poster',
    });
    const elements = (target as unknown as { elements: Array<Record<string, string>> }).elements;
    expect(elements[0].src).toBe('ast_video');
    expect(elements[0].poster).toBe('https://example.test/chosen.jpg');
  });

  it('rewrites stage whiteboard slides', () => {
    const stage = {
      id: 'stage',
      whiteboard: [slide([imageElement('a', 'gen_img_wb')])],
    } as unknown as Stage;

    expect(
      rewriteStageMediaReference(stage, { placeholderRef: 'gen_img_wb', assetId: 'ast_wb' }),
    ).toBe(true);
    expect(
      (stage as unknown as { whiteboard: Array<{ elements: Array<{ src: string }> }> })
        .whiteboard[0].elements[0].src,
    ).toBe('ast_wb');
  });

  it('finds a placeholder in a scene whiteboard as well as its canvas', () => {
    const scene = slideScene(1, [imageElement('a', 'ast_done')]);
    (scene as unknown as { whiteboards: unknown[] }).whiteboards = [
      slide([imageElement('b', 'gen_img_wb')]),
    ];

    expect(sceneCarriesMediaReference(scene, 'gen_img_wb')).toBe(true);
    expect(sceneCarriesMediaReference(scene, 'gen_img_absent')).toBe(false);
  });

  describe('document skip test', () => {
    const document = {
      stage: { whiteboard: [] } as unknown as Stage,
      scenes: [
        slideScene(1, [imageElement('a', 'ast_generated')]),
        slideScene(2, [imageElement('b', 'gen_img_pending')]),
      ],
    };

    it('treats a materialized slide with no placeholder left as satisfied', () => {
      const index = indexGeneratedMediaReferences(document);
      expect(isGeneratedMediaSatisfied(index, 1, 'gen_img_done')).toBe(true);
    });

    it('treats a placeholder still present as unsatisfied', () => {
      const index = indexGeneratedMediaReferences(document);
      expect(isGeneratedMediaSatisfied(index, 2, 'gen_img_pending')).toBe(false);
    });

    it('never claims satisfaction for a scene that has not been written yet', () => {
      const index = indexGeneratedMediaReferences(document);
      expect(isGeneratedMediaSatisfied(index, 3, 'gen_img_future')).toBe(false);
    });

    it('counts a placeholder held only by the stage whiteboard', () => {
      const index = indexGeneratedMediaReferences({
        stage: { whiteboard: [slide([imageElement('a', 'gen_img_wb')])] } as unknown as Stage,
        scenes: [slideScene(1, [])],
      });
      expect(index.pendingPlaceholders.has('gen_img_wb')).toBe(true);
      expect(isGeneratedMediaSatisfied(index, 1, 'gen_img_wb')).toBe(false);
    });
  });
});
