import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PPTVideoElement, Slide } from '@openmaic/dsl';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

function slideWithVideo(video: Partial<PPTVideoElement>): Slide {
  return {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#fff' },
    elements: [
      {
        id: 'video-1',
        type: 'video',
        src: 'blob:http://localhost/video',
        left: 0,
        top: 0,
        width: 1000,
        height: 562.5,
        rotate: 0,
        autoplay: false,
        ...video,
      } as PPTVideoElement,
    ],
  } as Slide;
}

function render(slide: Slide): string {
  return renderToStaticMarkup(createElement(SlideThumbnail, { slide, viewportRatio: 0.5625 }));
}

describe('SlideThumbnail video', () => {
  it('draws a video that has a poster as the poster, with no media element to load it', () => {
    // A <video> reads its source whatever its preload says (for an object URL
    // in Chromium), and drops the rest of the read once it has a frame: the
    // browser records that as an aborted request per thumbnail per page load.
    const markup = render(slideWithVideo({ poster: 'blob:http://localhost/poster' }));

    expect(markup).not.toContain('<video');
    expect(markup).not.toContain('blob:http://localhost/video');
    expect(markup).toMatch(/<img[^>]*src="blob:http:\/\/localhost\/poster"/);
    expect(markup).toContain('data-testid="thumbnail-video-indicator"');
  });

  it('falls back to the video for its opening frame when there is no poster', () => {
    const markup = render(slideWithVideo({}));

    expect(markup).toMatch(
      /<video[^>]*src="blob:http:\/\/localhost\/video"[^>]*preload="metadata"/,
    );
    expect(markup).not.toContain('<img');
  });
});
