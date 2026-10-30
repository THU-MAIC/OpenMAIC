// @vitest-environment jsdom

/**
 * My courses is the library's one home in the workspace — the rail lists chats
 * only. Everything the rail's old course tree offered is pinned here: a
 * course's ⋯ renames in place, files into a folder and deletes after a second
 * press; a folder's ⋯ renames and deletes (keeping its courses) after a
 * question.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/components/workbench/workspace/workspace-folder-seam', () => ({
  workspaceFoldersAvailable: () => true,
  workspaceFolderAdapter: {
    create: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
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
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function renderPage() {
  const onDeleteCourse = vi.fn();
  const reload = vi.fn(async () => undefined);
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
          ],
          state: 'ready',
          reload,
          importInput: null,
          triggerImport: vi.fn(),
          importing: false,
          discoveryContent: null,
          folders: [{ id: 'f1', name: 'Math' }],
          openNewFolder: vi.fn(),
          moveCourse: vi.fn(),
          createAndMove: () => () => {},
          deleteCourse: vi.fn(async () => true),
        } as never,
        courseRuns: new Map(),
        pendingRuns: [],
        onOpenCourse: vi.fn(),
        onDeleteCourse,
      }),
    );
  });
  return { onDeleteCourse, reload };
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
    const input = byTestId('workspace-courses-rename-c1-input') as HTMLInputElement;
    expect(input.value).toBe('Fractions');
    await typeInto(input, 'Fractions II');
    await act(async () => {
      byTestId('workspace-courses-rename-c1')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
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
