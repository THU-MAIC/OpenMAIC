import type { Slide } from './slides.js';

/** Every media-bearing property the slide DSL assigns a semantic role. */
export type SlideMediaSlotKind =
  | 'background-image'
  | 'image-src'
  | 'audio-src'
  | 'video-src'
  | 'video-media-ref'
  | 'video-poster';

export type SlideMediaSlotProperty = 'src' | 'mediaRef' | 'poster';

/**
 * A read-only description of one media slot in a slide.
 *
 * `elementIndex` is absent only for the image background. Optional properties
 * are described even when empty so consumers that write slots and consumers
 * that only enumerate populated refs share exactly the same role definition.
 */
export interface SlideMediaSlotDescriptor {
  readonly kind: SlideMediaSlotKind;
  readonly elementIndex?: number;
  readonly property: SlideMediaSlotProperty;
  readonly ref: string | undefined;
}

/** Yield the canonical media-slot classification for one slide. */
export function* slideMediaSlotDescriptors(
  slide: Pick<Slide, 'background' | 'elements'>,
): Generator<SlideMediaSlotDescriptor> {
  const background = slide.background?.type === 'image' ? slide.background.image : undefined;
  if (background) {
    yield { kind: 'background-image', property: 'src', ref: background.src };
  }

  for (let elementIndex = 0; elementIndex < slide.elements.length; elementIndex += 1) {
    const element = slide.elements[elementIndex];
    if (element.type === 'image') {
      yield { kind: 'image-src', elementIndex, property: 'src', ref: element.src };
      continue;
    }
    if (element.type === 'audio') {
      yield { kind: 'audio-src', elementIndex, property: 'src', ref: element.src };
      continue;
    }
    if (element.type !== 'video') continue;
    yield { kind: 'video-src', elementIndex, property: 'src', ref: element.src };
    yield {
      kind: 'video-media-ref',
      elementIndex,
      property: 'mediaRef',
      ref: element.mediaRef,
    };
    yield { kind: 'video-poster', elementIndex, property: 'poster', ref: element.poster };
  }
}
