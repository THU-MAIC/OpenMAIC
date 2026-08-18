import { describe, expect, it } from 'vitest';
import { slideMediaSlotDescriptors, type Slide } from '@openmaic/dsl';
import { slideMediaReferenceSlots } from '@/lib/media/slide-media-slots';

describe('slide media slot parity', () => {
  it('keeps the app walker aligned with the canonical DSL role descriptors', () => {
    const slide = {
      id: 'roles',
      background: { type: 'image', image: { src: 'background' } },
      elements: [
        { id: 'image', type: 'image', src: 'image' },
        {
          id: 'video',
          type: 'video',
          src: 'video-src',
          mediaRef: 'video-ref',
          poster: 'video-poster',
        },
        { id: 'audio', type: 'audio', src: 'audio' },
      ],
    } as unknown as Slide;

    const canonical = [...slideMediaSlotDescriptors(slide)].map(({ kind, elementIndex, ref }) => ({
      kind,
      elementIndex,
      ref,
    }));
    const app = [...slideMediaReferenceSlots(slide)].map(({ kind, elementIndex, read }) => ({
      kind,
      elementIndex,
      ref: read(),
    }));

    expect(app).toEqual(canonical);
    expect(canonical).toEqual([
      { kind: 'background-image', elementIndex: undefined, ref: 'background' },
      { kind: 'image-src', elementIndex: 0, ref: 'image' },
      { kind: 'video-src', elementIndex: 1, ref: 'video-src' },
      { kind: 'video-media-ref', elementIndex: 1, ref: 'video-ref' },
      { kind: 'video-poster', elementIndex: 1, ref: 'video-poster' },
      { kind: 'audio-src', elementIndex: 2, ref: 'audio' },
    ]);
  });
});
