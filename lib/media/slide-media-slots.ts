import {
  slideMediaSlotDescriptors,
  type PPTAudioElement,
  type PPTImageElement,
  type PPTVideoElement,
  type Slide,
  type SlideMediaSlotKind,
  type SlideMediaSlotProperty,
} from '@openmaic/dsl';

export type SlideMediaReferenceKind = SlideMediaSlotKind;

export interface SlideMediaReferenceSlot {
  readonly kind: SlideMediaReferenceKind;
  readonly element?: PPTImageElement | PPTVideoElement | PPTAudioElement;
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
  for (const descriptor of slideMediaSlotDescriptors(slide)) {
    if (descriptor.elementIndex === undefined) {
      const background = slide.background?.type === 'image' ? slide.background.image : undefined;
      if (!background) continue;
      yield {
        kind: descriptor.kind,
        read: () => background.src,
        write: (value) => {
          background.src = value ?? '';
        },
      };
      continue;
    }
    const element = slide.elements[descriptor.elementIndex];
    yield elementSlot(
      descriptor.kind,
      element as PPTImageElement | PPTVideoElement | PPTAudioElement,
      descriptor.elementIndex,
      descriptor.property,
    );
  }
}

function elementSlot(
  kind: SlideMediaReferenceKind,
  element: PPTImageElement | PPTVideoElement | PPTAudioElement,
  elementIndex: number,
  key: SlideMediaSlotProperty,
): SlideMediaReferenceSlot {
  const mediaProperties = element as unknown as Partial<Record<SlideMediaSlotProperty, string>>;
  return {
    kind,
    element,
    elementIndex,
    read: () => mediaProperties[key],
    write: (value) => {
      if (value === undefined && key !== 'src') delete mediaProperties[key];
      else mediaProperties[key] = value ?? '';
    },
  };
}
