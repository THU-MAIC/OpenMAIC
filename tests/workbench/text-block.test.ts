import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
    expect(display).toContain('class="katex"');
    expect(display).toContain(String.raw`>\frac{a}{b}</annotation>`);
    expect(display).not.toContain('$$');
  });

  it.each([
    ['settled', false],
    ['streaming', true],
  ])(
    'treats a standalone same-line $$ formula as display math in a %s message',
    (_state, streaming) => {
      const html = renderText(String.raw`$$\frac{a}{b}$$`, streaming);

      expect(html).toContain('class="katex-display"');
      expect(html).toContain(String.raw`>\frac{a}{b}</annotation>`);
      expect(html).not.toContain('$$');
    },
  );

  it.each([
    ['leading text', String.raw`Result: $$\frac{a}{b}$$`, 'Result:'],
    ['trailing text', String.raw`$$\frac{a}{b}$$ is the result.`, 'is the result.'],
    [
      'a soft line break',
      String.raw`$$\frac{a}{b}$$
Explanation`,
      'Explanation',
    ],
  ])('keeps $$ display semantics next to %s', (_case, text, adjacentText) => {
    const html = renderText(text);

    expect(html).toContain('class="katex-display"');
    expect(html).toContain(String.raw`>\frac{a}{b}</annotation>`);
    expect(html).toContain(adjacentText);
  });

  it('leaves a longer dollar fence as inline math', () => {
    const html = renderText('$$$x$$$');

    expect(html).toContain('class="katex"');
    expect(html).toContain('>x</annotation>');
    expect(html).not.toContain('class="katex-display"');
  });

  it.each(['$$$$x\ny\n$$$', '$$$x\ny\n$$$$'])(
    'preserves a multiline longer dollar run literally: %s',
    (text) => {
      const html = renderText(text);

      expect(html).toContain(`>${text}</p>`);
      expect(html).not.toContain('class="katex"');
    },
  );

  it('keeps Markdown container markers out of display formulas', () => {
    const html = renderText(String.raw`> $$\frac{a}{b}
> more
> $$`);

    expect(html).toContain(String.raw`>\frac{a}{b}
more</annotation>`);
    expect(html).not.toContain(String.raw`>\frac{a}{b}
> more</annotation>`);
  });

  it.each([
    [
      'a closing fence on its own line',
      String.raw`$$\frac{a}{b}
more
$$`,
    ],
    [
      'a closing fence after the last formula line',
      String.raw`$$\frac{a}{b}
more$$`,
    ],
  ])('preserves the first formula line with %s', (_case, text) => {
    const html = renderText(text);

    expect(html).toContain('class="katex-display"');
    expect(html).toContain(String.raw`\frac{a}{b}`);
    expect(html).toContain('more');
  });

  it('renders a visible fallback for an incomplete streaming display formula', () => {
    const incomplete = String.raw`$$
\frac{1}{`;
    const html = renderText(incomplete, true);

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
    const html = renderText(String.raw`Cost is \$5 and budget is \$10; formula: $x^2$.`);

    expect(html).toContain('Cost is $5 and budget is $10; formula:');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-error');
  });

  it('leaves math delimiters inside inline and fenced code untouched', () => {
    const html = renderText(['Inline: `$inline$`', '', '```tex', '$$fenced$$', '```'].join('\n'));

    expect(html).toContain('$inline$');
    expect(html).toContain('$$fenced$$');
    expect(html).not.toContain('class="katex"');
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
