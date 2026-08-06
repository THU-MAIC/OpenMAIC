import type { PPTImageElement, PPTVideoElement, Slide } from '@openmaic/dsl';

export type SlideMediaReferenceKind =
  | 'background-image'
  | 'image-src'
  | 'video-src'
  | 'video-media-ref'
  | 'video-poster';

export interface SlideMediaReferenceSlot {
  readonly kind: SlideMediaReferenceKind;
  readonly element?: PPTImageElement | PPTVideoElement;
  readonly elementIndex?: number;
  readonly read: () => string | undefined;
  readonly write: (value: string | undefined) => void;
}

/**
 * Yield every mutable media-reference location owned by one slide.
 *
 * Callers must invoke this for ordinary canvases and for stage/scene whiteboard
 * slides. Optional video slots are yielded even when empty so resolvers can use
 * one traversal contract for src, mediaRef, and poster lifecycle work.
 */
export function* slideMediaReferenceSlots(
  slide: Pick<Slide, 'background' | 'elements'>,
): Generator<SlideMediaReferenceSlot> {
  const background = slide.background?.type === 'image' ? slide.background.image : undefined;
  if (background) {
    yield {
      kind: 'background-image',
      read: () => background.src,
      write: (value) => {
        background.src = value ?? '';
      },
    };
  }

  for (let elementIndex = 0; elementIndex < slide.elements.length; elementIndex += 1) {
    const element = slide.elements[elementIndex];
    if (element.type === 'image') {
      yield elementSlot('image-src', element, elementIndex, 'src');
      continue;
    }
    if (element.type !== 'video') continue;
    yield elementSlot('video-src', element, elementIndex, 'src');
    yield elementSlot('video-media-ref', element, elementIndex, 'mediaRef');
    yield elementSlot('video-poster', element, elementIndex, 'poster');
  }
}

function elementSlot<
  T extends PPTImageElement | PPTVideoElement,
  K extends Extract<keyof T, 'src' | 'mediaRef' | 'poster'>,
>(
  kind: SlideMediaReferenceKind,
  element: T,
  elementIndex: number,
  key: K,
): SlideMediaReferenceSlot {
  return {
    kind,
    element,
    elementIndex,
    read: () => element[key] as string | undefined,
    write: (value) => {
      if (value === undefined && key !== 'src') delete element[key];
      else element[key] = (value ?? '') as T[K];
    },
  };
}
