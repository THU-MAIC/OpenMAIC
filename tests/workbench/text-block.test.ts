import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { TextBlock } from '@/components/workbench/chat/text-block';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import {
  WorkbenchCourseNavigationProvider,
  type WorkbenchCourseNavigation,
} from '@/lib/workbench/panel-context';

const renderText = (text: string, streaming = false) =>
  renderToStaticMarkup(createElement(TextBlock, { text, streaming }));

const renderI18nText = (text: string) =>
  renderToStaticMarkup(createElement(I18nProvider, null, createElement(TextBlock, { text })));

const renderWorkspaceText = (
  text: string,
  lookupCourse: WorkbenchCourseNavigation['lookupCourse'] = () => null,
) => {
  const providerProps: React.ComponentProps<typeof WorkbenchCourseNavigationProvider> = {
    navigation: {
      activeCourseId: null,
      courseOptions: [],
      lookupCourse,
      openCourse: () => undefined,
    },
    children: createElement(TextBlock, { text }),
  };
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      null,
      createElement(WorkbenchCourseNavigationProvider, providerProps),
    ),
  );
};

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

  it('keeps a rich course label as an anchor outside the workspace', () => {
    const document = parseHTML(renderI18nText('[Solving $x^2$](/classroom/stage-1)')).document;
    const link = document.querySelector('a[href="/classroom/stage-1"]');

    expect(link?.textContent).toContain('Solving');
    expect(link?.querySelector('.katex')).not.toBeNull();
    expect(document.querySelector('[data-testid="workbench-course-link-stage-1"]')).toBeNull();
  });

  it('keeps math in an unresolved workspace course label', () => {
    const html = renderWorkspaceText('[Solving $x^2$](/classroom/stage-1)');
    const document = parseHTML(html).document;
    const link = document.querySelector('[data-testid="workbench-course-link-stage-1"]');

    expect(link?.tagName).toBe('BUTTON');
    expect(link?.textContent).toContain('Solving');
    expect(link?.querySelector('.katex')).not.toBeNull();
    expect(link?.querySelector('annotation')?.textContent).toBe('x^2');
    expect(link?.getAttribute('aria-label')).toBeNull();
    expect(link?.getAttribute('title')).toBeNull();
  });

  it('keeps the workspace course name ahead of a rich link label', () => {
    const html = renderWorkspaceText('[Solving $x^2$](/classroom/stage-1)', () => ({
      id: 'stage-1',
      name: 'Limits course',
      pageCount: 3,
    }));
    const document = parseHTML(html).document;
    const link = document.querySelector('[data-testid="workbench-course-link-stage-1"]');

    expect(link?.textContent).toContain('Limits course');
    expect(link?.querySelector('.katex')).toBeNull();
    expect(link?.getAttribute('aria-label')).toContain('Limits course');
  });

  it('preserves escaped currency next to single-dollar math', () => {
    const html = renderText(String.raw`Cost is \$5 and \$10; formula: $x^2$.`);

    expect(html).toContain('Cost is $5 and $10; formula:');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('katex-error');
  });

  it.each([
    'Plans cost $5 and $10 per month.',
    'Prices: $5 $10.',
    'Prices: $5,$10.',
    'Costs $5 + tax; $10 + tax.',
    'Cost $5/month, or $10/year.',
    'Cost $5/mo or $10/mo.',
    '$5 / item, or $10 / pair',
    'Set $HOME and $PATH before continuing.',
    'echo $A$B',
    'echo $LD_LIBRARY_PATH:$PATH',
    'cd ${HOME}/$PROJECT',
    'echo ${HOME}${PATH}',
    'echo ${HOME}:${PATH}',
    'echo ${FILE_NAME}.${EXT}',
    'echo ${WIDTH}x${HEIGHT}',
    'echo ${file}.${ext}',
    'echo ${FOO:-0}${BAR}',
    'echo $(date)$(whoami)',
    'echo $(pwd)$HOME',
    'echo $(date)${USER}',
    'Use $OPENAI_API_KEY or $ANTHROPIC_API_KEY.',
  ])('preserves ordinary dollar text in settled and streaming messages: %s', (text) => {
    for (const streaming of [false, true]) {
      const document = parseHTML(renderText(text, streaming)).document;

      expect(document.querySelector('.wb-prose')?.textContent).toContain(text);
      expect(document.querySelector('.katex')).toBeNull();
    }
  });

  it.each([
    ['Cost $5; formula $x^2$.', 'x^2'],
    ['Cost $5; formula $X^2$.', 'X^2'],
    ['Cost $5; formula $2x$.', '2x'],
    ['Cost $5; formula $10^2$.', '10^2'],
    ['Cost $5; formula ${x+1}$.', '{x+1}'],
    ['Cost $5; formula $(x+1)$.', '(x+1)'],
    ['Cost $5; formula $_x$.', '_x'],
    ['Cost $5; formula $C^+$.', 'C^+'],
    ['Set $HOME, then solve $x^2$.', 'x^2'],
    ['$5 and $10 $x^2$', 'x^2'],
    ['Prices $5 and $10; fees $2 and $3 $x^2$.', 'x^2'],
    ['Cost $5 $x$', 'x'],
    ['Cost $5,$x$', 'x'],
    ['Cost $5!$x$', 'x'],
  ])('keeps literal dollars from stealing a later formula delimiter: %s', (text, latex) => {
    for (const streaming of [false, true]) {
      const document = parseHTML(renderText(text, streaming)).document;

      expect(document.querySelector('.wb-prose')?.textContent).toContain(
        text.slice(0, text.indexOf(`$${latex}$`)),
      );
      expect(document.querySelectorAll('.katex')).toHaveLength(1);
      expect(document.querySelector('annotation')?.textContent).toBe(latex);
    }
  });

  it('recovers every formula after a literal dollar in the same message', () => {
    const text = 'Cost $5; formula $x^2$. The ratio $a:b$ and $x ≠ 0$ still render as math.';

    for (const streaming of [false, true]) {
      const document = parseHTML(renderText(text, streaming)).document;

      expect(document.querySelector('.wb-prose')?.textContent).toContain('Cost $5; formula');
      expect(
        Array.from(document.querySelectorAll('annotation'), (node) => node.textContent),
      ).toEqual(['x^2', 'a:b', 'x ≠ 0']);
    }
  });

  it('handles many literal dollar pairs before later formulas in one pass', () => {
    const prices = Array.from(
      { length: 400 },
      (_, index) => `$${index + 1} and $${index + 2}`,
    ).join('; ');
    const text = `${prices}; formulas ` + '$2x$, ${x+1}$, and $(x+1)$.';
    const document = parseHTML(renderText(text)).document;

    expect(document.querySelector('.wb-prose')?.textContent).toContain('$1 and $2');
    expect(document.querySelector('.wb-prose')?.textContent).toContain('$400 and $401');
    expect(Array.from(document.querySelectorAll('annotation'), (node) => node.textContent)).toEqual(
      ['2x', '{x+1}', '(x+1)'],
    );
  });

  it('recovers math after currency inside a Markdown link label', () => {
    const document = parseHTML(renderText('[Cost $5; solve $x^2$](https://example.com)')).document;
    const link = document.querySelector('a');

    expect(link?.textContent).toContain('Cost $5; solve');
    expect(link?.querySelector('annotation')?.textContent).toBe('x^2');
  });

  it('restores Markdown structures swallowed by a rejected dollar candidate', () => {
    const url = 'https://example.com/?a=$HOME&b=$PATH';
    const text = `Cost $5; **bold**; \`echo $HOME\`; [docs](${url}); formula $x$.`;
    const document = parseHTML(renderText(text)).document;

    expect(document.querySelector('.wb-prose')?.textContent).toContain('Cost $5');
    expect(document.querySelector('[data-streamdown="strong"]')?.textContent).toBe('bold');
    expect(document.querySelector('code')?.textContent).toBe('echo $HOME');
    expect(document.querySelector('a')?.getAttribute('href')).toBe(url);
    expect(document.querySelector('annotation')?.textContent).toBe('x');
  });

  it.each([
    '$x_i$',
    '$x*y*z$',
    '$α+β$',
    '$x+β$',
    '$-1$',
    '$a,b$',
    '$x, y$',
    '$f(x)$',
    String.raw`$f'(x)$`,
    '$n!$',
    String.raw`$x'$`,
    String.raw`$θ'$`,
    '$θ!$',
    '$x^*$',
    '$C^+$',
    '$-x$',
    '$-2x$',
    '$2xy$',
    '$xyz$',
    '$τ$',
    '$∞$',
    '$x ≠ 0$',
    '$a ± b$',
    '$a:b$',
    '$1:2$',
    '$velocity = distance / time$',
    String.raw`$\frac{a}{b}$`,
    String.raw`$\text{速度}$`,
  ])('preserves valid single-dollar math syntax: %s', (text) => {
    const document = parseHTML(renderText(text)).document;

    expect(document.querySelectorAll('.katex')).toHaveLength(1);
    expect(document.querySelector('annotation')?.textContent).toBe(text.slice(1, -1));
  });

  it.each([
    ['$ x $', 'x'],
    ['$\nx\n$', 'x'],
  ])('preserves micromark math padding semantics: %s', (text, latex) => {
    for (const streaming of [false, true]) {
      const document = parseHTML(renderText(text, streaming)).document;

      expect(document.querySelectorAll('.katex')).toHaveLength(1);
      expect(document.querySelector('annotation')?.textContent).toBe(latex);
    }
  });

  it('keeps adjacent prose after a closed single-dollar formula', () => {
    const document = parseHTML(renderText('the $n$th term')).document;

    expect(document.querySelector('annotation')?.textContent).toBe('n');
    expect(document.querySelector('.wb-prose')?.textContent).toContain('th term');
  });

  it('keeps a parenthesized formula before an adjacent prose suffix', () => {
    const document = parseHTML(renderText('the $(n+1)$th term')).document;

    expect(document.querySelector('annotation')?.textContent).toBe('(n+1)');
    expect(document.querySelector('.wb-prose')?.textContent).toContain('th term');
  });

  it.each([
    [String.raw`\\$x$`, true],
    [String.raw`\\\$x$`, false],
  ])('respects Markdown escape parity: %s', (text, rendersMath) => {
    const document = parseHTML(renderText(text)).document;

    expect(document.querySelector('.katex') !== null).toBe(rendersMath);
  });

  it('does not treat a backslash before the second dollar as an escaped math closer', () => {
    const text = String.raw`$5 and \$10`;

    for (const streaming of [false, true]) {
      const document = parseHTML(renderText(text, streaming)).document;

      expect(document.querySelector('.wb-prose')?.textContent).toContain('$5 and $10');
      expect(document.querySelector('.katex')).toBeNull();
    }
  });

  it('keeps dollar-prefixed query values inside a GFM autolink', () => {
    const url = 'https://example.com/?a=$HOME&b=$PATH';
    const document = parseHTML(renderText(url)).document;
    const link = document.querySelector('a');

    expect(link?.getAttribute('href')).toBe(url);
    expect(link?.textContent).toBe(url);
  });

  it('does not add an escape inside incomplete inline code while streaming', () => {
    const document = parseHTML(renderText('Use `$5 and $10', true)).document;

    expect(document.querySelector('code')?.textContent).toBe('$5 and $10');
  });

  it('keeps delimiter offsets aligned when a message starts with a byte-order mark', () => {
    const document = parseHTML(renderText('\uFEFFCost $5; formula $x^2$.')).document;

    expect(document.querySelector('.wb-prose')?.textContent).toContain('Cost $5; formula');
    expect(document.querySelectorAll('.katex')).toHaveLength(1);
    expect(document.querySelector('annotation')?.textContent).toBe('x^2');
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

  it('keeps currency literal and math rendered across GFM table cells', () => {
    const document = parseHTML(
      renderText(`| Price | Formula |
| --- | --- |
| $5 | $x$ |`),
    ).document;

    expect(document.querySelector('tbody')?.textContent).toContain('$5');
    expect(document.querySelectorAll('tbody .katex')).toHaveLength(1);
    expect(document.querySelector('tbody annotation')?.textContent).toBe('x');
  });
});
