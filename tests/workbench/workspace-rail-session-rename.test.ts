// @vitest-environment jsdom

/**
 * Naming a chat from the rail.
 *
 * The chat rows used to be the one list whose overflow menu had no rename item — a chat was
 * whatever its first message said, forever. This pins the row-level half of the
 * rename: the entry exists, the row turns into an input in place (the same
 * `InlineNameRow` a course row uses), and — unlike a course or a folder — an
 * EMPTY box is a legal answer, because clearing the name is how a chat goes
 * back to being titled by its first message.
 */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RAIL_TAB_STORAGE_KEY } from '@/lib/workbench/workspace-rail-tab';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/brand/brand-context', () => ({
  useBrand: () => ({ markSrc: '/mark.svg', logoSrc: '/logo.svg' }),
}));
vi.mock('@/components/workbench/ProBadge', () => ({ ProBadge: () => null }));
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/components/site-header/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/lib/workbench/workspace-actions', () => ({
  deleteWorkspaceSession: vi.fn(async () => ({ deleted: true })),
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  createFolder: vi.fn(),
  renameFolder: vi.fn(async () => undefined),
  deleteFolder: vi.fn(async () => undefined),
}));

const roots: Root[] = [];

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.clearAllMocks();
});

const NAMED = 'session-named';
const UNNAMED = 'session-unnamed';

async function renderRail(): Promise<{ onRenameSession: ReturnType<typeof vi.fn> }> {
  const { WorkspaceRail } = await import('@/components/workbench/workspace/WorkspaceRail');
  const onRenameSession = vi.fn(async () => null);
  window.localStorage.setItem(RAIL_TAB_STORAGE_KEY, 'sessions');

  const container = document.createElement('div');
  container.className = 'ws-root';
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(WorkspaceRail, {
        courses: {
          classrooms: [],
          state: 'ready',
          reload: vi.fn(),
          importInput: null,
          discoveryContent: null,
          folders: [],
          openNewFolder: vi.fn(),
          moveCourse: vi.fn(),
          createAndMove: () => () => {},
          deleteCourse: vi.fn(async () => true),
        } as never,
        sessions: [
          {
            id: NAMED,
            stageId: 'stage-1',
            prompt: '帮我做一节课',
            title: '期末复习课',
            status: 'succeeded' as const,
            createdAt: 1,
            updatedAt: 2,
          },
          {
            id: UNNAMED,
            stageId: 'stage-2',
            prompt: '再来一节',
            status: 'succeeded' as const,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        sessionState: 'ready',
        onReloadSessions: vi.fn(),
        activeCourseId: null,
        activeSessionId: null,
        collapsed: false,
        onToggleCollapsed: vi.fn(),
        onOpenCourse: vi.fn(),
        onOpenSession: vi.fn(),
        onNewSession: vi.fn(),
        onGoHome: vi.fn(),
        onExitPro: vi.fn(),
        onSessionDeleted: vi.fn(),
        onRenameSession,
        onDeleteCourse: vi.fn(),
        resizeHandle: null as ReactNode,
      }),
    );
  });
  return { onRenameSession };
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function openRename(sessionId: string): Promise<HTMLInputElement> {
  const trigger = byTestId(`pro-nav-more-session-${sessionId}`);
  expect(trigger, `chat row ${sessionId} must have a ⋯ menu`).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
    );
    trigger!.click();
  });
  const item = byTestId(`pro-nav-more-session-${sessionId}-rename`);
  expect(item, 'the chat row menu must offer a rename item').not.toBeNull();
  await act(async () => item!.click());
  const input = byTestId(`pro-nav-session-rename-${sessionId}-input`);
  expect(input, 'the row must become an input in place').not.toBeNull();
  return input as HTMLInputElement;
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(sessionId: string): Promise<void> {
  const form = byTestId(`pro-nav-session-rename-${sessionId}`);
  expect(form).not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('renaming a chat from its row', () => {
  it('shows the name the user gave it, and opens the box on that name', async () => {
    await renderRail();
    expect(byTestId(`pro-nav-session-${NAMED}`)?.textContent).toContain('期末复习课');
    expect((await openRename(NAMED)).value).toBe('期末复习课');
  });

  it('opens EMPTY for a chat with no name of its own', async () => {
    await renderRail();
    // Not pre-filled with the whole first message to delete; the placeholder is
    // what says where the title comes from today.
    const input = await openRename(UNNAMED);
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('再来一节');
  });

  it('sends the new name and closes the row', async () => {
    const { onRenameSession } = await renderRail();
    await typeInto(await openRename(UNNAMED), '  第二节  ');
    await submit(UNNAMED);
    expect(onRenameSession).toHaveBeenCalledWith(UNNAMED, '  第二节  ');
    expect(byTestId(`pro-nav-session-rename-${UNNAMED}-input`)).toBeNull();
  });

  it('accepts an empty box — that is how the derived title comes back', async () => {
    const { onRenameSession } = await renderRail();
    await typeInto(await openRename(NAMED), '');
    // The confirm control stays live, unlike a folder's (whose name is required).
    expect(byTestId(`pro-nav-session-rename-${NAMED}-confirm`)?.hasAttribute('disabled')).toBe(
      false,
    );
    await submit(NAMED);
    expect(onRenameSession).toHaveBeenCalledWith(NAMED, '');
  });

  it('leaves the name alone on Escape', async () => {
    const { onRenameSession } = await renderRail();
    const input = await openRename(NAMED);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onRenameSession).not.toHaveBeenCalled();
    expect(byTestId(`pro-nav-session-rename-${NAMED}-input`)).toBeNull();
  });
});
