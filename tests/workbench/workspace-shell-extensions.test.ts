// @vitest-environment jsdom

/**
 * The bar-less workspace shell: the rail's destinations and account block, and
 * the host extension slots (`lib/workbench/shell-extensions.tsx`) through which
 * a deployment adds its own rail entries, account menu entries, account summary
 * and unread badge without editing the shell.
 */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Images, Receipt } from 'lucide-react';
import {
  WorkbenchShellExtensionsProvider,
  hostPageItems,
  mergeWorkbenchShellExtensions,
  useWorkbenchShellExtensions,
  type WorkbenchShellExtensions,
} from '@/lib/workbench/shell-extensions';
import { AVATAR_OPTIONS, useUserProfileStore } from '@/lib/store/user-profile';
import { PROFILE_SAVE_DELAY_MS } from '@/components/workbench/workspace/WorkspaceAccount';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US', setLocale: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}));
vi.mock('@/lib/brand/brand-context', () => ({
  useBrand: () => ({ markSrc: '/mark.svg', logoSrc: '/logo.svg' }),
}));
vi.mock('@/components/settings', () => ({ SettingsDialog: () => null }));
vi.mock('@/lib/workbench/workspace-actions', () => ({
  deleteWorkspaceSession: vi.fn(async () => ({ deleted: true })),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let WorkspaceRail: typeof import('@/components/workbench/workspace/WorkspaceRail').WorkspaceRail;
beforeAll(async () => {
  ({ WorkspaceRail } = await import('@/components/workbench/workspace/WorkspaceRail'));
  if (!globalThis.PointerEvent) vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}, 30_000);

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
});

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function renderRail({
  extensions,
  collapsed = false,
  activeView = null,
}: {
  readonly extensions?: WorkbenchShellExtensions;
  readonly collapsed?: boolean;
  readonly activeView?: string | null;
} = {}) {
  const onOpenView = vi.fn();
  const onToggleCollapsed = vi.fn();
  const onOpenSearch = vi.fn();
  const container = document.createElement('div');
  container.className = 'ws-root';
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const rail = createElement(WorkspaceRail, {
    sessions: [],
    sessionState: 'ready',
    onReloadSessions: vi.fn(),
    activeSessionId: null,
    collapsed,
    onToggleCollapsed,
    onOpenSession: vi.fn(),
    onNewSession: vi.fn(),
    onGoHome: vi.fn(),
    onSessionDeleted: vi.fn(),
    onRenameSession: vi.fn(async () => null),
    onOpenSearch,
    onOpenSettings: vi.fn(),
    activeView,
    onOpenView,
    resizeHandle: null as ReactNode,
  });
  await act(async () => {
    root.render(
      extensions
        ? createElement(WorkbenchShellExtensionsProvider, { value: extensions }, rail)
        : rail,
    );
  });
  return { onOpenView, onToggleCollapsed, onOpenSearch };
}

async function openAccountMenu(): Promise<HTMLElement> {
  const trigger = byTestId('workspace-account') ?? byTestId('workspace-account-more');
  expect(trigger, 'the account block').not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
    );
  });
  const menu = byTestId('workspace-account-menu');
  expect(menu, 'the account menu').not.toBeNull();
  return menu!;
}

describe('the rail’s destinations', () => {
  it('lists search, my courses and the knowledge base, and opens pages in the main area', async () => {
    const { onOpenView } = await renderRail({ activeView: 'courses' });
    expect(byTestId('pro-nav-search')).not.toBeNull();
    expect(byTestId('pro-nav-my-courses')?.getAttribute('aria-current')).toBe('page');
    expect(byTestId('pro-nav-library')?.getAttribute('aria-current')).toBeNull();
    await act(async () => byTestId('pro-nav-library')!.click());
    expect(onOpenView).toHaveBeenCalledWith('library');
    await act(async () => byTestId('pro-nav-my-courses')!.click());
    expect(onOpenView).toHaveBeenCalledWith('courses');
  });

  it('opens the global search from Search, which states its shortcut', async () => {
    const { onOpenSearch } = await renderRail();
    expect(byTestId('pro-nav-search-input')).toBeNull();
    expect(byTestId('pro-nav-search')?.getAttribute('aria-keyshortcuts')).toMatch(/\+K$/);
    expect(byTestId('pro-nav-search-shortcut')?.textContent).toMatch(/K$/);
    await act(async () => byTestId('pro-nav-search')!.click());
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it('states the new-chat shortcut on its button', async () => {
    await renderRail();
    expect(byTestId('pro-workspace-new-session')?.getAttribute('aria-keyshortcuts')).toMatch(
      /Shift\+O$/,
    );
    expect(byTestId('pro-workspace-new-session-shortcut')?.textContent).toMatch(/O$/);
  });

  it('opens the same search from the folded strip, without unfolding it', async () => {
    const { onToggleCollapsed, onOpenSearch } = await renderRail({ collapsed: true });
    await act(async () => byTestId('pro-nav-search-mini')!.click());
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  it('keeps the same destinations as icons when folded', async () => {
    await renderRail({ collapsed: true });
    expect(byTestId('pro-nav-rail-mini')).not.toBeNull();
    expect(byTestId('pro-nav-my-courses')?.getAttribute('aria-label')).toBe(
      'workspace.nav.myCourses',
    );
    expect(byTestId('pro-nav-library')).not.toBeNull();
    expect(byTestId('pro-workspace-new-session-mini')).not.toBeNull();
    expect(byTestId('workspace-account')).not.toBeNull();
  });
});

describe('the host extension slots', () => {
  const page = () => createElement('p', null, 'gallery page');
  const host: WorkbenchShellExtensions = {
    navItems: [
      { id: 'gallery', label: 'Gallery', icon: Images, render: page, tag: 'New' },
      { id: 'help', label: 'Help', icon: Images, href: 'https://example.com/help', external: true },
    ],
    accountMenuItems: [{ id: 'billing', label: 'Billing', icon: Receipt, trailing: '3' }],
    accountSummary: createElement('span', null, '120 credits'),
    accountBadge: true,
  };

  it('renders nothing extra upstream', async () => {
    await renderRail();
    expect(document.querySelector('[data-testid^="pro-nav-host-"]')).toBeNull();
    expect(byTestId('workspace-account-badge')).toBeNull();
    expect(byTestId('workspace-account-summary')).toBeNull();
    const menu = await openAccountMenu();
    expect(menu.querySelector('[data-testid="workspace-account-host-items"]')).toBeNull();
    expect(menu.querySelector('[data-testid="workspace-account-sign-out"]')).toBeNull();
  });

  it('adds the host’s rail entries after the built-ins, as pages or links', async () => {
    const { onOpenView } = await renderRail({ extensions: host });
    const items = [
      ...document.querySelectorAll('[data-testid="pro-nav-destinations"] > [data-testid]'),
    ].map((el) => el.getAttribute('data-testid'));
    expect(items).toEqual([
      'pro-nav-search',
      'pro-nav-my-courses',
      'pro-nav-library',
      'pro-nav-host-gallery',
      'pro-nav-host-help',
    ]);
    expect(byTestId('pro-nav-host-gallery')?.textContent).toContain('New');
    await act(async () => byTestId('pro-nav-host-gallery')!.click());
    expect(onOpenView).toHaveBeenCalledWith('gallery');
    const link = byTestId('pro-nav-host-help') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://example.com/help');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('shows the host’s entries folded too', async () => {
    await renderRail({ extensions: host, collapsed: true });
    expect(byTestId('pro-nav-host-gallery')?.getAttribute('aria-label')).toBe('Gallery');
  });

  it('puts the summary and the unread badge on the account block', async () => {
    await renderRail({ extensions: host });
    expect(byTestId('workspace-account-summary')?.textContent).toBe('120 credits');
    expect(byTestId('workspace-account-badge')).not.toBeNull();
  });

  it('adds the host’s menu entries in their own group, above the settings', async () => {
    await renderRail({ extensions: host });
    const menu = await openAccountMenu();
    const group = menu.querySelector('[data-testid="workspace-account-host-items"]');
    expect(group?.textContent).toContain('Billing');
    expect(menu.querySelector('[data-testid="workspace-account-menu-summary"]')?.textContent).toBe(
      '120 credits',
    );
    const html = menu.innerHTML;
    expect(html.indexOf('workspace-account-item-billing')).toBeLessThan(
      html.indexOf('workspace-account-settings'),
    );
  });

  it('carries everything the classic corner controls did', async () => {
    await renderRail();
    const menu = await openAccountMenu();
    for (const id of [
      'workspace-account-settings',
      'workspace-account-language',
      'workspace-account-theme-light',
      'workspace-account-theme-dark',
      'workspace-account-theme-system',
      'workspace-account-about',
      'workspace-account-docs',
      'workspace-account-github',
    ]) {
      expect(menu.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
  });

  const setInput = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    await act(async () => {
      setter.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('edits the profile inside the menu, saving as it changes', async () => {
    vi.useFakeTimers();
    try {
      await act(async () => useUserProfileStore.getState().setNickname('Ada'));
      await renderRail();
      const menu = await openAccountMenu();
      // The rest of the menu stays; no dialog and no button to confirm.
      expect(menu.querySelector('[data-testid="workspace-account-settings"]')).not.toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(menu.textContent).not.toContain('workspace.account.models');

      // The name becomes a field in place, saved once typing settles.
      await act(async () => byTestId('workspace-profile-name-button')!.click());
      const name = byTestId('workspace-profile-name') as HTMLInputElement;
      expect(name.value).toBe('Ada');
      await setInput(name, 'Grace');
      expect(useUserProfileStore.getState().nickname).toBe('Ada');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROFILE_SAVE_DELAY_MS);
      });
      expect(useUserProfileStore.getState().nickname).toBe('Grace');
      expect(byTestId('workspace-profile-saved')?.textContent).toContain(
        'workspace.account.profileSaved',
      );
      expect(byTestId('workspace-account')?.textContent).toContain('Grace');

      // Enter folds the field back into the row.
      await act(async () => {
        name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(byTestId('workspace-profile-name')).toBeNull();

      // The avatar opens a strip under the row; a pick is saved at once.
      await act(async () => byTestId('workspace-profile-avatar-toggle')!.click());
      const avatars = menu.querySelectorAll<HTMLElement>(
        '[data-testid="workspace-profile-avatar"]',
      );
      expect(avatars.length).toBe(AVATAR_OPTIONS.length);
      await act(async () => avatars[2]!.click());
      expect(useUserProfileStore.getState().avatar).toBe(AVATAR_OPTIONS[2]);

      // "About me" opens the bio in place; leaving the field saves it at once.
      await act(async () => byTestId('workspace-profile-bio-toggle')!.click());
      const bio = byTestId('workspace-profile-bio') as HTMLTextAreaElement;
      await setInput(bio, 'Likes worked examples');
      await act(async () => {
        bio.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(useUserProfileStore.getState().bio).toBe('Likes worked examples');
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves what was typed when the menu closes before the pause', async () => {
    await act(async () => useUserProfileStore.getState().setNickname('Ada'));
    await renderRail();
    await openAccountMenu();
    await act(async () => byTestId('workspace-profile-name-button')!.click());
    await setInput(byTestId('workspace-profile-name') as HTMLInputElement, 'Lin');
    // Unmounting the rail closes the menu.
    for (const root of roots.splice(0)) act(() => root.unmount());
    expect(useUserProfileStore.getState().nickname).toBe('Lin');
  });

  it('offers no local profile editor for a host identity', async () => {
    await renderRail({ extensions: { identity: { signedIn: true, name: 'Ada' } } });
    const menu = await openAccountMenu();
    expect(menu.querySelector('[data-testid="workspace-account-profile"]')).toBeNull();
  });

  it('shows a sign-in entry for a signed-out user, and sign-out for a signed-in one', async () => {
    const onSelect = vi.fn();
    await renderRail({
      extensions: { identity: { signedIn: false, signIn: { onSelect, hint: 'Sign in to save' } } },
    });
    expect(byTestId('workspace-account')).toBeNull();
    await act(async () => byTestId('workspace-account-sign-in')!.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Sign in to save');
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.replaceChildren();

    const onSignOut = vi.fn();
    await renderRail({
      extensions: {
        identity: { signedIn: true, name: 'Ada', detail: 'ada@example.com', onSignOut },
      },
    });
    expect(byTestId('workspace-account')?.textContent).toContain('Ada');
    const menu = await openAccountMenu();
    expect(menu.textContent).toContain('ada@example.com');
    expect(menu.querySelector('[data-testid="workspace-account-sign-out"]')).not.toBeNull();
  });
});

describe('merging nested providers', () => {
  it('concatenates lists outer first and lets the inner single values win', () => {
    const merged = mergeWorkbenchShellExtensions(
      {
        navItems: [{ id: 'a', label: 'A', icon: Images, render: () => null }],
        accountSummary: 'outer',
        accountBadge: true,
      },
      {
        navItems: [{ id: 'b', label: 'B', icon: Images, href: '/b' }],
        accountSummary: 'inner',
      },
    );
    expect(merged.navItems?.map((item) => item.id)).toEqual(['a', 'b']);
    expect(merged.accountSummary).toBe('inner');
    expect(merged.accountBadge).toBe(true);
    // Only the entries that render a page are pages.
    expect([...hostPageItems(merged).keys()]).toEqual(['a']);
  });

  it('merges through the provider tree', async () => {
    const seen = vi.fn();
    function Probe() {
      seen(useWorkbenchShellExtensions());
      return null;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        createElement(
          WorkbenchShellExtensionsProvider,
          { value: { accountMenuItems: [{ id: 'x', label: 'X' }] } },
          createElement(
            WorkbenchShellExtensionsProvider,
            { value: { accountMenuItems: [{ id: 'y', label: 'Y' }] } },
            createElement(Probe),
          ),
        ),
      ),
    );
    const latest = seen.mock.calls.at(-1)![0] as WorkbenchShellExtensions;
    expect(latest.accountMenuItems?.map((item) => item.id)).toEqual(['x', 'y']);
  });
});
