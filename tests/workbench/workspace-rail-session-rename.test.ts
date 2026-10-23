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

async function renderRail(
  courseFolder?: 'top' | 'folder',
): Promise<{ onRenameSession: ReturnType<typeof vi.fn>; moveCourse: ReturnType<typeof vi.fn> }> {
  const { WorkspaceRail } = await import('@/components/workbench/workspace/WorkspaceRail');
  const onRenameSession = vi.fn(async () => null);
  const moveCourse = vi.fn();
  window.localStorage.setItem(RAIL_TAB_STORAGE_KEY, courseFolder ? 'courses' : 'sessions');

  const container = document.createElement('div');
  container.className = 'ws-root';
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(WorkspaceRail, {
        courses: {
          classrooms: courseFolder
            ? [
                {
                  id: 'drag-course',
                  name: 'Course',
                  createdAt: 1,
                  updatedAt: 1,
                  ...(courseFolder === 'folder' ? { folderId: 'folder-1' } : {}),
                },
              ]
            : [],
          state: 'ready',
          reload: vi.fn(),
          importInput: null,
          discoveryContent: null,
          folders: courseFolder === 'folder' ? [{ id: 'folder-1', name: 'Folder' }] : [],
          openNewFolder: vi.fn(),
          moveCourse,
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
        libraryOpen: false,
        onOpenLibrary: vi.fn(),
        resizeHandle: null as ReactNode,
      }),
    );
  });
  return { onRenameSession, moveCourse };
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function openRename(sessionId: string): Promise<HTMLInputElement> {
  // The rail mounts its rows after the test's dynamic import resolves, so wait
  // for the row rather than assuming the commit has already landed — under a
  // loaded machine the import and the first paint both take real time.
  await vi.waitFor(
    () =>
      expect(
        byTestId(`pro-nav-more-session-${sessionId}`),
        `chat row ${sessionId} must have a ⋯ menu`,
      ).not.toBeNull(),
    { timeout: 30_000 },
  );
  const trigger = byTestId(`pro-nav-more-session-${sessionId}`)!;
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

// The rail is a large module graph imported dynamically inside the first
// test; on a loaded machine that import plus the first commit runs past the
// 5s default, so the suite carries its own budget.
describe('renaming a chat from its row', () => {
  it('shows the name the user gave it, and opens the box on that name', async () => {
    await renderRail();
    await vi.waitFor(
      () => expect(byTestId(`pro-nav-session-${NAMED}`)?.textContent).toContain('期末复习课'),
      { timeout: 30_000 },
    );
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
}, 30_000);

describe('course rail move-out destination', () => {
  it.each(['top', 'folder'] as const)(
    'only arms for a foldered course and handles release after the activating move: %s',
    async (location) => {
      const { moveCourse } = await renderRail(location);
      if (location === 'folder') {
        await act(async () => byTestId('pro-nav-folder-folder-1')!.click());
      }
      const row = byTestId('pro-nav-course-drag-course')!;
      expect(row).not.toBeNull();
      const ground = byTestId('pro-nav-tree-ground-drop')!;
      expect(ground.getAttribute('data-armed')).toBe('false');
      expect(ground.getAttribute('data-ws-drop-folder')).toBe('');
      // Hit testing is controlled; the production pointer gesture and row rendering are real.
      const original = document.elementFromPoint;
      document.elementFromPoint = () => ground;
      try {
        await act(async () => {
          row.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
          );
          window.dispatchEvent(
            new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 20 }),
          );
        });
        expect(ground.getAttribute('data-armed')).toBe(location === 'folder' ? 'true' : 'false');
        expect(ground.getAttribute('data-ws-drop-folder')).toBe('');
        expect(ground.textContent).toBe(location === 'folder' ? 'workspace.dropToUnfile' : '');
        // Cancellation still clears the first gesture without moving anything.
        await act(async () => window.dispatchEvent(new PointerEvent('pointercancel')));
        expect(ground.getAttribute('data-armed')).toBe('false');
        expect(moveCourse).not.toHaveBeenCalled();
        await act(async () => {
          row.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
          );
          window.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 20 }));
        });
        // Release immediately: no second move may repair the activation hit test.
        await act(async () =>
          window.dispatchEvent(new PointerEvent('pointerup', { clientX: 20, clientY: 20 })),
        );
        if (location === 'folder') {
          expect(moveCourse).toHaveBeenCalledExactlyOnceWith('drag-course', undefined);
        } else {
          expect(moveCourse).not.toHaveBeenCalled();
        }

        expect(ground.getAttribute('data-armed')).toBe('false');
      } finally {
        document.elementFromPoint = original;
      }
    },
  );
});
