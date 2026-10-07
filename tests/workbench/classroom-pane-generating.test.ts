// @vitest-environment jsdom

/**
 * The workspace's classroom pane for a course its generation run is still
 * producing.
 *
 * The pane is edit-locked, and a course being generated is read-only until its
 * run completes, so the edit chrome never resolved and the pane stayed blank.
 * It now shows the generating placeholder (with the run's progress and where to
 * follow it) and swaps to the course by itself once the run is over. The
 * standalone classroom page keeps showing the classroom itself, which follows
 * the run there.
 */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CourseRunStatus } from '@/lib/generation-run-client/course-card';

const run = vi.hoisted(() => ({
  generation: null as { status: CourseRunStatus; href: string } | null,
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('@/components/stage', () => ({
  Stage: () => createElement('div', { 'data-testid': 'stage' }),
}));
vi.mock('@/lib/hooks/use-theme', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/contexts/media-stage-context', () => ({
  MediaStageProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/audio/use-narration-adoption', () => ({ useNarrationAdoption: () => {} }));
vi.mock('@/lib/classroom/use-classroom-session', () => {
  const session = { mayGenerate: true, refreshOwnership: () => {} };
  return { useClassroomSession: () => session };
});
vi.mock('@/lib/classroom/load-classroom', () => ({
  defaultClassroomLoadDeps: {},
  runClassroomLoad: async (deps: { classroomId: string; setLoading: (value: boolean) => void }) => {
    const { useStageStore } = await import('@/lib/store/stage');
    useStageStore.setState({
      stage: { id: deps.classroomId, name: 'Generating course' } as never,
    });
    deps.setLoading(false);
    return { outcome: 'ready' };
  },
}));
vi.mock('@/lib/generation-run-client/use-run-course', () => ({
  useRunCourse: () => ({
    runId: run.generation ? 'run-1' : null,
    generation: run.generation,
    retryOutline: async () => {},
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  run.generation = null;
});

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function renderSurface(variant: 'page' | 'pane') {
  const { ClassroomSurface } = await import('@/components/classroom/ClassroomSurface');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async () => {
    await act(async () => {
      root.render(createElement(ClassroomSurface, { classroomId: 'stage-gen', variant }));
    });
  };
  await render();
  return { rerender: render };
}

describe('a course being generated, in the classroom pane', () => {
  it('shows the generating placeholder with progress instead of a blank pane', async () => {
    run.generation = {
      status: { kind: 'generating', completed: 2, total: 8 },
      href: '/classroom/stage-gen',
    };
    await renderSurface('pane');

    const placeholder = byTestId('course-generating-placeholder');
    expect(placeholder).not.toBeNull();
    expect(placeholder!.textContent).toContain('workspace.courseGeneratingTitle');
    expect(byTestId('course-generating-progress')!.textContent).toBe(
      'classroom.runGenerating:{"completed":2,"total":8}',
    );
    const link = byTestId('course-generating-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/classroom/stage-gen');
    expect(link.target).toBe('_blank');
    expect(byTestId('stage')).toBeNull();
  });

  it('swaps to the course by itself when the run completes', async () => {
    run.generation = {
      status: { kind: 'generating', completed: 7, total: 8 },
      href: '/classroom/stage-gen',
    };
    const view = await renderSurface('pane');
    expect(byTestId('course-generating-placeholder')).not.toBeNull();

    run.generation = null;
    await view.rerender();

    expect(byTestId('course-generating-placeholder')).toBeNull();
    expect(byTestId('stage')).not.toBeNull();
  });

  it('says a paused run is paused, and links to where its Retry lives', async () => {
    run.generation = { status: { kind: 'paused' }, href: '/classroom/stage-gen' };
    await renderSurface('pane');

    const placeholder = byTestId('course-generating-placeholder')!;
    expect(placeholder.dataset.runState).toBe('paused');
    expect(placeholder.textContent).toContain('workspace.coursePausedTitle');
    expect(byTestId('course-generating-link')!.textContent).toContain('workspace.openToRetry');
  });

  it('leaves the standalone classroom page as it was: it follows the run itself', async () => {
    run.generation = {
      status: { kind: 'generating', completed: 2, total: 8 },
      href: '/classroom/stage-gen',
    };
    await renderSurface('page');

    expect(byTestId('course-generating-placeholder')).toBeNull();
    expect(byTestId('stage')).not.toBeNull();
  });
});
