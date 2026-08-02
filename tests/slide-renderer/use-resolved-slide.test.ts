import { describe, expect, it } from 'vitest';
import type { PPTVideoElement, Slide } from '@openmaic/dsl';
import type { MediaTask } from '@/lib/store/media-generation';
import {
  resolveSlideMedia,
  resolveSlideMediaState,
} from '@/components/slide-renderer/use-resolved-slide';

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
  it('clears an unresolved generated image while status metadata stays separate', () => {
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

    const resolved = resolveSlideMedia(imageSlide, 'stage-1', {
      gen_img_1: {
        ...task({ elementId: 'gen_img_1', type: 'image', status: 'pending' }),
      },
    });

    expect(resolved.elements[0]).toMatchObject({
      type: 'image',
      src: '',
    });
  });

  it('does not hand a pending generated video source to the DOM', () => {
    const resolved = resolveSlideMedia(slide, 'stage-1', {
      gen_vid_1: task({ status: 'pending' }),
    });

    expect(resolved.elements[0]).toMatchObject({
      type: 'video',
      src: '',
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

  it('uses the shared lease once it settles after a task completes', () => {
    const resolved = resolveSlideMedia(
      slide,
      'stage-1',
      {
        gen_vid_1: task({ status: 'done', objectUrl: 'blob:task-video' }),
      },
      { assetUrls: { gen_vid_1: 'blob:pool-video' } },
    );

    expect(resolved.elements[0]).toMatchObject({ src: 'blob:pool-video' });
  });

  it('keeps a pending task hidden even when stale pool bytes exist', () => {
    const baseVideo = slide.elements[0] as PPTVideoElement;
    const withPoster: Slide = {
      ...slide,
      elements: [{ ...baseVideo, poster: 'ast_poster_ref' }],
    };
    const resolved = resolveSlideMedia(
      withPoster,
      'stage-1',
      { gen_vid_1: task({ status: 'pending', objectUrl: undefined }) },
      {
        assetUrls: {
          gen_vid_1: 'blob:pool-video',
          ast_poster_ref: 'blob:pool-poster',
        },
      },
    );

    expect(resolved.elements[0]).toMatchObject({
      src: '',
      poster: 'blob:pool-poster',
    });
  });

  it('shows last-good pool bytes after a failed regeneration', () => {
    const resolved = resolveSlideMedia(
      slide,
      'stage-1',
      { gen_vid_1: task({ status: 'failed', objectUrl: undefined }) },
      { assetUrls: { gen_vid_1: 'blob:pool-video' } },
    );

    expect(resolved.elements[0]).toMatchObject({ src: 'blob:pool-video' });
  });

  it('uses a pool URL when an allocated ref has no task after reload', () => {
    const baseVideo = slide.elements[0] as PPTVideoElement;
    const allocatedSlide: Slide = {
      ...slide,
      elements: [
        {
          ...baseVideo,
          src: 'ast_video_ref',
          mediaRef: 'ast_video_ref',
          poster: 'ast_poster_ref',
        },
      ],
    };

    const resolved = resolveSlideMedia(
      allocatedSlide,
      'stage-1',
      {},
      {
        assetUrls: {
          ast_video_ref: 'blob:pool-video',
          ast_poster_ref: 'blob:pool-poster',
        },
      },
    );

    expect(resolved.elements[0]).toMatchObject({
      src: 'blob:pool-video',
      poster: 'blob:pool-poster',
    });
  });

  it('resolves an allocated background through the same lease boundary', () => {
    const backgroundSlide: Slide = {
      ...slide,
      background: { type: 'image', image: { src: 'ast_background', size: 'cover' } },
    };

    const resolved = resolveSlideMediaState(
      backgroundSlide,
      'stage-1',
      {},
      {
        assetUrls: { ast_background: 'blob:pool-background' },
      },
    );

    expect(resolved.slide.background).toEqual({
      type: 'image',
      image: { src: 'blob:pool-background', size: 'cover' },
    });
    expect(resolved.backgroundResolution).toEqual({
      kind: 'url',
      url: 'blob:pool-background',
    });
  });

  it('resolves an allocated poster even when the video source is already a direct URL', () => {
    const baseVideo = slide.elements[0] as PPTVideoElement;
    const directVideo: Slide = {
      ...slide,
      elements: [
        {
          ...baseVideo,
          src: 'https://example.test/video.mp4',
          poster: 'ast_poster_ref',
        },
      ],
    };

    const resolved = resolveSlideMedia(
      directVideo,
      'stage-1',
      {},
      {
        assetUrls: { ast_poster_ref: 'blob:pool-poster' },
      },
    );
    expect(resolved.elements[0]).toMatchObject({
      src: 'https://example.test/video.mp4',
      poster: 'blob:pool-poster',
    });
  });

  it('preserves a hydrated video URL when an opaque mediaRef has no stage context', () => {
    const baseVideo = slide.elements[0] as PPTVideoElement;
    const hydratedSlide: Slide = {
      ...slide,
      elements: [
        {
          ...baseVideo,
          src: 'blob:thumbnail-video',
          mediaRef: 'gen_vid_1',
        },
      ],
    };

    const resolved = resolveSlideMediaState(hydratedSlide, undefined, {});

    expect(resolved.slide.elements[0]).toMatchObject({
      src: 'blob:thumbnail-video',
      mediaRef: 'gen_vid_1',
    });
    expect(resolved.byElementId['video-1']).toMatchObject({
      ref: 'gen_vid_1',
      resolution: { kind: 'raw', value: 'blob:thumbnail-video' },
    });
  });

  it('hides an allocated ref when pool resolution misses', () => {
    const baseVideo = slide.elements[0] as PPTVideoElement;
    const allocatedSlide: Slide = {
      ...slide,
      elements: [
        {
          ...baseVideo,
          src: 'ast_missing_ref',
          mediaRef: 'ast_missing_ref',
        },
      ],
    };

    const resolved = resolveSlideMedia(allocatedSlide, 'stage-1', {}, { assetUrls: {} });
    expect(resolved.elements[0]).toMatchObject({
      src: '',
      mediaRef: 'ast_missing_ref',
    });
  });

  it('reports disabled instead of pending when generation is off', () => {
    const resolved = resolveSlideMediaState(
      slide,
      'stage-1',
      {},
      {
        videoGenerationDisabled: true,
      },
    );

    expect(resolved.slide.elements[0]).toMatchObject({ src: '' });
    expect(resolved.byElementId['video-1'].resolution).toEqual({ kind: 'disabled' });
  });

  it('keeps a bare relative source when task and pool lookup both miss', () => {
    const baseVideo = slide.elements[0] as PPTVideoElement;
    const unknownSlide: Slide = {
      ...slide,
      elements: [{ ...baseVideo, src: 'logo.mp4' }],
    };

    const resolved = resolveSlideMedia(unknownSlide, 'stage-1', {}, { assetUrls: {} });
    expect(resolved.elements[0]).toMatchObject({ src: 'logo.mp4' });
  });
});
