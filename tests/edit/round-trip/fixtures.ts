import { createDefaultSlide, createDefaultTextElement } from '@/lib/edit/slide-edit-elements';
import type { Scene, SlideContent } from '@/lib/types/stage';
import type { Slide } from '@openmaic/dsl';

/**
 * Build a minimal valid Scene/SlideContent/Slide trio for the round-trip
 * harness. The slide carries a single default text element so each test
 * has a stable target to act on.
 */
export function makeSlideFixture(): {
  scene: Scene;
  content: SlideContent;
  slide: Slide;
  textElementId: string;
} {
  const slide = createDefaultSlide('slide-1');
  const text = createDefaultTextElement('text-1');
  slide.elements.push(text);
  const content: SlideContent = { type: 'slide', canvas: slide };
  const scene: Scene = {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Fixture slide',
    order: 1,
    content,
  };
  return { scene, content, slide, textElementId: text.id };
}

export const VIEWPORT_SIZE = 1000;
export const VIEWPORT_RATIO = 0.5625;
export const RATIO_PX2_INCH = 96 * (VIEWPORT_SIZE / 960);
export const RATIO_PX2_PT = (96 / 72) * (VIEWPORT_SIZE / 960);
