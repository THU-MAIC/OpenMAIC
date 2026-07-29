import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PPTVideoElement } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';
import { BaseVideoElement } from '../../../src/elements/video/BaseVideoElement';

const video = {
  id: 'video-1',
  type: 'video',
  left: 0,
  top: 0,
  width: 160,
  height: 90,
  rotate: 0,
  src: 'video.mp4',
  autoplay: false,
} as PPTVideoElement;

describe('BaseVideoElement', () => {
  it('keeps video content interactive by default', () => {
    const nativeMarkup = renderToStaticMarkup(
      React.createElement(BaseVideoElement, { elementInfo: video }),
    );
    const customMarkup = renderToStaticMarkup(
      React.createElement(BaseVideoElement, {
        elementInfo: video,
        renderVideo: () => React.createElement('button', null, 'Retry'),
      }),
    );

    expect(nativeMarkup).toContain('pointer-events:auto');
    expect(nativeMarkup).toContain('<video');
    expect(customMarkup).toContain('pointer-events:auto');
    expect(customMarkup).toContain('<button>Retry</button>');
  });

  it('disables pointer events when interaction is explicitly disabled', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseVideoElement, {
        elementInfo: video,
        renderVideo: () => React.createElement('button', null, 'Retry'),
        interactive: false,
      }),
    );

    expect(markup).toContain('pointer-events:none');
    expect(markup).toContain('<button>Retry</button>');
  });
});
