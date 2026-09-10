// @vitest-environment jsdom

/**
 * The lasso button, on real stores.
 *
 * Two things are pinned: the Cursor-style toggle (press to arm, press again or Esc
 * to leave, references land in the composer's list rather than in a panel here),
 * and the OWNER FENCE — during a direct navigation from chat A to chat B, nothing
 * of A's draft may be shown or acted on, not even for the one render before B's
 * attach effect runs.
 */
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElementRefLassoButton } from '@/components/edit/EditDock/ElementRefLassoButton';
import { useCanvasStore } from '@/lib/store/canvas';
import { useElementRefsOwnerLifecycle, useElementRefsStore } from '@/lib/store/element-refs';
import { useStageStore } from '@/lib/store/stage';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import type { ElementRef } from '@/lib/workbench/element-refs';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const oldRef: ElementRef = {
  kind: 'slide-element',
  stageId: 'stage-1',
  sceneId: 'scene-1',
  elementId: 'title-1',
  elementType: 'text',
  label: '会话 A 的标题',
};

let root: Root | null = null;

function ChatOwner() {
  const sessionId = useWorkbenchStore((state) => state.sessionId);
  useElementRefsOwnerLifecycle(sessionId);
  return null;
}

function seedSlideCourse() {
  useStageStore.setState({
    stage: { id: 'stage-1' } as never,
    scenes: [
      {
        id: 'scene-1',
        stageId: 'stage-1',
        type: 'slide',
        content: { type: 'slide', canvas: { elements: [] } },
      } as never,
    ],
    currentSceneId: 'scene-1',
  });
}

function mount(children: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root?.render(children));
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  useCanvasStore.getState().resetCanvasState();
  useStageStore.setState({ stage: null, scenes: [], currentSceneId: null });
  useWorkbenchStore.setState({ sessionId: null, stageId: null });
  useElementRefsStore.setState({
    ownerSessionId: null,
    refs: [],
    hovered: null,
    nextGeneration: 1,
  });
  document.body.innerHTML = '';
});

describe('element reference lasso', () => {
  it('arms the canvas for this page, leaves on a second press, and leaves on Esc', async () => {
    seedSlideCourse();
    useWorkbenchStore.setState({ sessionId: 'session-a', stageId: 'stage-1' });
    const host = mount(
      createElement(
        Fragment,
        null,
        createElement(ChatOwner),
        createElement(ElementRefLassoButton, { sceneId: 'scene-1' }),
      ),
    );
    await act(async () => undefined);
    const button = host.querySelector('[data-testid="element-ref-arm"]') as HTMLElement;
    expect(button.getAttribute('aria-pressed')).toBe('false');

    await act(async () => button.click());
    expect(useCanvasStore.getState().pickTarget).toMatchObject({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      ownerSessionId: 'session-a',
    });
    expect(button.getAttribute('aria-pressed')).toBe('true');

    await act(async () => button.click());
    expect(useCanvasStore.getState().pickTarget).toBeNull();

    await act(async () => button.click());
    expect(useCanvasStore.getState().pickTarget).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useCanvasStore.getState().pickTarget).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('arms the lasso across courses: the session-bound stage may differ from the displayed one', async () => {
    // The chat session is bound to course `stage-2`, but the classroom pane
    // shows course `stage-1`. The lasso arms against the DISPLAYED course — it
    // must not be gated on the session's bound stage, or the button could never
    // light up for a course other than the one the chat is attached to.
    seedSlideCourse();
    useWorkbenchStore.setState({ sessionId: 'session-a', stageId: 'stage-2' });
    const host = mount(
      createElement(
        Fragment,
        null,
        createElement(ChatOwner),
        createElement(ElementRefLassoButton, { sceneId: 'scene-1' }),
      ),
    );
    await act(async () => undefined);
    const button = host.querySelector('[data-testid="element-ref-arm"]') as HTMLElement;
    await act(async () => button.click());

    expect(useCanvasStore.getState().pickTarget).toMatchObject({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      ownerSessionId: 'session-a',
    });
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('takes the canvas from a timeline cue pick and clears its live preview', async () => {
    seedSlideCourse();
    useWorkbenchStore.setState({ sessionId: 'session-a', stageId: 'stage-1' });
    useCanvasStore.getState().setPickTarget({
      purpose: 'cue',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      actionId: 'spotlight-1',
      cueType: 'spotlight',
    });
    useCanvasStore.getState().setSpotlight('title-1');

    const host = mount(
      createElement(
        Fragment,
        null,
        createElement(ChatOwner),
        createElement(ElementRefLassoButton, { sceneId: 'scene-1' }),
      ),
    );
    await act(async () => undefined);
    await act(async () =>
      (host.querySelector('[data-testid="element-ref-arm"]') as HTMLElement).click(),
    );

    expect(useCanvasStore.getState().pickTarget).toMatchObject({ purpose: 'element-ref' });
    expect(useCanvasStore.getState().spotlightElementId).toBe('');
  });

  it('is not painted at all while no chat owns the reference draft', async () => {
    seedSlideCourse();
    useWorkbenchStore.setState({ sessionId: 'session-a', stageId: 'stage-1' });
    // No `ChatOwner`: the element-refs store has no owner, so a reference staged
    // now would belong to nobody — and a button that cannot act must not be drawn.
    const host = mount(createElement(ElementRefLassoButton, { sceneId: 'scene-1' }));
    await act(async () => undefined);

    expect(host.querySelector('[data-testid="element-ref-arm"]')).toBeNull();
    expect(useCanvasStore.getState().pickTarget).toBeNull();
  });

  it('disappears — rather than going dead — when the chat unmounts under a live session id', async () => {
    seedSlideCourse();
    useWorkbenchStore.setState({ sessionId: 'session-a', stageId: 'stage-1' });
    const host = mount(
      createElement(
        Fragment,
        null,
        createElement(ChatOwner),
        createElement(ElementRefLassoButton, { sceneId: 'scene-1' }),
      ),
    );
    await act(async () => undefined);
    expect(host.querySelector('[data-testid="element-ref-arm"]')).not.toBeNull();

    // Leaving `/workspace` for a standalone `/classroom/<id>` (the discover feed
    // does exactly this): the chat unmounts and releases the draft, while the
    // workbench store keeps the session id across the client-side navigation.
    await act(async () => {
      root?.render(createElement(ElementRefLassoButton, { sceneId: 'scene-1' }));
    });
    expect(useWorkbenchStore.getState().sessionId).toBe('session-a');
    expect(useElementRefsStore.getState().ownerSessionId).toBeNull();
    expect(host.querySelector('[data-testid="element-ref-arm"]')).toBeNull();
  });

  it('keeps the way out of picking when ownership drops mid-pick', async () => {
    seedSlideCourse();
    useWorkbenchStore.setState({ sessionId: 'session-a', stageId: 'stage-1' });
    const host = mount(
      createElement(
        Fragment,
        null,
        createElement(ChatOwner),
        createElement(ElementRefLassoButton, { sceneId: 'scene-1' }),
      ),
    );
    await act(async () => undefined);
    await act(async () =>
      (host.querySelector('[data-testid="element-ref-arm"]') as HTMLElement).click(),
    );
    expect(useCanvasStore.getState().pickTarget).not.toBeNull();

    await act(async () => useElementRefsStore.getState().detachOwner());
    const button = host.querySelector('[data-testid="element-ref-arm"]') as HTMLElement;
    expect(button).not.toBeNull();
    await act(async () => button.click());
    expect(useCanvasStore.getState().pickTarget).toBeNull();
  });

  it('counts only the owning chat’s references', async () => {
    seedSlideCourse();
    useWorkbenchStore.setState({ sessionId: 'session-a', stageId: 'stage-1' });
    const host = mount(
      createElement(
        Fragment,
        null,
        createElement(ChatOwner),
        createElement(ElementRefLassoButton, { sceneId: 'scene-1' }),
      ),
    );
    await act(async () => undefined);
    expect(host.querySelector('[data-testid="element-ref-count"]')).toBeNull();

    await act(async () => useElementRefsStore.getState().add(oldRef));
    expect(host.querySelector('[data-testid="element-ref-count"]')?.textContent).toBe('1');
  });

  it('never shows or acts on session A during a direct navigation to B', async () => {
    seedSlideCourse();
    const refs = useElementRefsStore.getState();
    refs.attachOwner('session-a');
    refs.add(oldRef);
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      ownerSessionId: 'session-a',
    });
    useWorkbenchStore.setState({ sessionId: 'session-b', stageId: 'stage-1' });

    const host = mount(
      createElement(
        Fragment,
        null,
        createElement(ChatOwner),
        createElement(ElementRefLassoButton, { sceneId: 'scene-1' }),
      ),
    );

    // The render-phase owner fence hides A's tally, and A's armed mode never
    // reads as this button's own, once B's attach effect has claimed the draft.
    expect(host.querySelector('[data-testid="element-ref-count"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="element-ref-arm"]')?.getAttribute('aria-pressed'),
    ).toBe('false');

    await act(async () => undefined);
    expect(useElementRefsStore.getState()).toMatchObject({ ownerSessionId: 'session-b', refs: [] });
  });
});
