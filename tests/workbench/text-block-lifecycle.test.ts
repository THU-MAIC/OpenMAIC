// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { TextBlock } from '@/components/workbench/chat/text-block';

const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function mountText(text: string, streaming: boolean) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(TextBlock, { text, streaming })));
  return { host, root };
}

describe('Workbench assistant Markdown lifecycle', () => {
  it.each([
    ['identifier', '$$x', ['x']],
    ['invalid formula', String.raw`$$\frac{1}{`, [String.raw`\frac{1}{`]],
    ['multiline formula', '$$x\ny', ['x', 'y']],
    ['longer dollar run', '$$$x', ['$$$x']],
  ])(
    'keeps an incomplete %s visible when streaming ends without new text',
    (_case, text, visibleText) => {
      const live = mountText(text, true);

      act(() => live.root.render(createElement(TextBlock, { text, streaming: false })));
      const replay = mountText(text, false);

      for (const fragment of visibleText) expect(live.host.textContent).toContain(fragment);
      expect(live.host.innerHTML).toBe(replay.host.innerHTML);
    },
  );

  it('keeps the first line visible while a display formula streams across lines', () => {
    const live = mountText('$$x', true);
    expect(live.host.textContent).toContain('x');

    act(() => live.root.render(createElement(TextBlock, { text: '$$x\n', streaming: true })));
    expect(live.host.textContent).toContain('x');

    const complete = '$$x\nmore\n$$';
    act(() => live.root.render(createElement(TextBlock, { text: complete, streaming: true })));
    expect(live.host.textContent).toContain('x');
    expect(live.host.textContent).toContain('more');

    act(() => live.root.render(createElement(TextBlock, { text: complete, streaming: false })));
    const replay = mountText(complete, false);
    expect(live.host.innerHTML).toBe(replay.host.innerHTML);
  });

  it('keeps a longer dollar run visible while it streams across lines', () => {
    const live = mountText('$$$x', true);
    expect(live.host.textContent).toContain('x');

    act(() => live.root.render(createElement(TextBlock, { text: '$$$x\n', streaming: true })));
    expect(live.host.textContent).toContain('x');

    const incomplete = '$$$x\ny';
    act(() => live.root.render(createElement(TextBlock, { text: incomplete, streaming: true })));
    expect(live.host.textContent).toContain('x');
    expect(live.host.textContent).toContain('y');

    act(() => live.root.render(createElement(TextBlock, { text: incomplete, streaming: false })));
    const replay = mountText(incomplete, false);
    expect(live.host.innerHTML).toBe(replay.host.innerHTML);
  });

  it.each([
    ['a list', '- $$x\n  y'],
    ['a blockquote', '> $$x\n> y'],
  ])('does not add an empty formula to an unfinished display inside %s', (_case, text) => {
    const live = mountText(text, true);
    expect(live.host.querySelectorAll('.katex-display')).toHaveLength(1);

    act(() => live.root.render(createElement(TextBlock, { text, streaming: false })));
    const replay = mountText(text, false);

    expect(live.host.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(live.host.innerHTML).toBe(replay.host.innerHTML);
  });
});
