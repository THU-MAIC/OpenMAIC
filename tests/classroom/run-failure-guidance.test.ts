// @vitest-environment jsdom

/**
 * The classroom of a course a paused run produced: the run's failure
 * (`useRunCourse().failure`) reaches the stage as the provider quota guidance
 * only while the pending scene card is the scene the run stopped at. A scene
 * the run went on past keeps the generic failure text.
 */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunCourseFailure } from '@/lib/generation-run-client/use-run-course';
import type { SceneOutline } from '@/lib/types/generation';

const run = vi.hoisted(() => ({
  failure: null as RunCourseFailure | null,
  /** The outlines not produced yet: the first is the pending scene card. */
  generatingOutlines: [] as SceneOutline[],
  stageProps: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/stage', () => ({
  Stage: (props: Record<string, unknown>) => {
    run.stageProps = props;
    return createElement('div', { 'data-testid': 'stage' });
  },
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
      stage: { id: deps.classroomId, name: 'Paused course' } as never,
      generatingOutlines: run.generatingOutlines,
    });
    deps.setLoading(false);
    return { outcome: 'ready' };
  },
}));
vi.mock('@/lib/generation-run-client/use-run-course', () => ({
  useRunCourse: () => ({
    runId: 'run-1',
    generation: { status: { kind: 'paused' }, href: '/classroom/stage-paused' },
    failure: run.failure,
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
  run.failure = null;
  run.generatingOutlines = [];
  run.stageProps = null;
});

function outline(order: number): SceneOutline {
  return { id: `o${order}`, type: 'slide', title: `Scene ${order}`, order } as SceneOutline;
}

/** Paused at scene 3 (outline o4) on the provider's quota. */
function failure(patch: Partial<RunCourseFailure> = {}): RunCourseFailure {
  return {
    step: 'scene:3:actions',
    message: 'insufficient balance',
    errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
    outlineId: 'o4',
    ...patch,
  };
}

async function renderClassroom() {
  const { ClassroomSurface } = await import('@/components/classroom/ClassroomSurface');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(ClassroomSurface, { classroomId: 'stage-paused', variant: 'page' }),
      );
    });
  };
  await render();
  expect(run.stageProps).not.toBeNull();
  return { rerender: render };
}

describe('a paused run’s failure, in its classroom', () => {
  it('gives the pending card of the scene the run stopped at the quota guidance', async () => {
    run.failure = failure();
    run.generatingOutlines = [outline(4)];
    await renderClassroom();

    expect(run.stageProps?.generationFailureMessage).toBe('generation.quotaExhausted');
  });

  it('keeps the generic text on a scene the run went on past', async () => {
    // Scene 1 (o2) failed earlier and was skipped: its card is the pending one.
    run.failure = failure();
    run.generatingOutlines = [outline(2), outline(4)];
    await renderClassroom();

    expect(run.stageProps?.generationFailureMessage).toBeUndefined();
  });

  it.each<[string, Partial<RunCourseFailure>]>([
    ['an ordinary failure', { errorCode: 'RATE_LIMITED', statusCode: 429 }],
    ['the host’s own quota code', { errorCode: 'QUOTA_EXHAUSTED' }],
    ['a stop outside the scenes', { step: 'agents', outlineId: null }],
  ])('gives the stage nothing for %s', async (_case, patch) => {
    run.failure = failure(patch);
    run.generatingOutlines = [outline(4)];
    await renderClassroom();

    expect(run.stageProps?.generationFailureMessage).toBeUndefined();
  });

  it('clears the guidance once the run proceeds', async () => {
    run.failure = failure();
    run.generatingOutlines = [outline(4)];
    const view = await renderClassroom();
    expect(run.stageProps?.generationFailureMessage).toBe('generation.quotaExhausted');

    run.failure = null;
    await view.rerender();
    expect(run.stageProps?.generationFailureMessage).toBeUndefined();
  });
});
