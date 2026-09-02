// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspacePaneNavigation } from '@/lib/workbench/use-workspace-pane-navigation';
import type { WorkspacePanes } from '@/lib/workbench/workspace-panes';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe({ initial }: { readonly initial: WorkspacePanes }) {
  const navigation = useWorkspacePaneNavigation(initial);
  return createElement(
    'div',
    null,
    createElement('output', { 'data-testid': 'state' }, JSON.stringify(navigation.panes)),
    createElement(
      'button',
      {
        'data-testid': 'push-course',
        onClick: () => navigation.push({ ...navigation.panes, courseId: 'course-2' }),
      },
      'course',
    ),
    createElement(
      'button',
      {
        'data-testid': 'replace-session',
        onClick: () => navigation.replace({ ...navigation.panes, sessionId: 'session-2' }),
      },
      'session',
    ),
    createElement(
      'button',
      {
        'data-testid': 'push-current',
        onClick: () => navigation.push(navigation.panes),
      },
      'current',
    ),
  );
}

const state = () => container?.querySelector('[data-testid="state"]')?.textContent;
const click = async (testId: string) => {
  const button = container?.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement;
  await act(async () => button.click());
};

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', '/workspace?session=session-1&course=course-1');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(Probe, {
        initial: { sessionId: 'session-1', courseId: 'course-1' },
      }),
    ),
  );
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('workspace pane navigation', () => {
  it('updates pane state and the address bar through native history', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');

    await click('push-course');
    expect(state()).toBe('{"sessionId":"session-1","courseId":"course-2"}');
    expect(window.location.pathname + window.location.search).toBe(
      '/workspace?session=session-1&course=course-2',
    );
    expect(push).toHaveBeenCalledWith(null, '', '/workspace?session=session-1&course=course-2');

    await click('replace-session');
    expect(state()).toBe('{"sessionId":"session-2","courseId":"course-2"}');
    expect(replace).toHaveBeenCalledWith(null, '', '/workspace?session=session-2&course=course-2');
  });

  it('restores the exact URL snapshot on browser back/forward', async () => {
    window.history.replaceState(null, '', '/workspace?course=course-history');
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));

    expect(state()).toBe('{"sessionId":null,"courseId":"course-history"}');
  });

  it('does not create duplicate history entries for the current pane state', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    await click('push-current');
    expect(push).not.toHaveBeenCalled();
  });
});
