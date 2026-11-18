// @vitest-environment jsdom

/**
 * The workspace on a phone.
 *
 * Below `md` the rail is `hidden md:flex`, so before the phone bar a phone could
 * reach nothing but the home composer: not my courses, not the knowledge base,
 * not an earlier conversation. This pins the way back in: the bar's three
 * controls, and the rail reused as a sheet — same destinations and list, closing
 * from its header, no width drag and no keyboard-shortcut hints.
 */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/brand/brand-context', () => ({
  useBrand: () => ({ markSrc: '/mark.svg', logoSrc: '/logo.svg' }),
}));
vi.mock('@/components/workbench/workspace/WorkspaceAccount', () => ({
  WorkspaceAccountBlock: () => null,
}));
vi.mock('@/lib/workbench/workspace-actions', () => ({
  deleteWorkspaceSession: vi.fn(async () => ({ deleted: true })),
}));

const desktop = { matches: false };
vi.mock('@/lib/hooks/use-media-query', () => ({
  useMediaQuery: () => desktop.matches,
}));

const roots: Root[] = [];

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let WorkspaceRail: typeof import('@/components/workbench/workspace/WorkspaceRail').WorkspaceRail;
let Mobile: typeof import('@/components/workbench/workspace/WorkspaceMobileBar');
beforeAll(async () => {
  ({ WorkspaceRail } = await import('@/components/workbench/workspace/WorkspaceRail'));
  Mobile = await import('@/components/workbench/workspace/WorkspaceMobileBar');
}, 30_000);

beforeAll(() => {
  if (!globalThis.PointerEvent) vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  window.localStorage.clear();
  desktop.matches = false;
  vi.clearAllMocks();
});

function mount(): { container: HTMLElement; root: Root } {
  const container = document.createElement('div');
  container.className = 'ws-root';
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  return { container, root };
}

function railProps(overrides: Record<string, unknown> = {}) {
  return {
    sessions: [
      {
        id: 'session-1',
        stageId: 'stage-1',
        prompt: '帮我做一节课',
        title: '光合作用',
        status: 'succeeded' as const,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    sessionState: 'ready' as const,
    onReloadSessions: vi.fn(),
    activeSessionId: null,
    collapsed: false,
    onToggleCollapsed: vi.fn(),
    onOpenSession: vi.fn(),
    onNewSession: vi.fn(),
    onGoHome: vi.fn(),
    onSessionDeleted: vi.fn(),
    onRenameSession: vi.fn(async () => null),
    onOpenSearch: vi.fn(),
    onOpenSettings: vi.fn(),
    activeView: null,
    onOpenView: vi.fn(),
    resizeHandle: createElement('div', { 'data-testid': 'resize' }) as ReactNode,
    ...overrides,
  };
}

const q = (scope: ParentNode, id: string) =>
  scope.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('WorkspaceRail as the phone sheet', () => {
  it('shows the expanded tree with a close button, no fold, no shortcuts, no width drag', async () => {
    const { container, root } = mount();
    const onCloseDrawer = vi.fn();
    const props = railProps({ variant: 'drawer', onCloseDrawer, collapsed: true });
    await act(async () => root.render(createElement(WorkspaceRail, props)));

    const nav = q(container, 'pro-nav-drawer');
    expect(nav).not.toBeNull();
    // Not hidden below `md` like the rail, and expanded even when the rail is folded.
    expect(nav?.className).not.toContain('hidden');
    expect(q(container, 'pro-nav-rail')).toBeNull();
    expect(q(container, 'pro-nav-my-courses')).not.toBeNull();
    expect(q(container, 'pro-nav-library')).not.toBeNull();
    expect(q(container, 'pro-nav-search')).not.toBeNull();
    expect(q(container, 'pro-nav-collapse')).toBeNull();
    expect(container.querySelector('kbd')).toBeNull();
    expect(q(container, 'resize')).toBeNull();

    await act(async () => q(container, 'pro-nav-drawer-close')?.click());
    expect(onCloseDrawer).toHaveBeenCalledTimes(1);

    await act(async () => q(container, 'pro-nav-my-courses')?.click());
    expect(props.onOpenView).toHaveBeenCalledWith('courses');
  });

  it('leaves the desktop rail as it was', async () => {
    const { container, root } = mount();
    await act(async () => root.render(createElement(WorkspaceRail, railProps())));
    const nav = q(container, 'pro-nav-rail');
    expect(nav?.className).toContain('hidden');
    expect(nav?.className).toContain('md:flex');
    expect(q(container, 'pro-nav-collapse')).not.toBeNull();
    expect(container.querySelectorAll('kbd').length).toBeGreaterThan(0);
    expect(q(container, 'resize')).not.toBeNull();
  });
});

describe('WorkspaceMobileBar', () => {
  it('opens the menu, goes home from the mark and starts a conversation', async () => {
    const { container, root } = mount();
    const onOpenMenu = vi.fn();
    const onGoHome = vi.fn();
    const onNewSession = vi.fn();
    await act(async () =>
      root.render(createElement(Mobile.WorkspaceMobileBar, { onOpenMenu, onGoHome, onNewSession })),
    );

    expect(q(container, 'pro-mobile-bar')?.className).toContain('md:hidden');
    await act(async () => q(container, 'pro-mobile-menu')?.click());
    await act(async () => q(container, 'pro-mobile-home')?.click());
    await act(async () => q(container, 'pro-mobile-new-session')?.click());
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(onGoHome).toHaveBeenCalledTimes(1);
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspaceMobileDrawer', () => {
  const sheet = (open: boolean, onOpenChange: (open: boolean) => void) =>
    createElement(
      Mobile.WorkspaceMobileDrawer,
      // `children` arrives as createElement's third argument.
      { open, onOpenChange } as Parameters<typeof Mobile.WorkspaceMobileDrawer>[0],
      createElement('p', { 'data-testid': 'sheet-body' }, 'rail'),
    );

  it('portals into the workspace root, where the rail colours are defined', async () => {
    const { container, root } = mount();
    await act(async () => root.render(sheet(true, vi.fn())));
    const drawer = q(document, 'pro-mobile-drawer');
    expect(drawer).not.toBeNull();
    expect(container.contains(drawer)).toBe(true);
    expect(q(drawer!, 'sheet-body')).not.toBeNull();
  });

  it('closes on Escape', async () => {
    const { root } = mount();
    const onOpenChange = vi.fn();
    await act(async () => root.render(sheet(true, onOpenChange)));
    await act(async () => {
      q(document, 'pro-mobile-drawer')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes itself once the viewport reaches `md`, where the rail is back', async () => {
    const { root } = mount();
    desktop.matches = true;
    const onOpenChange = vi.fn();
    await act(async () => root.render(sheet(true, onOpenChange)));
    expect(q(document, 'pro-mobile-drawer')).toBeNull();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
