import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PPTTextElement } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';
import { BaseTextElement } from '../../../src/elements/text/BaseTextElement';

const textElement: PPTTextElement = {
  id: 'text-1',
  type: 'text',
  left: 0,
  top: 0,
  width: 200,
  height: 60,
  rotate: 0,
  content: '<p>Centered by default</p>',
  defaultFontName: 'Microsoft YaHei',
  defaultColor: '#333333',
};

describe('BaseTextElement', () => {
  it('top-aligns text when vAlign is omitted', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseTextElement, { elementInfo: textElement }),
    );

    expect(markup).toContain('justify-content:flex-start');
  });

  it.each([
    ['top', 'flex-start'],
    ['middle', 'center'],
    ['bottom', 'flex-end'],
  ] as const)('maps explicit %s alignment to %s', (vAlign, justifyContent) => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseTextElement, {
        elementInfo: { ...textElement, vAlign },
      }),
    );

    expect(markup).toContain(`justify-content:${justifyContent}`);
  });
});
