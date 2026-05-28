import { nanoid } from 'nanoid';
import type { Slide, SlideTheme, PPTElement } from '@/lib/types/slides';
import type { Scene, SlideContent } from '@/lib/types/stage';
import { createElementId } from '@/lib/edit/element-id';
import { CURRENT_SLIDE_CONTENT_SCHEMA_VERSION } from '@/lib/edit/slide-schema';

const DEFAULT_THEME: SlideTheme = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
  outline: { color: '#d14424', width: 2, style: 'solid' },
  shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
};

/**
 * Build a fresh blank slide scene for `+ Add slide` in the Pro mode rail.
 * Matches the SceneBuilder default theme so user-added slides look the
 * same as AI-generated ones until customized.
 */
export function createBlankSlideScene(stageId: string, title: string, order: number): Scene {
  const slide: Slide = {
    id: nanoid(),
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: DEFAULT_THEME,
    elements: [],
    background: { type: 'solid', color: '#ffffff' },
  };

  const content: SlideContent = {
    type: 'slide',
    schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    canvas: slide,
  };

  return {
    id: nanoid(),
    stageId,
    type: 'slide',
    title,
    order,
    content,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Build a duplicate of an existing slide scene. Deep-clones the slide
 * payload and reassigns every element id so React keys + downstream
 * selection state can't collide with the source slide. The new scene
 * gets a fresh scene id; caller is responsible for placing it in the
 * scenes array (via `insertSceneAfter`).
 */
export function duplicateSlideScene(source: Scene, copySuffix: string, order: number): Scene {
  if (source.type !== 'slide') {
    throw new Error('duplicateSlideScene: source scene is not a slide');
  }
  const sourceContent = source.content as SlideContent;
  const clonedElements: PPTElement[] = sourceContent.canvas.elements.map((element) => ({
    ...element,
    id: createElementId(element.type),
  }));

  const clonedSlide: Slide = {
    ...sourceContent.canvas,
    id: nanoid(),
    elements: clonedElements,
  };

  const content: SlideContent = {
    ...sourceContent,
    schemaVersion: CURRENT_SLIDE_CONTENT_SCHEMA_VERSION,
    canvas: clonedSlide,
  };

  const title = copySuffix ? `${source.title} ${copySuffix}` : source.title;

  return {
    ...source,
    id: nanoid(),
    title,
    order,
    content,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
