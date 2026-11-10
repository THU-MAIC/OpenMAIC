// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLearningObservation } from '@/components/scene-renderers/pbl/v3/use-learning-observation';
import type { LearningView } from '@/lib/pbl/v3/types';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement;
let current: ReturnType<typeof useLearningObservation>;
function Hook() {
  const observation = useLearningObservation();
  useEffect(() => {
    current = observation;
  });
  return null;
}
const view = (revision = 1, activitySequence = 1, state = 'running') =>
  ({ id: 'study', revision, activitySequence, evaluation: { state } }) as LearningView;
const workbench = (revision = 1, epoch = 1) =>
  ({ environmentId: 'env', revision, epoch }) as LearningWorkbench;
beforeEach(async () => {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(Hook)));
  await act(async () => current.openView(view()));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('HTTP and SSE observation ordering', () => {
  it('fences duplicate open responses without clearing the live workspace or reopening an old study', async () => {
    await act(async () =>
      current.receive({ view: view(1, 1, 'exited'), workbench: workbench(1, 2) }),
    );
    await act(async () => current.openView(view(), null));
    expect(current.view?.evaluation?.state).toBe('exited');
    expect(current.workbench?.epoch).toBe(2);
    const enteringAnother = current.latestView.current;
    await act(async () => current.receive({ view: view(1, 2), workbench: workbench(1, 3) }));
    await act(async () => current.openView({ ...view(), id: 'next' }, enteringAnother));
    expect(current.view?.id).toBe('next');
    const previous = current.latestView.current;
    await act(async () => current.openView({ ...view(), id: 'other' }));
    await act(async () => current.openView(view(9, 9), previous));
    expect(current.view?.id).toBe('other');
  });

  it('keeps newer SSE execution and workspace state when an equal-counter HTTP response arrives late', async () => {
    const baseline = current.latestView.current;
    let resolve!: (next: LearningView) => void;
    const response = new Promise<LearningView>((done) => {
      resolve = done;
    }).then((next) => current.updateView(next, baseline));
    await act(async () => {
      current.receive({ view: view(1, 1, 'exited'), workbench: workbench(1, 2) });
    });
    await act(async () => {
      resolve(view());
      expect(await response).toBe(false);
    });
    expect(current.view?.evaluation?.state).toBe('exited');
    expect(current.workbench?.epoch).toBe(2);
  });

  it('applies authoritative progress from a command even after an intervening SSE snapshot', async () => {
    const baseline = current.latestView.current;
    await act(async () => current.receive({ view: view(1, 2), workbench: workbench() }));
    await act(async () => expect(current.updateView(view(2, 1), baseline)).toBe(true));
    expect(current.view?.revision).toBe(2);
    await act(async () => current.receive({ view: view(1, 3), workbench: workbench(1, 9) }));
    expect(current.view?.revision).toBe(2);
    expect(current.workbench?.epoch).toBe(1);
  });

  it('rejects older stream activity and workbench state together, but accepts same-counter observations', async () => {
    await act(async () => current.receive({ view: view(1, 3), workbench: workbench(1, 3) }));
    await act(async () => current.receive({ view: view(1, 2), workbench: workbench(1, 2) }));
    expect(current.workbench?.epoch).toBe(3);
    await act(async () =>
      current.receive({ view: view(1, 3, 'exited'), workbench: workbench(1, 4) }),
    );
    expect(current.view?.evaluation?.state).toBe('exited');
    expect(current.workbench?.epoch).toBe(4);
  });

  it('allows a fresh HTTP observation and fences an old study after reopening', async () => {
    await act(async () => expect(current.updateView(view(1, 1, 'exited'))).toBe(true));
    const old = current.latestView.current;
    await act(async () => current.openView({ ...view(), id: 'other' }));
    await act(async () => {
      expect(current.updateView(view(9, 9), old)).toBe(false);
      current.receive({ view: view(9, 9), workbench: workbench(9) });
    });
    expect(current.view?.id).toBe('other');
    expect(current.workbench).toBeNull();
  });
});
