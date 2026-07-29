import { describe, expect, it } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import type { MediaTask } from '@/lib/store/media-generation';
import { resolveSlideMedia } from '@/components/slide-renderer/use-resolved-slide';

const slide: Slide = {
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
      id: 'video-1',
      type: 'video',
      left: 0,
      top: 0,
      width: 100,
      height: 56,
      rotate: 0,
      src: 'gen_vid_1',
      autoplay: false,
    },
  ],
};

function task(overrides: Partial<MediaTask>): MediaTask {
  return {
    elementId: 'gen_vid_1',
    type: 'video',
    status: 'pending',
    prompt: '',
    params: {},
    retryCount: 0,
    stageId: 'stage-1',
    ...overrides,
  };
}

describe('resolveSlideMedia', () => {
  it('can preserve unresolved generated image placeholders for a custom status renderer', () => {
    const imageSlide: Slide = {
      ...slide,
      elements: [
        {
          id: 'image-1',
          type: 'image',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
          rotate: 0,
          fixedRatio: true,
          src: 'gen_img_1',
        },
      ],
    };

    const resolved = resolveSlideMedia(
      imageSlide,
      'stage-1',
      {
        gen_img_1: {
          ...task({ elementId: 'gen_img_1', type: 'image', status: 'pending' }),
        },
      },
      { preserveUnresolvedImagePlaceholders: true },
    );

    expect(resolved.elements[0]).toMatchObject({
      type: 'image',
      src: 'gen_img_1',
    });
  });

  it('keeps mediaRef when blanking unresolved generated video placeholders', () => {
    const resolved = resolveSlideMedia(slide, 'stage-1', {
      gen_vid_1: task({ status: 'pending' }),
    });

    expect(resolved.elements[0]).toMatchObject({
      type: 'video',
      src: '',
      mediaRef: 'gen_vid_1',
    });
  });

  it('replaces generated video placeholders with done object URLs and posters', () => {
    const resolved = resolveSlideMedia(slide, 'stage-1', {
      gen_vid_1: task({ status: 'done', objectUrl: 'blob:video', poster: 'blob:poster' }),
    });

    expect(resolved.elements[0]).toMatchObject({
      type: 'video',
      src: 'blob:video',
      poster: 'blob:poster',
    });
  });
});
