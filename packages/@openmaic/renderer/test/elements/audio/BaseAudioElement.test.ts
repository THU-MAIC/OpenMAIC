import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PPTAudioElement } from '@openmaic/dsl';
import { BaseAudioElement } from '../../../src/elements/audio/BaseAudioElement';

const audio: PPTAudioElement = {
  id: 'audio-1',
  type: 'audio',
  left: 40,
  top: 80,
  width: 240,
  height: 64,
  rotate: 0,
  fixedRatio: true,
  color: '#7c3aed',
  loop: false,
  autoplay: false,
  src: 'https://cdn.example.com/lesson-intro.mp3?version=2',
};

describe('BaseAudioElement', () => {
  it('renders a compact audio card using a source-derived name', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseAudioElement, { elementInfo: audio }),
    );

    expect(markup).toContain('base-element-audio');
    expect(markup).toContain('data-audio-element');
    expect(markup).toContain('lesson-intro.mp3');
    expect(markup).toContain('width:240px');
    expect(markup).toContain('height:64px');
  });

  it('renders a neutral unavailable card for a missing source', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseAudioElement, { elementInfo: { ...audio, src: '' } }),
    );

    expect(markup).toContain('Audio unavailable');
  });
});
