// @vitest-environment jsdom

/**
 * Courses a classic generation run is still producing, on the workspace's My
 * courses page and in the `@` picker.
 *
 * Such a course is read-only until its run completes. Its card shows the run's
 * progress, cannot be opened and carries no ⋯ (no rename, filing or delete); a
 * paused run's card opens the classroom where its Retry lives. When the run
 * leaves the owner's active runs the card is an ordinary one again. The `@`
 * picker never offers such a course, not even the one on screen.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { RunSnapshot } from '@/lib/generation-run-client/types';
import { orderCourseMentionCandidates } from '@/lib/workbench/course-mention';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('@/lib/hooks/use-course-thumbnails', () => ({
  useCourseThumbnails: () => ({
    thumbnails: {},
    requestThumbnail: () => () => {},
    retainThumbnails: () => {},
  }),
}));
vi.mock('@/lib/hooks/use-near-viewport', () => ({ useNearViewport: () => false }));

const roots: Root[] = [];

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Load the page once per file, outside any test's time budget: its first import
// transforms a large module graph, which can take longer than the 5 s test
// timeout on a loaded CI runner.
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

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
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

interface PageState {
  readonly classrooms?: ReadonlyArray<ReturnType<typeof course>>;
  readonly pendingRuns?: readonly RunSnapshot[];
}

const DEFAULT_CLASSROOMS = [course(GENERATING, '劳动节小课', 2), course(READY, '随笔写作入门', 8)];

async function renderPage(courseRuns: ReadonlyMap<string, RunSnapshot>, initial: PageState = {}) {
  const onOpenCourse = vi.fn();
  const onDiscardRun = vi.fn();
  const container = document.createElement('div');
  container.className = 'ws-root';
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (runs: ReadonlyMap<string, RunSnapshot>, state: PageState = {}) => {
    await act(async () => {
      root.render(
        createElement(WorkspaceCoursesPage, {
          courses: {
            classrooms: state.classrooms ?? DEFAULT_CLASSROOMS,
            state: 'ready',
            reload: vi.fn(),
            importInput: null,
            triggerImport: vi.fn(),
            importing: false,
            folders: [],
            moveCourse: vi.fn(),
            deleteCourse: vi.fn(async () => true),
          } as never,
          courseRuns: runs,
          pendingRuns: state.pendingRuns ?? [],
          onOpenCourse,
          onDeleteCourse: vi.fn(),
          onDiscardRun,
        }),
      );
    });
  };
  await render(courseRuns, initial);
  return { onOpenCourse, onDiscardRun, rerender: render };
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('a course being generated, on My courses', () => {
  it('shows the run progress, cannot be opened and has no ⋯', async () => {
    const { onOpenCourse } = await renderPage(new Map([[GENERATING, runOf(GENERATING)]]));

    const card = byTestId(`workspace-courses-card-${GENERATING}`)!;
    expect(card.dataset.generating).toBe('true');
    expect(card.getAttribute('aria-disabled')).toBe('true');
    expect(card.querySelector('.ws-course-card-status')!.textContent).toBe(
      'classroom.runGenerating:{"completed":3,"total":8}',
    );
    await act(async () => card.click());
    expect(onOpenCourse).not.toHaveBeenCalled();
    expect(byTestId(`workspace-courses-more-${GENERATING}`)).toBeNull();

    // The other course is untouched.
    const ready = byTestId(`workspace-courses-card-${READY}`)!;
    expect(ready.getAttribute('aria-disabled')).toBeNull();
    expect(ready.textContent).toContain('workspace.sceneCount:{"count":8}');
    expect(byTestId(`workspace-courses-more-${READY}`)).not.toBeNull();
  });

  it('becomes an ordinary card, live, once its run leaves the active runs', async () => {
    const view = await renderPage(new Map([[GENERATING, runOf(GENERATING)]]));
    await view.rerender(new Map());

    const card = byTestId(`workspace-courses-card-${GENERATING}`)!;
    expect(card.dataset.generating).toBeUndefined();
    expect(card.getAttribute('aria-disabled')).toBeNull();
    expect(byTestId(`workspace-courses-more-${GENERATING}`)).not.toBeNull();
    await act(async () => card.click());
    expect(view.onOpenCourse).toHaveBeenCalledWith(GENERATING);
  });

  it('shows a paused run as paused, and opens the classroom where its Retry lives', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { onOpenCourse } = await renderPage(
      new Map([[GENERATING, runOf(GENERATING, { state: 'paused' })]]),
    );

    const card = byTestId(`workspace-courses-card-${GENERATING}`)!;
    expect(card.querySelector('.ws-course-card-status')!.textContent).toBe('classroom.runPaused');
    expect(card.getAttribute('aria-disabled')).toBeNull();
    await act(async () => card.click());
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

describe('a run whose course does not exist yet, on My courses', () => {
  const NEW = 'stage-new';
  const pending = runOf(NEW, {
    id: 'run-new',
    stageId: null,
    state: 'outlining',
    input: { requirement: '劳动节放假快乐小课' } as RunSnapshot['input'],
    progress: { scenesCompleted: 0, scenesTotal: 0 },
  });
  const cardIds = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid^="workspace-courses-card-"], [data-testid^="workspace-courses-run-"]',
      ),
    ]
      .map((card) => card.dataset.testid!)
      .filter((id) => !id.startsWith('workspace-courses-run-more-'));

  it('is a placeholder card ahead of the courses, titled as the home card, and discardable', async () => {
    const view = await renderPage(new Map(), { pendingRuns: [pending] });

    const card = byTestId('workspace-courses-run-run-new')!;
    expect(card.textContent).toContain('劳动节放假快乐小课');
    expect(card.textContent).toContain('classroom.runOutlining');
    expect(cardIds()).toEqual([
      'workspace-courses-run-run-new',
      `workspace-courses-card-${GENERATING}`,
      `workspace-courses-card-${READY}`,
    ]);
    expect(byTestId('workspace-courses-run-more-run-new')).not.toBeNull();
    expect(view.onDiscardRun).not.toHaveBeenCalled();
  });

  it('opens what the home card opens: the run preview, in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { onOpenCourse } = await renderPage(new Map(), { pendingRuns: [pending] });
    await act(async () => byTestId('workspace-courses-run-run-new')!.click());
    expect(open).toHaveBeenCalledWith('/generation-preview?run=run-new', '_blank', 'noopener');
    expect(onOpenCourse).not.toHaveBeenCalled();
  });

  it('becomes the course card once the course is listed, then an ordinary one', async () => {
    const view = await renderPage(new Map(), { pendingRuns: [pending] });

    const withCourse = { ...pending, stageId: NEW, state: 'generating' as const };
    const listed = [course(NEW, '劳动节放假快乐小课', 1), ...DEFAULT_CLASSROOMS];
    await view.rerender(new Map([[NEW, withCourse]]), { classrooms: listed, pendingRuns: [] });
    expect(cardIds()).toEqual([
      `workspace-courses-card-${NEW}`,
      `workspace-courses-card-${GENERATING}`,
      `workspace-courses-card-${READY}`,
    ]);
    expect(byTestId(`workspace-courses-card-${NEW}`)!.dataset.generating).toBe('true');

    await view.rerender(new Map(), { classrooms: listed, pendingRuns: [] });
    expect(byTestId(`workspace-courses-card-${NEW}`)!.dataset.generating).toBeUndefined();
  });

  it('disappears when the run ends without a course', async () => {
    const view = await renderPage(new Map(), { pendingRuns: [pending] });
    await view.rerender(new Map(), { pendingRuns: [] });
    expect(byTestId('workspace-courses-run-run-new')).toBeNull();
  });
});
