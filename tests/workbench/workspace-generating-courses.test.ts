// @vitest-environment jsdom

/**
 * Courses a classic generation run is still producing, in the Pro workspace's
 * course rail and `@` picker.
 *
 * Such a course is read-only until its run completes. The rail row shows the
 * run's progress where the page count goes, cannot be opened, dragged, renamed
 * or deleted, and is not a drop target; a paused run's row opens the classroom
 * where its Retry lives. When the run leaves the owner's active runs the row is
 * an ordinary one again. The `@` picker never offers such a course, not even
 * the one on screen.
 */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RunSnapshot } from '@/lib/generation-run-client/types';
import { orderCourseMentionCandidates } from '@/lib/workbench/course-mention';
import { RAIL_TAB_STORAGE_KEY } from '@/lib/workbench/workspace-rail-tab';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
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
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const GENERATING = 'stage-generating';
const READY = 'stage-ready';

function runOf(stageId: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: `run-${stageId}`,
    state: 'generating',
    step: null,
    seq: 1,
    input: { requirement: 'A lesson' } as RunSnapshot['input'],
    outline: null,
    agents: null,
    stageId,
    progress: { scenesCompleted: 2, scenesTotal: 8 },
    error: null,
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    ...overrides,
  };
}

const course = (id: string, name: string, sceneCount: number) => ({
  id,
  name,
  sceneCount,
  createdAt: 1,
  updatedAt: 1,
});

async function renderRail(courseRuns: ReadonlyMap<string, RunSnapshot>) {
  const { WorkspaceRail } = await import('@/components/workbench/workspace/WorkspaceRail');
  window.localStorage.setItem(RAIL_TAB_STORAGE_KEY, 'courses');
  const onOpenCourse = vi.fn();
  const container = document.createElement('div');
  container.className = 'ws-root';
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (runs: ReadonlyMap<string, RunSnapshot>) => {
    await act(async () => {
      root.render(
        createElement(WorkspaceRail, {
          courses: {
            classrooms: [course(GENERATING, '劳动节小课', 2), course(READY, '随笔写作入门', 8)],
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
          courseRuns: runs,
          sessions: [],
          sessionState: 'ready',
          onReloadSessions: vi.fn(),
          activeCourseId: null,
          activeSessionId: null,
          collapsed: false,
          onToggleCollapsed: vi.fn(),
          onOpenCourse,
          onOpenSession: vi.fn(),
          onNewSession: vi.fn(),
          onGoHome: vi.fn(),
          onExitPro: vi.fn(),
          onSessionDeleted: vi.fn(),
          onRenameSession: vi.fn(async () => null),
          onDeleteCourse: vi.fn(),
          resizeHandle: null as ReactNode,
        }),
      );
    });
  };
  await render(courseRuns);
  return { onOpenCourse, rerender: render };
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('a course being generated, in the course rail', () => {
  it('shows the run progress instead of the page count, and cannot be opened', async () => {
    const { onOpenCourse } = await renderRail(new Map([[GENERATING, runOf(GENERATING)]]));

    const row = byTestId(`pro-nav-course-${GENERATING}`)!;
    expect(row.dataset.generating).toBe('true');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(byTestId(`pro-nav-course-meta-${GENERATING}`)!.textContent).toBe(
      'classroom.runGenerating:{"completed":2,"total":8}',
    );
    expect(row.querySelector('.animate-spin')).not.toBeNull();
    expect(row.title).toContain('workspace.courseGeneratingRowHint');

    await act(async () => row.click());
    expect(onOpenCourse).not.toHaveBeenCalled();

    // Not draggable, not a drop target, and no rename/delete menu.
    const wrap = row.parentElement!;
    expect(wrap.hasAttribute('data-ws-drop-kind')).toBe(false);
    expect(byTestId(`pro-nav-course-more-${GENERATING}`)).toBeNull();

    // The other course is untouched.
    const ready = byTestId(`pro-nav-course-${READY}`)!;
    expect(ready.getAttribute('aria-disabled')).toBeNull();
    expect(byTestId(`pro-nav-course-meta-${READY}`)!.textContent).toBe(
      'workspace.sceneCount:{"count":8}',
    );
  });

  it('becomes an ordinary row, live, once its run leaves the active runs', async () => {
    const view = await renderRail(new Map([[GENERATING, runOf(GENERATING)]]));
    await view.rerender(new Map());

    const row = byTestId(`pro-nav-course-${GENERATING}`)!;
    expect(row.dataset.generating).toBeUndefined();
    expect(row.getAttribute('aria-disabled')).toBeNull();
    expect(row.parentElement!.getAttribute('data-ws-drop-kind')).toBe('course');
    expect(byTestId(`pro-nav-course-meta-${GENERATING}`)!.textContent).toBe(
      'workspace.sceneCount:{"count":2}',
    );
    await act(async () => row.click());
    expect(view.onOpenCourse).toHaveBeenCalledWith(GENERATING);
  });

  it('shows a paused run as paused, and opens the classroom where its Retry lives', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { onOpenCourse } = await renderRail(
      new Map([[GENERATING, runOf(GENERATING, { state: 'paused' })]]),
    );

    const row = byTestId(`pro-nav-course-${GENERATING}`)!;
    expect(byTestId(`pro-nav-course-meta-${GENERATING}`)!.textContent).toBe('classroom.runPaused');
    expect(row.getAttribute('aria-disabled')).toBeNull();
    await act(async () => row.click());
    expect(onOpenCourse).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(`/classroom/${GENERATING}`, '_blank', 'noopener');
  });
});

describe('the @ picker and a course being generated', () => {
  it('never offers it, not even as the course on screen', () => {
    const candidates = orderCourseMentionCandidates({
      query: '',
      activeCourseId: GENERATING,
      courses: [
        { id: GENERATING, name: '劳动节小课' },
        { id: READY, name: '随笔写作入门' },
      ],
      referencedIds: [],
      excludedIds: new Set([GENERATING]),
      untitled: 'Untitled',
    });
    expect(candidates.map((candidate) => candidate.stageId)).toEqual([READY]);
  });

  it('offers it again once the run is over', () => {
    const candidates = orderCourseMentionCandidates({
      query: '',
      activeCourseId: GENERATING,
      courses: [{ id: GENERATING, name: '劳动节小课' }],
      referencedIds: [],
      excludedIds: new Set(),
      untitled: 'Untitled',
    });
    expect(candidates).toEqual([
      { stageId: GENERATING, title: '劳动节小课', reason: 'open', alreadyReferenced: false },
    ]);
  });
});
