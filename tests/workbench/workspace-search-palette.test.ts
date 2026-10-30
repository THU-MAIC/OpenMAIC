// @vitest-environment jsdom

/**
 * The workspace's global search: ⌘K (Ctrl+K off the Mac) and the rail's
 * Search open one palette that finds conversations, courses (by name or by
 * the folder they are filed in) and knowledge-base materials by name, grouped
 * by kind, and opens a result the way clicking it elsewhere does. With nothing
 * typed it offers the recent work and the three ways to start.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
const fetchPage = vi.fn();
import { isNewChatShortcut, isSearchShortcut, shortcutLabel } from '@/lib/workbench/shortcuts';

vi.mock('@/lib/workbench/material-library-client', () => ({
  fetchMaterialLibraryPage: (...args: unknown[]) => fetchPage(...args),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type PaletteModule = typeof import('@/components/workbench/workspace/WorkspaceSearchPalette');
let palette: PaletteModule;
beforeAll(async () => {
  palette = await import('@/components/workbench/workspace/WorkspaceSearchPalette');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}, 30_000);

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  fetchPage.mockReset();
});

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const idsIn = (group: string) =>
  [...(byTestId(group)?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? [])].map(
    (item) => item.dataset.testid,
  );

async function renderPalette() {
  const handlers = {
    onOpenChange: vi.fn(),
    onOpenSession: vi.fn(),
    onOpenCourse: vi.fn(),
    onOpenMaterial: vi.fn(),
    onNewSession: vi.fn(),
    onOpenView: vi.fn(),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(palette.WorkspaceSearchPalette, {
        open: true,
        sessions: [
          {
            id: 's-old',
            stageId: 'x',
            prompt: 'Photosynthesis review',
            status: 'succeeded',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 's-new',
            stageId: 'y',
            prompt: 'ignored',
            title: 'Fractions warm-up',
            status: 'succeeded',
            createdAt: 2,
            updatedAt: 5,
          },
        ],
        courses: [
          { id: 'c1', name: 'Fractions basics', folderId: 'f1', updatedAt: 3 },
          { id: 'c2', name: 'Cell biology', updatedAt: 4 },
          { id: 'c3', name: 'Decimals', folderId: 'f1', updatedAt: 2 },
        ],
        folders: [{ id: 'f1', name: 'Math' }],
        coursesView: 'courses',
        libraryView: 'library',
        ...handlers,
      }),
    );
  });
  return handlers;
}

async function type(value: string) {
  const input = byTestId('workspace-search-input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the shortcuts', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'k', ...init });
  it('opens the search with ⌘K on the Mac and Ctrl+K elsewhere, and nothing else', () => {
    expect(isSearchShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isSearchShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isSearchShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isSearchShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSearchShortcut(key({ key: 'K', metaKey: true }), true)).toBe(true);
    expect(isSearchShortcut(key({ key: 'j', metaKey: true }), true)).toBe(false);
  });

  it('starts a new chat with ⌘⇧O on the Mac and Ctrl+Shift+O elsewhere', () => {
    const o = (init: KeyboardEventInit) => key({ key: 'O', code: 'KeyO', shiftKey: true, ...init });
    expect(isNewChatShortcut(o({ metaKey: true }), true)).toBe(true);
    expect(isNewChatShortcut(o({ ctrlKey: true }), false)).toBe(true);
    expect(isNewChatShortcut(o({ ctrlKey: true }), true)).toBe(false);
    expect(isNewChatShortcut(o({ metaKey: true, shiftKey: false }), true)).toBe(false);
    expect(isNewChatShortcut(o({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(shortcutLabel('newChat', true).label).toBe('⌘⇧O');
    expect(shortcutLabel('newChat', false).label).toBe('Ctrl Shift O');
  });
});

describe('with nothing typed', () => {
  it('offers recent chats, recent courses and the quick actions', async () => {
    const handlers = await renderPalette();
    expect(idsIn('workspace-search-group-chats')).toEqual([
      'workspace-search-chat-s-new',
      'workspace-search-chat-s-old',
    ]);
    expect(idsIn('workspace-search-group-courses')).toEqual([
      'workspace-search-course-c2',
      'workspace-search-course-c1',
      'workspace-search-course-c3',
    ]);
    expect(byTestId('workspace-search-group-materials')).toBeNull();
    await act(async () => byTestId('workspace-search-action-library')!.click());
    expect(handlers.onOpenView).toHaveBeenCalledWith('library');
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

describe('a query', () => {
  it('groups chats, courses (by name or folder) and materials, asking the library once typing settles', async () => {
    vi.useFakeTimers();
    fetchPage.mockResolvedValue({
      materials: [
        {
          materialId: 'm1',
          name: 'fractions-worksheet.pdf',
          bytes: 1,
          folderId: 'kf',
          folderName: 'Handouts',
          extraction: { status: 'done' },
          createdAt: '2026-10-01T00:00:00Z',
        },
      ],
    });
    const handlers = await renderPalette();
    await type('fract');
    expect(idsIn('workspace-search-group-chats')).toEqual(['workspace-search-chat-s-new']);
    expect(idsIn('workspace-search-group-courses')).toEqual(['workspace-search-course-c1']);
    expect(byTestId('workspace-search-course-c1')!.textContent).toContain('Math');
    expect(byTestId('workspace-search-loading')).not.toBeNull();
    expect(byTestId('workspace-search-group-actions')).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(palette.SEARCH_DEBOUNCE_MS);
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0]![0]).toMatchObject({ scope: { kind: 'all' }, query: 'fract' });
    expect(idsIn('workspace-search-group-materials')).toEqual(['workspace-search-material-m1']);
    expect(byTestId('workspace-search-material-m1')!.textContent).toContain('Handouts');
    expect(byTestId('workspace-search-loading')).toBeNull();

    await act(async () => byTestId('workspace-search-material-m1')!.click());
    expect(handlers.onOpenMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ materialId: 'm1' }),
    );
  });

  it('finds the courses filed in a folder by the folder’s name', async () => {
    fetchPage.mockResolvedValue({ materials: [] });
    await renderPalette();
    await type('math');
    expect(idsIn('workspace-search-group-courses')).toEqual([
      'workspace-search-course-c1',
      'workspace-search-course-c3',
    ]);
  });

  it('opens a chat or a course as clicking it elsewhere does', async () => {
    fetchPage.mockResolvedValue({ materials: [] });
    const handlers = await renderPalette();
    await type('cell');
    await act(async () => byTestId('workspace-search-course-c2')!.click());
    expect(handlers.onOpenCourse).toHaveBeenCalledWith('c2');
    await type('photo');
    await act(async () => byTestId('workspace-search-chat-s-old')!.click());
    expect(handlers.onOpenSession).toHaveBeenCalledWith('s-old');
  });

  it('says when nothing matches', async () => {
    vi.useFakeTimers();
    fetchPage.mockResolvedValue({ materials: [] });
    await renderPalette();
    await type('zzz');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(palette.SEARCH_DEBOUNCE_MS);
    });
    expect(byTestId('workspace-search-empty')?.textContent).toBe(
      'workspace.search.empty:{"query":"zzz"}',
    );
  });

  it('moves through the results with the arrows and opens one with Enter', async () => {
    fetchPage.mockResolvedValue({ materials: [] });
    const handlers = await renderPalette();
    const input = byTestId('workspace-search-input')!;
    const press = (key: string) =>
      act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    // First row selected: the newest chat. Down, down: the second course.
    await press('ArrowDown');
    await press('ArrowDown');
    await press('Enter');
    expect(handlers.onOpenCourse).toHaveBeenCalledWith('c2');
  });
});
