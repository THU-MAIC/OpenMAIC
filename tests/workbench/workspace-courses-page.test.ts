// @vitest-environment jsdom

/**
 * My courses is the library's one home in the workspace — the rail lists chats
 * only. Everything the rail's old course tree offered is pinned here: a
 * course's ⋯ renames in place, files into a folder and deletes after a second
 * press; a folder's ⋯ renames and deletes (keeping its courses) after a
 * question. A new folder is a draft card with its name selected, Finder-style,
 * not a dialog.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/hooks/use-course-thumbnails', () => ({
  useCourseThumbnails: () => ({
    thumbnails: {},
    requestThumbnail: () => () => {},
    retainThumbnails: () => {},
  }),
}));
vi.mock('@/lib/hooks/use-near-viewport', () => ({ useNearViewport: () => false }));
const renameStage = vi.fn(async () => undefined);
vi.mock('@/lib/live/server-api', () => ({
  apiRenameStage: (...args: unknown[]) => renameStage(...(args as [])),
  StageRenameError: class extends Error {},
  STAGE_NAME_MAX_LENGTH: 200,
}));
const removeKeepingCourses = vi.fn(async () => undefined);
const renameFolder = vi.fn(async () => undefined);
vi.mock('@/components/workbench/workspace/workspace-folder-seam', () => ({
  workspaceFoldersAvailable: () => true,
  workspaceFolderAdapter: {
    create: vi.fn(async () => undefined),
    rename: (...args: unknown[]) => renameFolder(...(args as [])),
    removeKeepingCourses: (...args: unknown[]) => removeKeepingCourses(...(args as [])),
  },
  WorkspaceFolderNameError: class extends Error {},
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let WorkspaceCoursesPage: typeof import('@/components/workbench/workspace/WorkspaceCoursesPage').WorkspaceCoursesPage;
beforeAll(async () => {
  ({ WorkspaceCoursesPage } =
    await import('@/components/workbench/workspace/WorkspaceCoursesPage'));
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
  window.localStorage.clear();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function renderPage(extraCourses: readonly Record<string, unknown>[] = []) {
  const onDeleteCourse = vi.fn();
  const reload = vi.fn(async () => undefined);
  const createFolder = vi.fn(async (name: string) => ({ id: 'f-new', name }));
  const moveCourse = vi.fn(async () => undefined);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(WorkspaceCoursesPage, {
        courses: {
          classrooms: [
            { id: 'c1', name: 'Fractions', sceneCount: 3, createdAt: 1, updatedAt: 2 },
            {
              id: 'c2',
              name: 'Poems',
              sceneCount: 5,
              createdAt: 1,
              updatedAt: 1,
              folderId: 'f1',
            },
            ...extraCourses,
          ],
          state: 'ready',
          reload,
          importInput: null,
          triggerImport: vi.fn(),
          importing: false,
          folders: [{ id: 'f1', name: 'Math' }],
          createFolder,
          moveCourse,
          deleteCourse: vi.fn(async () => true),
        } as never,
        courseRuns: new Map(),
        pendingRuns: [],
        onOpenCourse: vi.fn(),
        onDeleteCourse,
      }),
    );
  });
  return { onDeleteCourse, reload, createFolder, moveCourse };
}

async function openMenu(testId: string) {
  const trigger = byTestId(testId);
  expect(trigger, testId).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
    );
    trigger!.click();
  });
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressKey(input: HTMLInputElement, key: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('folders as cards', () => {
  const gridIds = () =>
    [
      ...byTestId('workspace-courses-grid')!.querySelectorAll<HTMLElement>(
        '[data-testid^="workspace-courses-card-"], [data-testid^="workspace-courses-folder-card-"], [data-testid="workspace-courses-new-folder-card"]',
      ),
    ].map((card) => card.dataset.testid);

  it('share one grid with the courses in no folder, most recent activity first', async () => {
    await renderPage();
    // The folder's activity is its newest course's (c2, older than c1).
    expect(gridIds()).toEqual(['workspace-courses-card-c1', 'workspace-courses-folder-card-f1']);
    const card = byTestId('workspace-courses-folder-card-f1')!;
    expect(card.textContent).toContain('Math');
    expect(card.textContent).toContain('classroom.folderBadge');
    // The course count, as the classic tile shows it.
    expect(card.textContent).toContain('1 classroom.folderCourseCountUnit');
  });

  it('open onto their courses, with a way back', async () => {
    await renderPage();
    await act(async () => byTestId('workspace-courses-folder-f1')!.click());
    expect(byTestId('workspace-courses-folder-title')?.textContent).toBe('Math');
    expect(gridIds()).toEqual(['workspace-courses-card-c2']);
    await act(async () => byTestId('workspace-courses-back')!.click());
    expect(gridIds()).toEqual(['workspace-courses-card-c1', 'workspace-courses-folder-card-f1']);
  });

  it('take a draft card at the head of the grid for a new folder', async () => {
    await renderPage();
    await act(async () => byTestId('workspace-courses-new-folder')!.click());
    expect(gridIds()[0]).toBe('workspace-courses-new-folder-card');
    expect(
      byTestId('workspace-courses-new-folder-card')!.contains(
        byTestId('workspace-courses-new-folder-input'),
      ),
    ).toBe(true);
  });
});

describe('a new folder, in place', () => {
  it('appears as a draft card with a de-duplicated default name, selected', async () => {
    await renderPage();
    await act(async () => byTestId('workspace-courses-new-folder')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const input = byTestId('workspace-courses-new-folder-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('classroom.newFolderTitle');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
  });

  it('is created by Enter, and Escape drops the draft', async () => {
    const { createFolder } = await renderPage();
    await act(async () => byTestId('workspace-courses-new-folder')!.click());
    let input = byTestId('workspace-courses-new-folder-input') as HTMLInputElement;
    await pressKey(input, 'Escape');
    expect(byTestId('workspace-courses-new-folder-card')).toBeNull();
    expect(createFolder).not.toHaveBeenCalled();

    await act(async () => byTestId('workspace-courses-new-folder')!.click());
    input = byTestId('workspace-courses-new-folder-input') as HTMLInputElement;
    await typeInto(input, 'Physics');
    await pressKey(input, 'Enter');
    expect(createFolder).toHaveBeenCalledWith('Physics');
    expect(byTestId('workspace-courses-new-folder-card')).toBeNull();
  });

  it('refuses a name a folder already has, keeping what was typed', async () => {
    const { createFolder } = await renderPage();
    await act(async () => byTestId('workspace-courses-new-folder')!.click());
    const input = byTestId('workspace-courses-new-folder-input') as HTMLInputElement;
    await typeInto(input, 'math');
    await pressKey(input, 'Enter');
    expect(createFolder).not.toHaveBeenCalled();
    expect(byTestId('workspace-courses-new-folder-input-error')?.textContent).toBe(
      'classroom.folderNameExists',
    );
    expect((byTestId('workspace-courses-new-folder-input') as HTMLInputElement).value).toBe('math');
  });
});

describe('a course card’s ⋯', () => {
  it('offers rename, move to folder and delete', async () => {
    await renderPage();
    await openMenu('workspace-courses-more-c1');
    expect(byTestId('workspace-courses-more-c1-rename')).not.toBeNull();
    expect(byTestId('workspace-courses-more-c1-move')).not.toBeNull();
    expect(byTestId('workspace-courses-more-c1-delete')).not.toBeNull();
  });

  it('renames in place through the stage rename route', async () => {
    const { reload } = await renderPage();
    await openMenu('workspace-courses-more-c1');
    await act(async () => byTestId('workspace-courses-more-c1-rename')!.click());
    const input = byTestId('workspace-courses-rename-c1') as HTMLInputElement;
    expect(input.value).toBe('Fractions');
    await typeInto(input, 'Fractions II');
    await pressKey(input, 'Enter');
    expect(renameStage).toHaveBeenCalledWith('c1', 'Fractions II');
    expect(reload).toHaveBeenCalled();
    expect(byTestId('workspace-courses-rename-c1')).toBeNull();
  });

  it('deletes only on the second press', async () => {
    const { onDeleteCourse } = await renderPage();
    await openMenu('workspace-courses-more-c1');
    await act(async () => byTestId('workspace-courses-more-c1-delete')!.click());
    expect(onDeleteCourse).not.toHaveBeenCalled();
    await act(async () => byTestId('workspace-courses-more-c1-confirm-delete')!.click());
    expect(onDeleteCourse).toHaveBeenCalledWith('c1');
  });
});

describe('a folder card’s ⋯', () => {
  it('renames in place', async () => {
    await renderPage();
    await openMenu('workspace-courses-folder-more-f1');
    await act(async () => byTestId('workspace-courses-folder-more-f1-rename')!.click());
    const input = byTestId('workspace-courses-folder-rename-f1') as HTMLInputElement;
    expect(input.value).toBe('Math');
    await typeInto(input, 'Maths');
    await pressKey(input, 'Enter');
    expect(renameFolder).toHaveBeenCalledWith('f1', 'Maths');
  });

  it('asks before deleting, and keeps the folder’s courses', async () => {
    await renderPage();
    await openMenu('workspace-courses-folder-more-f1');
    expect(byTestId('workspace-courses-folder-more-f1-rename')).not.toBeNull();
    await act(async () => byTestId('workspace-courses-folder-more-f1-delete')!.click());
    expect(byTestId('workspace-courses-folder-delete-dialog')).not.toBeNull();
    expect(removeKeepingCourses).not.toHaveBeenCalled();
    await act(async () => byTestId('workspace-courses-folder-delete-confirm')!.click());
    expect(removeKeepingCourses).toHaveBeenCalledWith('f1');
  });
});

describe('dragging courses', () => {
  /** Carry a course card to `target` with the shared pointer gesture. */
  async function carry(courseId: string, target: Element) {
    const card = byTestId(`workspace-courses-card-${courseId}`)!;
    const box = target.getBoundingClientRect();
    const original = document.elementFromPoint;
    document.elementFromPoint = () => target;
    try {
      await act(async () => {
        card.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
        );
        window.dispatchEvent(
          new PointerEvent('pointermove', { clientX: box.left + 1, clientY: box.top + 20 }),
        );
      });
      await act(async () => {
        window.dispatchEvent(
          new PointerEvent('pointerup', { clientX: box.left + 1, clientY: box.top + 20 }),
        );
      });
    } finally {
      document.elementFromPoint = original;
    }
  }

  it('files a course dropped on a folder card', async () => {
    const { moveCourse } = await renderPage();
    await carry('c1', byTestId('workspace-courses-folder-f1')!);
    expect(moveCourse).toHaveBeenCalledExactlyOnceWith('c1', 'f1');
  });

  it('takes a course out of the folder on screen through "All courses"', async () => {
    const { moveCourse } = await renderPage();
    await act(async () => byTestId('workspace-courses-folder-f1')!.click());
    await carry('c2', byTestId('workspace-courses-back')!);
    expect(moveCourse).toHaveBeenCalledExactlyOnceWith('c2', undefined);
  });

  it('shows the way out of the folder only while a course is carried', async () => {
    await renderPage();
    await act(async () => byTestId('workspace-courses-folder-f1')!.click());
    expect(byTestId('workspace-courses-unfile-zone')).toBeNull();
    const card = byTestId('workspace-courses-card-c2')!;
    const zoneTarget = byTestId('workspace-courses-back')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => zoneTarget;
    try {
      await act(async () => {
        card.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
        );
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 30 }));
      });
      expect(byTestId('workspace-courses-unfile-zone')).not.toBeNull();
      await act(async () => window.dispatchEvent(new PointerEvent('pointercancel')));
      expect(byTestId('workspace-courses-unfile-zone')).toBeNull();
    } finally {
      document.elementFromPoint = original;
    }
  });

  it('reorders by dropping beside another card, and remembers the order', async () => {
    const { moveCourse } = await renderPage([
      { id: 'c3', name: 'Geometry', sceneCount: 2, createdAt: 1, updatedAt: 1 },
    ]);
    const order = () =>
      [...document.querySelectorAll<HTMLElement>('[data-testid^="workspace-courses-card-"]')].map(
        (card) => card.dataset.testid,
      );
    // Most recently edited first, with no manual order yet.
    expect(order()).toEqual(['workspace-courses-card-c1', 'workspace-courses-card-c3']);
    // jsdom has no layout: a zero-sized card puts the pointer on its right half.
    await carry('c1', byTestId('workspace-courses-card-c3')!.parentElement!);
    expect(order()).toEqual(['workspace-courses-card-c3', 'workspace-courses-card-c1']);
    expect(moveCourse).not.toHaveBeenCalled();
    // The whole library's sequence, as typed keys: the folder and the filed
    // course keep their places in it.
    expect(JSON.parse(window.localStorage.getItem('openmaic:workspace:course-order')!)).toEqual([
      'folder:f1',
      'course:c2',
      'course:c3',
      'course:c1',
    ]);
  });
});

describe('pinned courses', () => {
  const GUIDE = 'stage-guide-0123456789abcdef';
  const guide = { id: GUIDE, name: 'Getting started', sceneCount: 4, createdAt: 0, updatedAt: 0 };
  const geometry = { id: 'c3', name: 'Geometry', sceneCount: 2, createdAt: 1, updatedAt: 1 };
  const order = () =>
    [...document.querySelectorAll<HTMLElement>('[data-testid^="workspace-courses-card-"]')].map(
      (card) => card.dataset.testid!.replace('workspace-courses-card-', ''),
    );
  const stored = () => window.localStorage.getItem('openmaic:workspace:course-pins');

  it('puts the guide course first by default, marked, without writing anything', async () => {
    await renderPage([guide, geometry]);
    expect(order()).toEqual([GUIDE, 'c1', 'c3']);
    expect(byTestId(`workspace-courses-pinned-${GUIDE}`)).not.toBeNull();
    expect(byTestId('workspace-courses-pinned-c1')).toBeNull();
    expect(stored()).toBeNull();
  });

  it('pins from the card’s ⋯, most recently pinned first, and remembers it', async () => {
    await renderPage([guide, geometry]);
    await openMenu('workspace-courses-more-c3');
    await act(async () => byTestId('workspace-courses-more-c3-pin')!.click());
    expect(order()).toEqual(['c3', GUIDE, 'c1']);
    expect(byTestId('workspace-courses-pinned-c3')).not.toBeNull();
    expect(JSON.parse(stored()!)).toEqual({ pinned: ['course:c3'], unpinned: [] });
  });

  it('remembers that the guide course was unpinned', async () => {
    await renderPage([guide, geometry]);
    await openMenu(`workspace-courses-more-${GUIDE}`);
    await act(async () => byTestId(`workspace-courses-more-${GUIDE}-unpin`)!.click());
    expect(order()).toEqual(['c1', 'c3', GUIDE]);
    expect(byTestId(`workspace-courses-pinned-${GUIDE}`)).toBeNull();
    expect(JSON.parse(stored()!)).toEqual({ pinned: [], unpinned: [`course:${GUIDE}`] });
  });

  it('reads stored pins and prunes the ones whose course is gone', async () => {
    window.localStorage.setItem(
      'openmaic:workspace:course-pins',
      JSON.stringify({ pinned: ['gone', 'c3'], unpinned: [GUIDE] }),
    );
    await renderPage([guide, geometry]);
    expect(order()).toEqual(['c3', 'c1', GUIDE]);
    // Read in the earlier bare-id shape, written back as typed keys.
    expect(JSON.parse(stored()!)).toEqual({
      pinned: ['course:c3'],
      unpinned: [`course:${GUIDE}`],
    });
  });

  it('keeps pinned courses first inside a folder', async () => {
    window.localStorage.setItem(
      'openmaic:workspace:course-pins',
      JSON.stringify({ pinned: ['c4'], unpinned: [] }),
    );
    await renderPage([
      { id: 'c4', name: 'Sonnets', sceneCount: 1, createdAt: 0, updatedAt: 0, folderId: 'f1' },
    ]);
    await act(async () => byTestId('workspace-courses-folder-f1')!.click());
    expect(order()).toEqual(['c4', 'c2']);
  });

  it('keeps matching pinned courses first in search results', async () => {
    window.localStorage.setItem(
      'openmaic:workspace:course-pins',
      JSON.stringify({ pinned: ['c4'], unpinned: [] }),
    );
    await renderPage([
      { id: 'c4', name: 'Fractions II', sceneCount: 1, createdAt: 0, updatedAt: 0 },
    ]);
    await typeInto(byTestId('workspace-courses-search') as HTMLInputElement, 'fractions');
    expect(order()).toEqual(['c4', 'c1']);
  });

  it('does not take a reorder onto a pinned card', async () => {
    await renderPage([guide, geometry]);
    const card = byTestId(`workspace-courses-card-${GUIDE}`)!.parentElement!;
    expect(card.dataset.wsDropKind).toBeUndefined();
    expect(byTestId('workspace-courses-card-c1')!.parentElement!.dataset.wsDropKind).toBe('course');
  });
});

describe('folders and courses as one list', () => {
  const GUIDE = 'stage-guide-0123456789abcdef';
  const keyOf = (card: HTMLElement) => card.dataset.testid!;
  const gridIds = () =>
    [
      ...byTestId('workspace-courses-grid')!.querySelectorAll<HTMLElement>(
        '[data-testid^="workspace-courses-card-"], [data-testid^="workspace-courses-folder-card-"]:not([data-testid$="-pinned"])',
      ),
    ].map((card) => keyOf(card).replace('workspace-courses-', ''));
  const storedOrder = () =>
    JSON.parse(window.localStorage.getItem('openmaic:workspace:course-order') ?? 'null');

  /** Drag `from` and release at `clientX` over `target` (whose box is stubbed). */
  async function dragTo(from: HTMLElement, target: HTMLElement, clientX: number) {
    const original = document.elementFromPoint;
    document.elementFromPoint = () => target;
    try {
      await act(async () => {
        from.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
        );
        window.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY: 20 }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent('pointerup', { clientX, clientY: 20 }));
      });
    } finally {
      document.elementFromPoint = original;
    }
  }
  const stubBox = (element: HTMLElement) => {
    element.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 160, right: 200, bottom: 160 }) as DOMRect;
  };

  it('pins a folder from its ⋯, ahead of the guide course', async () => {
    await renderPage([
      { id: GUIDE, name: 'Getting started', sceneCount: 4, createdAt: 0, updatedAt: 0 },
    ]);
    expect(gridIds()).toEqual(['card-' + GUIDE, 'card-c1', 'folder-card-f1']);
    await openMenu('workspace-courses-folder-more-f1');
    await act(async () => byTestId('workspace-courses-folder-more-f1-pin')!.click());
    expect(gridIds()).toEqual(['folder-card-f1', 'card-' + GUIDE, 'card-c1']);
    expect(byTestId('workspace-courses-folder-card-f1-pinned')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem('openmaic:workspace:course-pins')!)).toEqual({
      pinned: ['folder:f1'],
      unpinned: [],
    });

    await openMenu('workspace-courses-folder-more-f1');
    await act(async () => byTestId('workspace-courses-folder-more-f1-unpin')!.click());
    expect(gridIds()).toEqual(['card-' + GUIDE, 'card-c1', 'folder-card-f1']);
    expect(byTestId('workspace-courses-folder-card-f1-pinned')).toBeNull();
  });

  it('lists matching folders and courses together in a search', async () => {
    await renderPage([
      { id: 'c4', name: 'Math drills', sceneCount: 1, createdAt: 0, updatedAt: 0 },
    ]);
    await typeInto(byTestId('workspace-courses-search') as HTMLInputElement, 'math');
    expect(gridIds()).toEqual(['folder-card-f1', 'card-c4']);
  });

  it('reorders a folder beside a course', async () => {
    await renderPage([{ id: 'c3', name: 'Geometry', sceneCount: 2, createdAt: 1, updatedAt: 0 }]);
    expect(gridIds()).toEqual(['card-c1', 'folder-card-f1', 'card-c3']);
    const folderCard = byTestId('workspace-courses-folder-card-f1')!;
    const c3 = byTestId('workspace-courses-card-c3')!;
    stubBox(c3.parentElement!);
    await dragTo(folderCard, c3, 190);
    expect(gridIds()).toEqual(['card-c1', 'card-c3', 'folder-card-f1']);
    expect(storedOrder()).toEqual(['course:c1', 'course:c2', 'course:c3', 'folder:f1']);
  });

  it('places a course beside a folder from the card’s edge, files it from the middle', async () => {
    const { moveCourse } = await renderPage([
      { id: 'c3', name: 'Geometry', sceneCount: 2, createdAt: 1, updatedAt: 0 },
    ]);
    const c3 = byTestId('workspace-courses-card-c3')!;
    const folderCard = byTestId('workspace-courses-folder-card-f1')!;
    stubBox(folderCard);
    await dragTo(c3, byTestId('workspace-courses-folder-f1')!, 10);
    expect(moveCourse).not.toHaveBeenCalled();
    expect(gridIds()).toEqual(['card-c1', 'card-c3', 'folder-card-f1']);

    await dragTo(c3, byTestId('workspace-courses-folder-f1')!, 100);
    expect(moveCourse).toHaveBeenCalledExactlyOnceWith('c3', 'f1');
  });

  it('never files a folder into a folder', async () => {
    await renderPage();
    const folderCard = byTestId('workspace-courses-folder-card-f1')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => null;
    onTestFinished(() => {
      document.elementFromPoint = original;
    });
    await act(async () => {
      folderCard.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 30 }));
    });
    expect(folderCard.dataset.wsDropFolder).toBeUndefined();
    await act(async () => window.dispatchEvent(new PointerEvent('pointercancel')));
    expect(folderCard.dataset.wsDropFolder).toBe('f1');
  });

  it('still applies an older course-only order to the courses', async () => {
    window.localStorage.setItem('openmaic:workspace:course-order', JSON.stringify(['c3', 'c1']));
    await renderPage([{ id: 'c3', name: 'Geometry', sceneCount: 2, createdAt: 1, updatedAt: 0 }]);
    // The folder is new to that order, so it leads, as anything new does.
    expect(gridIds()).toEqual(['folder-card-f1', 'card-c3', 'card-c1']);
  });
});
