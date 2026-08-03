import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PPTImageElement } from '@openmaic/dsl';
import { describe, expect, it, vi } from 'vitest';

import { BaseImageElement } from '../../../src/elements/image/BaseImageElement';
import { imageFiltersToCss } from '../../../src/elements/image/useFilter';

describe('imageFiltersToCss', () => {
  it('appends units to canonical unitless filter values', () => {
    expect(
      imageFiltersToCss({
        blur: '2',
        brightness: '120',
        'hue-rotate': '15',
      }),
    ).toBe('blur(2px) brightness(120%) hue-rotate(15deg)');
  });

  it('does not duplicate units preserved from legacy filter values', () => {
    expect(
      imageFiltersToCss({
        blur: '2px',
        contrast: '90%',
        brightness: '120%',
        'hue-rotate': '15deg',
      }),
    ).toBe('blur(2px) contrast(90%) brightness(120%) hue-rotate(15deg)');
  });

  it('renders legacy filter units safely through the package image element', () => {
    const image = {
      id: 'image-1',
      type: 'image',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      fixedRatio: true,
      src: 'data:image/png;base64,AA==',
      filters: { blur: '2px', contrast: '90%' },
    } as PPTImageElement;

    const markup = renderToStaticMarkup(
      React.createElement(BaseImageElement, { elementInfo: image }),
    );

    expect(markup).toContain('filter:blur(2px) contrast(90%)');
    expect(markup).not.toContain('pxpx');
    expect(markup).not.toContain('%%');
  });

  it('keeps a custom renderImage null result authoritative', () => {
    const image = {
      id: 'image-1',
      type: 'image',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      fixedRatio: true,
      src: 'data:image/png;base64,AA==',
    } as PPTImageElement;

    const markup = renderToStaticMarkup(
      React.createElement(BaseImageElement, {
        elementInfo: image,
        renderImage: () => null,
      }),
    );

    expect(markup).not.toContain('<img');
  });

  it('provides the default image content to custom renderers', () => {
    const image = {
      id: 'image-1',
      type: 'image',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      fixedRatio: true,
      src: 'blob:generated-image',
      colorMask: '#ff0000',
    } as PPTImageElement;
    const renderImage = vi.fn(
      (_element: PPTImageElement, _src: string, defaultContent?: React.ReactNode) =>
        React.createElement('div', { 'data-custom-image': true }, defaultContent),
    );

    const markup = renderToStaticMarkup(
      React.createElement(BaseImageElement, { elementInfo: image, renderImage }),
    );

    expect(renderImage.mock.calls[0]?.[2]).toBeTruthy();
    expect(markup).toContain('data-custom-image="true"');
    expect(markup).toContain('src="blob:generated-image"');
    expect(markup).toContain('background-color:#ff0000');
  });

  it('keeps custom image controls pointer-interactive', () => {
    const image = {
      id: 'image-1',
      type: 'image',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      rotate: 0,
      fixedRatio: true,
      src: 'gen_img_1',
    } as PPTImageElement;

    const markup = renderToStaticMarkup(
      React.createElement(BaseImageElement, {
        elementInfo: image,
        renderImage: () => React.createElement('button', null, 'Retry'),
      }),
    );

    expect(markup).toContain('pointer-events:auto');
    expect(markup).toContain('<button>Retry</button>');
  });
});
