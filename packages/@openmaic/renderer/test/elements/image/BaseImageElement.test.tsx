import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PPTImageElement } from '@openmaic/dsl';
import { BaseImageElement } from '../../../src/elements/image/BaseImageElement';

const imageElement: PPTImageElement = {
  id: 'image-1',
  type: 'image',
  src: 'https://example.com/pic.png',
  left: 10,
  top: 20,
  width: 200,
  height: 120,
  rotate: 0,
  fixedRatio: true,
};

describe('BaseImageElement', () => {
  it('renders the image with lazy loading and async decoding', () => {
    const html = renderToStaticMarkup(
      createElement(BaseImageElement, { elementInfo: imageElement }),
    );
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });
});
