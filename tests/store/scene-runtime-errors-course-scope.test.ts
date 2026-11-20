// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  useRuntimeErrorsScopedToCourse,
  useSceneRuntimeErrors,
} from '@/lib/store/scene-runtime-errors';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Classroom({ courseId }: { courseId: string | undefined }) {
  useRuntimeErrorsScopedToCourse(courseId);
  return null;
}

let root: Root | null = null;

async function render(courseId: string | undefined) {
  root ??= createRoot(document.createElement('div'));
  await act(async () => root?.render(createElement(Classroom, { courseId })));
}

describe('runtime errors scoped to the classroom course', () => {
  beforeEach(() => useSceneRuntimeErrors.setState({ errors: {} }));
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  it('starts a classroom from what its pages report now, not from an earlier visit', async () => {
    useSceneRuntimeErrors.getState().addError('scene-a', '[error] seen last visit');
    await render('course-1');
    expect(useSceneRuntimeErrors.getState().errors).toEqual({});
  });

  it('keeps the errors while the course stays and drops them when another course takes over', async () => {
    await render('course-1');
    await act(async () => {
      useSceneRuntimeErrors.getState().addError('scene-a', '[error] boom');
    });
    await render('course-1');
    expect(useSceneRuntimeErrors.getState().errors).toEqual({ 'scene-a': ['[error] boom'] });

    await render('course-2');
    expect(useSceneRuntimeErrors.getState().errors).toEqual({});
  });
});
