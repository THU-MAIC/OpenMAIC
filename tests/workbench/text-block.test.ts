import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { TextBlock } from '@/components/workbench/chat/text-block';

const renderText = (text: string, streaming = false) =>
  renderToStaticMarkup(createElement(TextBlock, { text, streaming }));

describe('Workbench assistant Markdown', () => {
  it.each([
    ['settled', false],
    ['streaming', true],
  ])('renders inline and display math in a %s message', (_state, streaming) => {
    const inline = renderText('Inline: $x^2$', streaming);
    const display = renderText(
      String.raw`$$
\frac{a}{b}
$$`,
      streaming,
    );

    expect(inline).toContain('class="katex"');
    expect(inline).toContain('>x^2</annotation>');
    expect(inline).not.toContain('$x^2$');
    expect(display).toContain('class="katex-display"');
    expect(display).toContain(String.raw`>\frac{a}{b}</annotation>`);
    expect(display).not.toContain('$$');
  });

  it('renders same-line double-dollar input without exposing its delimiters', () => {
    const html = renderText(String.raw`$$\frac{a}{b}$$`);

    expect(html).toContain('class="katex"');
    expect(html).toContain(String.raw`>\frac{a}{b}</annotation>`);
    expect(html).not.toContain('$$');
  });

  it.each([
    [
      'a list',
      String.raw`- $$
  x + y
  $$`,
      'li',
    ],
    [
      'a blockquote',
      String.raw`> $$
> x + y
> $$`,
      'blockquote',
    ],
  ])('renders display math inside %s', (_case, text, container) => {
    const document = parseHTML(renderText(text, true)).document;

    expect(document.querySelector(`${container} .katex-display`)).not.toBeNull();
    expect(document.querySelector('annotation')?.textContent).toBe('x + y');
  });

  it('renders a visible fallback for an incomplete streaming display formula', () => {
    const html = renderText(
      String.raw`$$
\frac{1}{`,
      true,
    );

    expect(html).toContain('class="katex-error"');
    expect(html).toContain(String.raw`\frac{1}{`);
    expect(html).not.toContain('$$');
  });

  it('preserves the existing CJK, emphasis, and ordinary-link pipeline', () => {
    const html = renderText('你好，**重点**；[指南](/docs)。');

    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain('重点');
    expect(html).toContain('href="/docs"');
    expect(html).toContain('指南');
  });

  it('preserves escaped currency next to single-dollar math', () => {
    const html = renderText(String.raw`Cost is \$5 and \$10; formula: $x^2$.`);

    expect(html).toContain('Cost is $5 and $10; formula:');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-error');
  });

  it('leaves math delimiters inside inline and fenced code untouched', () => {
    const html = renderText(['Inline: `$inline$`', '', '```tex', '$$fenced$$', '```'].join('\n'));

    expect(html).toContain('$inline$');
    expect(html).toContain('$$fenced$$');
    expect(html).not.toContain('class="katex"');
  });

  it.each([
    ['an unfinished fence', ['```tex', '$$x'].join('\n')],
    ['a closed fence', ['```tex', '$$x', '```'].join('\n')],
  ])('does not complete math inside %s while streaming', (_case, text) => {
    const streaming = parseHTML(renderText(text, true)).document;
    const settled = parseHTML(renderText(text)).document;

    expect(streaming.querySelector('code')?.textContent).toBe('$$x');
    expect(settled.querySelector('code')?.textContent).toBe('$$x');
    expect(streaming.querySelector('.katex')).toBeNull();
    expect(settled.querySelector('.katex')).toBeNull();
  });

  it('preserves the default GFM table pipeline', () => {
    const html = renderText(`| A | B |
| --- | --- |
| 1 | 2 |`);

    expect(html).toContain('data-streamdown="table"');
    expect(html).toContain('data-streamdown="table-header-cell"');
    expect(html).toContain('data-streamdown="table-cell"');
    expect(html).toContain('>A</th>');
    expect(html).toContain('>2</td>');
  });
});
