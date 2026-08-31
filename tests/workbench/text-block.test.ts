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
    expect(inline).not.toContain('$x^2$');
    expect(display).toContain('class="katex-display"');
    expect(display).toContain('class="katex"');
    expect(display).not.toContain('$$');
  });

  it('does not throw on an incomplete streaming display formula', () => {
    const incomplete = String.raw`$$
\frac{1}{`;

    expect(() => renderText(incomplete, true)).not.toThrow();
  });

  it('preserves the existing CJK, emphasis, and ordinary-link pipeline', () => {
    const html = renderText('你好，**重点**；[指南](/docs)。');

    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain('href="/docs"');
    expect(html).toContain('指南');
  });
});
