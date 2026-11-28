// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import EvalWhiteboardPage from '@/app/eval/whiteboard/page';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('whiteboard evaluation label styles', () => {
  it('provides the renderer paragraph, list, and math rules to its elements', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(EvalWhiteboardPage)));
      const styles = host.querySelector('style')?.textContent ?? '';
      expect(styles).toContain('.slide-renderer-prose p {');
      expect(styles).toContain('margin-bottom: var(--paragraphSpace, 0)');
      expect(styles).toContain('list-style-type: disc !important');
      expect(styles).toContain('list-style-type: decimal !important');
      expect(styles).toContain('.katex-display');
    } finally {
      act(() => root.unmount());
    }
  });
});
