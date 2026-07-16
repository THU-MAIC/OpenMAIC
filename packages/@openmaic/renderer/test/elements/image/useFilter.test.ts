import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PPTImageElement } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';

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
});
