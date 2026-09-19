// @vitest-environment jsdom

/**
 * The edit dock's structure: a global edit bar that never changes, and the
 * narration timeline below it.
 *
 * What is pinned here is what the tab strip used to make fragile — the lasso's
 * ownership gate, the pick-mode cleanup matrix, and the fact that reaching for a
 * global control never disturbs the timeline underneath (an in-flight TTS batch
 * included).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({ timelineMounts: 0 }));
const canvas = vi.hoisted(() => ({
  pickTarget: null as Record<string, unknown> | null,
  spotlight: '',
  laser: '',
  setPickTarget: vi.fn((target: Record<string, unknown> | null) => {
    canvas.pickTarget = target;
  }),
  setSpotlight: vi.fn((elementId: string) => {
    canvas.spotlight = elementId;
  }),
  clearLaser: vi.fn(() => {
    canvas.laser = '';
  }),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: Object.assign(() => canvas.pickTarget, {
    getState: () => canvas,
    use: { pickTarget: () => canvas.pickTarget },
  }),
}));
// The timeline stands in for `ActionsBar`: it owns its header row and a piece of
// state (a running TTS batch) that must survive anything the bar does.
vi.mock('@/components/edit/ActionsBar/ActionsBar', async () => {
  const { createElement: h, useEffect, useState } = await import('react');
  const { useEditDock } = await import('@/components/edit/EditDock/dock-context');
  const ActionsBar = () => {
    const dock = useEditDock();
    const [running, setRunning] = useState(false);
    useEffect(() => {
      lifecycle.timelineMounts += 1;
    }, []);
    return h(
      'div',
      { 'data-testid': 'timeline-body', 'data-collapsed': String(dock.collapsed) },
      h(
        'button',
        { 'data-testid': 'timeline-fold', onClick: dock.toggleCollapsed },
        'edit.timeline.collapseAxis',
      ),
      h(
        'button',
        { 'data-testid': 'tts-batch', onClick: () => setRunning(true), disabled: running },
        running ? 'running' : 'idle',
      ),
    );
  };
  return { ActionsBar };
});
// The roster editor reads the whole stage document; the dock only owes it a mount
// point, so it is stubbed down to a marker.
vi.mock('@/components/edit/AgentsView/RosterDialog', async () => {
  const { createElement: h } = await import('react');
  return {
    RosterDialog: ({ open }: { open: boolean }) =>
      open ? h('div', { 'data-testid': 'roster-dialog' }) : null,
  };
});

import { EditDock } from '@/components/edit/EditDock/EditDock';
import { useStageStore } from '@/lib/store/stage';
import { useElementRefsStore } from '@/lib/store/element-refs';
import { useWorkbenchStore } from '@/lib/workbench/session-store';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  lifecycle.timelineMounts = 0;
  canvas.pickTarget = null;
  canvas.spotlight = '';
  canvas.laser = '';
  useStageStore.setState({ stage: null, scenes: [], currentSceneId: null });
  useWorkbenchStore.setState({ sessionId: null, stageId: null });
  useElementRefsStore.getState().detachOwner();
  vi.clearAllMocks();
});

async function unmountDock() {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
}

async function renderDock({
  sessionId = 'session-a',
  sessionStageId = 'stage-1',
  currentStageId = 'stage-1',
  sceneType = 'slide',
  // Set so the terminal-status case can prove the lasso ignores it.
  status = 'running',
}: {
  sessionId?: string | null;
  sessionStageId?: string | null;
  currentStageId?: string;
  sceneType?: string;
  status?: string;
} = {}) {
  useStageStore.setState({ stage: { id: currentStageId } as never });
  useWorkbenchStore.setState({ sessionId, stageId: sessionStageId, status: status as never });
  // The composer that would receive the pills. In the workspace the chat pane is
  // mounted whenever the store holds a session (`chatMounted`), and mounting it is
  // what claims the reference draft — the lasso is only painted for that owner.
  if (sessionId) useElementRefsStore.getState().attachOwner(sessionId);
  else useElementRefsStore.getState().detachOwner();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(EditDock, { sceneId: 'scene-1', sceneType: sceneType as never }));
  });
  return container;
}

async function click(target: Element | null) {
  if (!(target instanceof HTMLElement)) throw new Error('missing click target');
  await act(async () => target.click());
}

describe('EditDock structure', () => {
  it('mounts the timeline as the dock body, under a global edit bar', async () => {
    const host = await renderDock();

    expect(host.querySelector('[data-testid="edit-dock-bar"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="timeline-body"]')).not.toBeNull();
    // No tab strip: the timeline is the only body, and nothing hides it.
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(lifecycle.timelineMounts).toBe(1);
  });

  it('offers the roster on every scene type, from the bar', async () => {
    const host = await renderDock({ sceneType: 'quiz' });

    expect(host.querySelector('[data-testid="edit-dock-roster"]')).not.toBeNull();
    await click(host.querySelector('[data-testid="edit-dock-roster"]'));
    expect(host.querySelector('[data-testid="roster-dialog"]')).not.toBeNull();
  });
});

describe('EditDock lasso availability', () => {
  it('shows the lasso on a slide, whatever the agent is doing with the course', async () => {
    // Picking elements is a human authoring gesture: it stages pills in the
    // composer and writes nothing. So a slide plus a conversation is the whole
    // condition — no ownership, no run status.
    const own = await renderDock();
    expect(own.querySelector('[data-testid="element-ref-arm"]')).not.toBeNull();
  });

  it('shows the same lasso on an interactive scene', async () => {
    const host = await renderDock({ sceneType: 'interactive' });
    expect(host.querySelector('[data-testid="element-ref-arm"]')).not.toBeNull();
  });

  it('shows the lasso on a course the run never linked or touched', async () => {
    // Reached through read-only tools (search / read_classroom), so the course is
    // in neither `stageLinkStageIds` nor `touchedStageIds` — the old gate hid the
    // lasso here, which is one half of why it never appeared.
    const host = await renderDock({
      sessionStageId: 'stage-placeholder',
      currentStageId: 'stage-unrelated',
    });

    expect(host.querySelector('[data-testid="element-ref-arm"]')).not.toBeNull();
  });

  it('keeps the lasso after the run finishes — the case the feature exists for', async () => {
    // `agentOwnsPaneCourse` releases ownership on a terminal status, so the old
    // gate made the lasso vanish exactly when the user sat down to edit the deck
    // the agent had just built.
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      const host = await renderDock({ status });
      expect(
        host.querySelector('[data-testid="element-ref-arm"]'),
        `terminal status ${status} must not hide the lasso`,
      ).not.toBeNull();
      await unmountDock();
    }
  });

  it('hides the lasso with no conversation to hand references to', async () => {
    // Not an ownership claim: with no chat there is no next message and no
    // composer to render the pills in, so the gesture would go nowhere.
    const host = await renderDock({ sessionId: null, sessionStageId: null });

    expect(host.querySelector('[data-testid="element-ref-arm"]')).toBeNull();
  });

  it('hides the lasso on a scene type with no canvas elements', async () => {
    const host = await renderDock({ sceneType: 'quiz' });

    expect(host.querySelector('[data-testid="element-ref-arm"]')).toBeNull();
  });
});

describe('EditDock pick-mode cleanup', () => {
  // The criterion is the (chat, course, page) identity a pick was armed for.
  // Switching any of the three disarms what the previous one left behind — the
  // invariants cr pinned, now that "the agent stopped owning this" is gone.
  it('disarms a lasso left armed by another session (chat switch)', async () => {
    canvas.pickTarget = {
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      ownerSessionId: 'session-old',
    };

    await renderDock({ sessionId: 'session-a' });

    expect(canvas.setPickTarget).toHaveBeenCalledWith(null);
    expect(canvas.pickTarget).toBeNull();
  });

  it('disarms a lasso armed for another page of the same course (page switch)', async () => {
    canvas.pickTarget = {
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: 'scene-9',
      ownerSessionId: 'session-a',
    };

    await renderDock({ sessionId: 'session-a' });

    expect(canvas.pickTarget).toBeNull();
  });

  it('disarms a lasso armed for a different course (course switch)', async () => {
    // The pick was staged on another deck; the dock now shows `stage-2`, so the
    // stale target must not survive into it.
    canvas.pickTarget = {
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      ownerSessionId: 'session-a',
    };

    await renderDock({ sessionId: 'session-a', currentStageId: 'stage-2' });

    expect(canvas.pickTarget).toBeNull();
  });

  it('leaves a matching lasso alone, whatever the session status', async () => {
    canvas.pickTarget = {
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      ownerSessionId: 'session-a',
    };
    // A finished run no longer disarms the human's pick mode.
    await renderDock({ sessionId: 'session-a', status: 'succeeded' });
    expect(canvas.pickTarget).not.toBeNull();
  });

  it('leaves a timeline cue pick alone', async () => {
    // A cue pick belongs to the timeline; the dock has no business clearing it.
    canvas.setPickTarget.mockClear();
    canvas.pickTarget = { purpose: 'cue', actionId: 'spotlight-1' };
    await renderDock({ sessionId: 'session-b' });
    expect(canvas.setPickTarget).not.toHaveBeenCalled();
    expect(canvas.pickTarget).toMatchObject({ purpose: 'cue' });
  });
});

describe('EditDock fold', () => {
  it('keeps the global edit bar while the timeline is folded, at the fixed height', async () => {
    const host = await renderDock();
    const section = host.querySelector('[data-testid="edit-dock"]') as HTMLElement;
    // 224 timeline + 36 bar. The height is FIXED: the height-drag handle above
    // the bar was removed (owner decision), so only the fold moves it.
    expect(section.style.height).toBe('260px');
    expect(section.querySelector('.cursor-row-resize')).toBeNull();

    await click(host.querySelector('[data-testid="timeline-fold"]'));
    // 86 collapsed timeline + 36 bar: folding never folds the bar away.
    expect(section.style.height).toBe('122px');
    expect(host.querySelector('[data-testid="edit-dock-bar"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="edit-dock-roster"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="element-ref-arm"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="timeline-body"]')?.getAttribute('data-collapsed'),
    ).toBe('true');

    await click(host.querySelector('[data-testid="timeline-fold"]'));
    expect(section.style.height).toBe('260px');
  });

  it('never remounts the timeline for a global control, batch in flight included', async () => {
    const host = await renderDock();
    await click(host.querySelector('[data-testid="tts-batch"]'));

    await click(host.querySelector('[data-testid="element-ref-arm"]'));
    await click(host.querySelector('[data-testid="edit-dock-roster"]'));
    await click(host.querySelector('[data-testid="timeline-fold"]'));
    await click(host.querySelector('[data-testid="timeline-fold"]'));

    expect(host.querySelector('[data-testid="tts-batch"]')?.textContent).toBe('running');
    expect(lifecycle.timelineMounts).toBe(1);
  });
});
