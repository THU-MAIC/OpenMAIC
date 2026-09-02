// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  motion: { div: ({ children }: { children?: ReactNode }) => children },
}));
vi.mock('shiki', () => ({
  createHighlighter: () => new Promise(() => {}),
}));

import { BaseCodeElement as AppCodeElement } from '@/components/slide-renderer/components/element/CodeElement/BaseCodeElement';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Code line animation recovery', () => {
  it('mounts delayed lines when an authoritative refetch clears animation state', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const elementInfo = {
      id: 'code-1',
      type: 'code' as const,
      language: 'python',
      lines: [
        { id: 'line-1', content: 'buoyancy = density * gravity * volume' },
        { id: 'line-2', content: 'print(buoyancy)' },
      ],
      fileName: 'buoyancy.py',
      showLineNumbers: true,
      fontSize: 14,
      left: 0,
      top: 0,
      width: 420,
      height: 190,
      rotate: 0,
    };

    await act(async () => {
      root.render(createElement(AppCodeElement, { elementInfo, animate: true }));
    });
    expect(container.textContent).not.toContain('print(buoyancy)');

    await act(async () => {
      root.render(
        createElement(AppCodeElement, {
          elementInfo: { ...elementInfo, lines: elementInfo.lines.map((line) => ({ ...line })) },
          animate: true,
        }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
    });

    expect(container.textContent).toContain('print(buoyancy)');
    await act(async () => root.unmount());
  });
});
