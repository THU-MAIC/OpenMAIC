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
  it('renders a display formula as its standard flow fence streams in', () => {
    const live = mountText('$$\n', true);

    act(() => live.root.render(createElement(TextBlock, { text: '$$\nx', streaming: true })));
    expect(live.host.querySelector('.katex-display')).not.toBeNull();
    expect(live.host.querySelector('annotation')?.textContent).toBe('x');

    const complete = '$$\nx + y\n$$';
    act(() => live.root.render(createElement(TextBlock, { text: complete, streaming: true })));
    expect(live.host.querySelector('annotation')?.textContent).toBe('x + y');

    act(() => live.root.render(createElement(TextBlock, { text: complete, streaming: false })));
    const replay = mountText(complete, false);
    expect(live.host.innerHTML).toBe(replay.host.innerHTML);
  });

  it.each([
    ['complete', '$$\nx\n$$'],
    ['unfinished', '$$\nx'],
  ])('settles a %s display formula without changing its rendered result', (_case, text) => {
    const live = mountText(text, true);

    act(() => live.root.render(createElement(TextBlock, { text, streaming: false })));
    const replay = mountText(text, false);

    expect(live.host.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(live.host.innerHTML).toBe(replay.host.innerHTML);
  });
});
