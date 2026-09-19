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
  it('does not add outer padding when rich text already owns frame insets', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseTextElement, {
        elementInfo: {
          ...textElement,
          content: '<div style="padding: 4.8px 9.6px;"><p>Label</p></div>',
        },
      }),
    );
    expect(markup).toContain('box-sizing:border-box;padding:0');
    expect(markup).not.toContain('padding:10px');
  });
  it('keeps default padding for ordinary authored text', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseTextElement, { elementInfo: textElement }),
    );
    expect(markup).toContain('padding:10px');
  });
  it('preserves literal line endings in static text content', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseTextElement, {
        elementInfo: { ...textElement, content: 'First line\nSecond line' },
      }),
    );

    expect(markup).toContain('white-space:pre-line');
  });

  it('does not preserve source-formatting line endings in rich HTML content', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseTextElement, {
        elementInfo: { ...textElement, content: '<p>First line</p>\n<p>Second line</p>' },
      }),
    );

    expect(markup).not.toContain('white-space:pre-line');
  });

  it('does not apply literal-line-ending styling to injected editable content', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseTextElement, {
        elementInfo: textElement,
        renderContent: () => React.createElement('div', { 'data-text-editor': '' }),
      }),
    );

    expect(markup).toContain('data-text-editor=""');
    expect(markup).not.toContain('white-space:pre-line');
  });

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

  it('shares text paint styles with custom editable content', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseTextElement, {
        elementInfo: {
          ...textElement,
          fill: '#ffeeaa',
          opacity: 0.8,
          lineHeight: 1.8,
          paragraphSpace: 6,
          wordSpace: 3,
          vertical: true,
        },
        renderContent: () => React.createElement('div', { 'data-renderer-text-editor': '' }),
      }),
    );

    expect(markup).toContain('background-color:#ffeeaa');
    expect(markup).toContain('line-height:1.8');
    expect(markup).toContain('letter-spacing:3px');
    expect(markup).toContain('writing-mode:vertical-rl');
    expect(markup).toContain('data-renderer-text-editor=""');
    expect(markup).not.toContain('ProseMirror-static');
  });
});

describe('BaseTextElement imported text insets', () => {
  it.each([false, true])(
    'does not add a second inset to imported text (vertical=%s)',
    (vertical) => {
      const markup = renderToStaticMarkup(
        React.createElement(BaseTextElement, {
          elementInfo: {
            ...textElement,
            vertical,
            content: '<div style="padding: 4.8px 9.6px 4.8px 9.6px;"><p>优先级</p></div>',
          },
        }),
      );
      expect(markup).toContain('box-sizing:border-box;padding:0;');
      expect(markup).toContain('padding: 4.8px 9.6px 4.8px 9.6px;');
    },
  );
  it('retains the default inset for manually authored text', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BaseTextElement, { elementInfo: textElement }),
    );
    expect(markup).toContain('padding:10px');
  });
});

it.each([
  '<div data-pptx-text-insets="true"><p>Text</p></div>',
  "<div class='imported' data-pptx-text-insets='true' style='padding:0px'><p>Text</p></div>",
  '<div style="padding-block: 4px" data-pptx-text-insets="true"><p>Text</p></div>',
])('recognizes explicit PPTX insets without relying on padding shorthand: %s', (content) => {
  const markup = renderToStaticMarkup(
    React.createElement(BaseTextElement, { elementInfo: { ...textElement, content } }),
  );
  expect(markup).toContain('box-sizing:border-box;padding:0;');
});

it('does not treat a marker on a nested div as outer text insets', () => {
  const markup = renderToStaticMarkup(
    React.createElement(BaseTextElement, {
      elementInfo: {
        ...textElement,
        content: '<div><div data-pptx-text-insets="true">Text</div></div>',
      },
    }),
  );
  expect(markup).toContain('padding:10px');
});
