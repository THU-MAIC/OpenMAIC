// @vitest-environment jsdom

/**
 * A surface that stays mounted across course switches must not latch adoption
 * shut.
 *
 * The workbench classroom pane is one component for every course it shows. Its
 * adoption runs once per course, which is right; but leaving a course aborts
 * the loop, and the loop can have clips left in it. If the latch outlives that
 * abort, returning to the course skips exactly the clips the abort cut off —
 * and nothing else ever converts them, because adoption is the only path a
 * finished speech action has.
 *
 * The hook is rendered for real, with the adoption module mocked, because what
 * is being tested is when the hook calls it and when it does not.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adopt: vi.fn(),
}));

vi.mock('@/lib/audio/adopt-cached-narration', () => ({
  adoptCachedNarration: mocks.adopt,
}));

import { useNarrationAdoption } from '@/lib/audio/use-narration-adoption';

interface Props {
  stageId: string | undefined;
  ready: boolean;
  mayGenerate: boolean;
}

function Harness({ stageId, ready, mayGenerate }: Props) {
  useNarrationAdoption(stageId, { ready, mayGenerate });
  return null;
}

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  mocks.adopt.mockReset();
});

function mount(props: Props): { render: (next: Props) => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(Harness, props)));
  return {
    render: (next: Props) => act(() => root.render(createElement(Harness, next))),
  };
}

/** Which courses adoption was asked to run for, in order. */
function adoptedCourses(): string[] {
  return mocks.adopt.mock.calls.map(([stageId]) => stageId as string);
}

describe('narration adoption on a long-lived surface', () => {
  it('adopts once per course load', () => {
    mocks.adopt.mockResolvedValue({ adopted: 1, unbacked: 0 });
    const view = mount({ stageId: 'course-a', ready: true, mayGenerate: true });

    // A re-render that changes nothing must not start a second run.
    view.render({ stageId: 'course-a', ready: true, mayGenerate: true });

    expect(adoptedCourses()).toEqual(['course-a']);
  });

  it('waits for the load and for the ownership answer', () => {
    mocks.adopt.mockResolvedValue({ adopted: 0, unbacked: 0 });
    const view = mount({ stageId: 'course-a', ready: false, mayGenerate: false });
    expect(adoptedCourses()).toEqual([]);

    // Loaded, but the sidecar has not answered yet: the gate fails closed.
    view.render({ stageId: 'course-a', ready: true, mayGenerate: false });
    expect(adoptedCourses()).toEqual([]);

    view.render({ stageId: 'course-a', ready: true, mayGenerate: true });
    expect(adoptedCourses()).toEqual(['course-a']);
  });

  it('aborts the run when the course is left', () => {
    let signal: AbortSignal | undefined;
    mocks.adopt.mockImplementation(async (_stageId: string, given?: AbortSignal) => {
      signal = given;
      return { adopted: 0, unbacked: 0 };
    });
    const view = mount({ stageId: 'course-a', ready: true, mayGenerate: true });
    expect(signal?.aborted).toBe(false);

    view.render({ stageId: 'course-b', ready: true, mayGenerate: false });

    expect(signal?.aborted).toBe(true);
  });

  // The reported sequence: an owned course whose adoption was cut off, a
  // visitor course that never passes the gate, and then back.
  it('finishes an adoption the switch away cut off', () => {
    mocks.adopt.mockResolvedValue({ adopted: 1, unbacked: 2 });
    const view = mount({ stageId: 'course-a', ready: true, mayGenerate: true });

    // A visitor course: it never adopts, so it never latches anything either.
    view.render({ stageId: 'course-b', ready: true, mayGenerate: false });
    expect(adoptedCourses()).toEqual(['course-a']);

    view.render({ stageId: 'course-a', ready: true, mayGenerate: true });

    expect(adoptedCourses()).toEqual(['course-a', 'course-a']);
  });
});
