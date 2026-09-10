// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElementPickLayer } from '@/components/edit/surfaces/slide/ElementPickLayer';
import { CANVAS_OVERLAY_Z } from '@/components/edit/surfaces/slide/CanvasOverlayPortal';
import { ElementRefPinLayer } from '@/components/edit/surfaces/slide/ElementRefPinLayer';
import {
  MAIC_ELEMENT_ID_ATTRIBUTE,
  editableElementDomId,
} from '@/components/edit/surfaces/slide/renderer-element-dom';
import { useCanvasStore } from '@/lib/store/canvas';
import { useElementRefsOwnerLifecycle, useElementRefsStore } from '@/lib/store/element-refs';
import { useStageStore } from '@/lib/store/stage';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  order: 1,
  title: 'Slide',
  type: 'slide',
  content: {
    type: 'slide',
    canvas: {
      id: 'slide-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [
        {
          id: 'title-1',
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content: '<p>折射定律</p>',
          defaultFontName: 'Inter',
          defaultColor: '#111111',
        },
        {
          id: 'note-1',
          type: 'shape',
          left: 0,
          top: 60,
          width: 100,
          height: 40,
          rotate: 0,
          text: { content: '<p>入射角</p>' },
        },
      ],
    },
  },
  actions: [{ id: 'spotlight-1', type: 'spotlight', elementId: '' }],
} as unknown as Scene;

/**
 * A LEGACY editor host: a `#editable-element-{id}` wrapper carrying only
 * `data-maic-element-id`, with the painted box on `.element-content`. This is
 * the DEFAULT canvas, and before the shared DOM contract it emitted neither the
 * attribute the hit-test looks for nor a paint node the layer knew about — so
 * picking silently found nothing on it.
 */
function mountLegacyHost(elementId: string, top: number) {
  const host = document.createElement('div');
  host.id = editableElementDomId(elementId);
  host.setAttribute(MAIC_ELEMENT_ID_ATTRIBUTE, elementId);
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
  const paint = document.createElement('div');
  paint.className = 'element-content';
  paint.getBoundingClientRect = () =>
    ({ left: 10, top, width: 120, height: 40, right: 130, bottom: top + 40 }) as DOMRect;
  host.appendChild(paint);
  document.body.appendChild(host);
  return { host, paint };
}

function stubPointAt(node: HTMLElement | null) {
  Object.defineProperty(document, 'elementsFromPoint', {
    configurable: true,
    value: () => (node ? [node] : []),
  });
}

afterEach(() => {
  useCanvasStore.getState().resetCanvasState();
  useElementRefsStore.getState().clear();
  useStageStore.setState({ stage: null, scenes: [], currentSceneId: null });
  useWorkbenchStore.setState({ sessionId: null, stageId: null });
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/**
 * The studio frame the overlay clamps to. Mocked at the origin with a large
 * size so it is the whole canvas container without shifting element-relative ring
 * coordinates (a child measured against a box at 0,0 keeps its element coords).
 */
const FRAME_RECT = { left: 0, top: 0, width: 1000, height: 600 } as const;

async function render(includePins = false) {
  useWorkbenchStore.setState({
    sessionId: 'session-a',
    stageId: useStageStore.getState().stage?.id ?? null,
  });
  const container = document.createElement('div');
  // The picker renders inside the slide card, which sits inside the studio frame
  // it must clamp to; reproduce that ancestry so `closest()` resolves the frame.
  const frame = document.createElement('div');
  frame.setAttribute('data-maic-studio-frame', 'true');
  frame.getBoundingClientRect = () =>
    ({
      ...FRAME_RECT,
      right: FRAME_RECT.width,
      bottom: FRAME_RECT.height,
      x: FRAME_RECT.left,
      y: FRAME_RECT.top,
      toJSON: () => ({}),
    }) as DOMRect;
  frame.appendChild(container);
  document.body.appendChild(frame);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      includePins
        ? createElement(
            Fragment,
            null,
            createElement(ElementRefPinLayer),
            createElement(ElementPickLayer),
          )
        : createElement(ElementPickLayer),
    );
  });
  return { container, root };
}

function ChatOwner() {
  const sessionId = useWorkbenchStore((state) => state.sessionId);
  useElementRefsOwnerLifecycle(sessionId);
  return null;
}

async function renderWithChatOwner(includePins = false) {
  useWorkbenchStore.setState({
    sessionId: 'session-a',
    stageId: useStageStore.getState().stage?.id ?? null,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        Fragment,
        null,
        createElement(ChatOwner),
        includePins ? createElement(ElementRefPinLayer) : null,
        createElement(ElementPickLayer),
      ),
    );
  });
  return { container, root };
}

describe('ElementPickLayer purposes', () => {
  it('finds a legacy-canvas element through the shared data attribute', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    const { paint } = mountLegacyHost('title-1', 30);
    mountLegacyHost('note-1', 90);
    stubPointAt(paint);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });

    const { root } = await render();
    // The canvas starts CLEAN — no all-elements outlining. The ring appears on
    // the element under the pointer, measured from its `.element-content` box
    // rather than the zero-size wrapper the ids hang on.
    expect(document.querySelector('.ring-violet-500')).toBeNull();
    const catcher = document.querySelector('.cursor-crosshair') as HTMLElement;
    await act(async () => {
      catcher.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40 }),
      );
    });

    const ring = document.querySelector('.ring-violet-500') as HTMLElement;
    // The ring sits 2px outside the measured box on every side.
    expect(ring.style.left).toBe('8px');
    expect(ring.style.width).toBe('124px');

    await act(async () => root.unmount());
  });

  it('renders on the body, so the element panel is never clipped by the card', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    mountLegacyHost('title-1', 30);
    stubPointAt(null);
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });

    const { container, root } = await render();

    // The card's `overflow-hidden` used to cut the bottom off the element list.
    // The mount point now keeps only the invisible measuring anchor.
    expect(container.querySelector('[data-testid="element-pick-layer"]')).toBeNull();
    expect(container.querySelector('[data-canvas-overlay-anchor]')).not.toBeNull();
    const layer = document.querySelector('[data-testid="element-pick-layer"]') as HTMLElement;
    expect(layer.parentElement).toBe(document.body);
    expect(layer.style.position).toBe('fixed');
    // Clamped to the studio frame (the whole canvas container), so the panel can
    // roam the padding around the card but never escape onto the dock.
    expect(layer.style.width).toBe(`${FRAME_RECT.width}px`);
    expect(layer.style.height).toBe(`${FRAME_RECT.height}px`);
    // Above the insert palette AT REST: while picking, a click on the slide means
    // "this element", not "insert one". The strip itself is allowed over the
    // picker while picking — raised but inert, so the click still reaches here —
    // and that is the only thing above this layer.
    expect(layer.style.zIndex).toBe(String(CANVAS_OVERLAY_Z.picker));
    expect(CANVAS_OVERLAY_Z.picker).toBeGreaterThan(CANVAS_OVERLAY_Z.palette);
    expect(CANVAS_OVERLAY_Z.paletteOverPicker).toBeGreaterThan(CANVAS_OVERLAY_Z.picker);
    // The picker still swallows canvas clicks: its box is NOT click-through.
    expect(layer.style.pointerEvents).toBe('');

    await act(async () => root.unmount());
  });

  it('keeps the staged pins under the picker’s own hover ring', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    const { paint } = mountLegacyHost('title-1', 30);
    mountLegacyHost('note-1', 90);
    stubPointAt(paint);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useElementRefsStore.getState().attachOwner('session-a');
    useElementRefsStore.getState().add({
      kind: 'slide-element',
      stageId: 'stage-1',
      sceneId: scene.id,
      elementId: 'title-1',
      elementType: 'text',
      label: '标题',
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });

    const { root } = await render(true);

    // The pins keep their own in-canvas layer at z-[110], below the portaled pick
    // layer — so the hover ring, which the picker owns, paints over them. Raising
    // the insert strip over the picker must not disturb this pair.
    const pin = document.querySelector('[data-testid="element-ref-pin"]') as HTMLElement;
    expect((pin.parentElement as HTMLElement).className).toContain('z-[110]');
    expect(CANVAS_OVERLAY_Z.picker).toBeGreaterThan(110);

    const catcher = document.querySelector('.cursor-crosshair') as HTMLElement;
    await act(async () => {
      catcher.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40 }),
      );
    });
    const layer = document.querySelector('[data-testid="element-pick-layer"]') as HTMLElement;
    const ring = document.querySelector('.ring-violet-500') as HTMLElement;
    expect(layer.contains(ring)).toBe(true);

    await act(async () => root.unmount());
  });

  it('rings an element from the panel list, with the canvas otherwise untouched', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    mountLegacyHost('title-1', 30);
    mountLegacyHost('note-1', 90);
    // Nothing under the pointer: the panel is the only way in, which is exactly
    // the case it exists for (elements too small to hit, or hidden behind one
    // another) and part of what the removed all-elements outlining used to carry.
    stubPointAt(null);
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });

    const { root } = await render();
    expect(document.querySelector('.ring-violet-500')).toBeNull();

    const noteRow = Array.from(document.querySelectorAll('button')).find((row) =>
      row.textContent?.includes('入射角'),
    );
    expect(noteRow).toBeDefined();
    await act(async () => {
      noteRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    // `note-1` is the second legacy host, painted at top 90 — ringed 2px outside.
    const ring = document.querySelector('.ring-violet-500') as HTMLElement;
    expect(ring.style.top).toBe('88px');
    expect(ring.style.width).toBe('124px');

    await act(async () => root.unmount());
  });

  it('element-ref mode toggles refs and stays armed', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    const { paint } = mountLegacyHost('title-1', 30);
    mountLegacyHost('note-1', 90);
    stubPointAt(paint);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });

    const { root } = await renderWithChatOwner(true);
    const catcher = document.querySelector('.cursor-crosshair') as HTMLElement;
    const move = () =>
      catcher.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40 }),
      );
    const click = () => catcher.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await act(async () => move());
    await act(async () => click());
    expect(useElementRefsStore.getState().refs).toEqual([
      {
        kind: 'slide-element',
        stageId: 'stage-1',
        sceneId: 'scene-1',
        elementId: 'title-1',
        elementType: 'text',
        label: 'edit.element.text · 折射定律',
        snapshotText: '折射定律',
      },
    ]);
    const stagedPins = document.querySelectorAll('[data-testid="element-ref-pin"]');
    expect(stagedPins).toHaveLength(1);
    expect(stagedPins[0]?.textContent).toBe('1');
    // Only the staged ordinal persists. The unselected note — and every other
    // non-hovered element — keeps the clean-canvas contract with no frame.
    expect(
      Array.from(document.querySelectorAll('[data-testid="element-ref-pin"]')).some((pin) =>
        pin.classList.contains('ring-violet-400/55'),
      ),
    ).toBe(false);
    // Multi-pick is the point: the mode must survive a pick.
    expect(useCanvasStore.getState().pickTarget).toEqual({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: 'scene-1',
      ownerSessionId: 'session-a',
    });

    // A second click on the same element un-picks it.
    await act(async () => click());
    expect(useElementRefsStore.getState().refs).toEqual([]);
    expect(useCanvasStore.getState().pickTarget).not.toBeNull();

    await act(async () => root.unmount());
  });

  it('element-ref mode survives a click on empty canvas; a cue pick cancels on it', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    mountLegacyHost('title-1', 30);
    stubPointAt(null); // pointer over nothing
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });
    const first = await render();
    await act(async () => {
      (document.querySelector('.cursor-crosshair') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    // Losing a multi-element selection to a stray click is not a cancel anyone
    // asked for.
    expect(useCanvasStore.getState().pickTarget).not.toBeNull();
    await act(async () => first.root.unmount());

    useCanvasStore.getState().setPickTarget({
      purpose: 'cue',
      stageId: 'stage-1',
      sceneId: scene.id,
      actionId: 'spotlight-1',
      cueType: 'spotlight',
    });
    const second = await render();
    await act(async () => {
      (document.querySelector('.cursor-crosshair') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(useCanvasStore.getState().pickTarget).toBeNull();
    await act(async () => second.root.unmount());
  });

  it('cue mode still binds one element and leaves, staging no refs', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    const { paint } = mountLegacyHost('title-1', 30);
    stubPointAt(paint);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'cue',
      stageId: 'stage-1',
      sceneId: scene.id,
      actionId: 'spotlight-1',
      cueType: 'spotlight',
    });

    const { root } = await render();
    const catcher = document.querySelector('.cursor-crosshair') as HTMLElement;
    await act(async () => {
      catcher.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40 }),
      );
    });
    await act(async () => catcher.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const action = useStageStore.getState().scenes[0].actions?.[0] as { elementId?: string };
    expect(action.elementId).toBe('title-1');
    expect(useCanvasStore.getState().pickTarget).toBeNull();
    // The two purposes must not leak into each other.
    expect(useElementRefsStore.getState().refs).toEqual([]);

    await act(async () => root.unmount());
  });

  it('does not carry an armed picker into a cloned course with the same scene and element ids', async () => {
    useStageStore.setState({
      stage: { id: 'stage-2' } as never,
      scenes: [{ ...scene, stageId: 'stage-2' }],
      currentSceneId: scene.id,
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });
    useElementRefsStore.getState().attachOwner('session-a');
    useElementRefsStore.getState().add({
      kind: 'slide-element',
      stageId: 'stage-2',
      sceneId: scene.id,
      elementId: 'title-1',
      elementType: 'text',
      label: '克隆课程标题',
    });
    mountLegacyHost('title-1', 30);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const { root } = await render(true);
    expect(document.querySelector('.cursor-crosshair')).toBeNull();
    // Clearing the foreign lasso restores both renderer shortcuts (the global
    // target is null) and the current course's pin layer.
    expect(useCanvasStore.getState().pickTarget).toBeNull();
    expect(document.querySelector('[data-testid="element-ref-pin"]')).not.toBeNull();
    expect(useElementRefsStore.getState().refs).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('disarms session A on navigation and lets session B re-arm a clean draft', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    const { paint } = mountLegacyHost('title-1', 30);
    stubPointAt(paint);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });

    const { root } = await renderWithChatOwner();
    expect(document.querySelector('.cursor-crosshair')).not.toBeNull();

    await act(async () => useWorkbenchStore.setState({ sessionId: 'session-b' }));
    expect(useCanvasStore.getState().pickTarget).toBeNull();
    expect(document.querySelector('.cursor-crosshair')).toBeNull();
    expect(useElementRefsStore.getState()).toMatchObject({
      ownerSessionId: 'session-b',
      refs: [],
    });

    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-b',
    });
    await act(async () => undefined);
    const catcher = document.querySelector('.cursor-crosshair') as HTMLElement;
    await act(async () => {
      catcher.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40 }),
      );
    });
    await act(async () => catcher.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(useElementRefsStore.getState()).toMatchObject({
      ownerSessionId: 'session-b',
      refs: [expect.objectContaining({ elementId: 'title-1' })],
    });
    expect(useCanvasStore.getState().pickTarget).toMatchObject({
      purpose: 'element-ref',
      ownerSessionId: 'session-b',
    });
    await act(async () => root.unmount());
  });

  it('keeps an element-ref armed across courses: session binds one course, canvas shows another', async () => {
    // The chat session is bound to course `stage-1`, but the classroom pane is
    // showing course `stage-2` — exactly the cross-course case that used to be
    // disarmed the same frame it armed, because the pick's stage was required to
    // equal the session's bound stage.
    useStageStore.setState({
      stage: { id: 'stage-2' } as never,
      scenes: [{ ...scene, stageId: 'stage-2' }],
      currentSceneId: scene.id,
    });
    useWorkbenchStore.setState({ sessionId: 'session-a', stageId: 'stage-1' });
    const { paint } = mountLegacyHost('title-1', 30);
    stubPointAt(paint);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-2',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(Fragment, null, createElement(ChatOwner), createElement(ElementPickLayer)),
      );
    });

    // The same-frame identity guard must NOT clear the cross-course arm, and the
    // layer must render (it used to be hidden because bound stage ≠ displayed).
    expect(useCanvasStore.getState().pickTarget).toMatchObject({
      purpose: 'element-ref',
      stageId: 'stage-2',
    });
    expect(document.querySelector('.cursor-crosshair')).not.toBeNull();

    const catcher = document.querySelector('.cursor-crosshair') as HTMLElement;
    await act(async () => {
      catcher.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40 }),
      );
    });
    await act(async () => catcher.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    // The pick lands against the DISPLAYED course — the ref carries its own
    // stageId — and the mode stays armed for multi-pick.
    expect(useElementRefsStore.getState().refs).toEqual([
      expect.objectContaining({ stageId: 'stage-2', sceneId: scene.id, elementId: 'title-1' }),
    ]);
    expect(useCanvasStore.getState().pickTarget).toMatchObject({
      purpose: 'element-ref',
      stageId: 'stage-2',
    });

    await act(async () => root.unmount());
  });

  it('still disarms an element-ref owned by another chat, even on the same course', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    useWorkbenchStore.setState({ sessionId: 'session-a', stageId: 'stage-1' });
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-b', // some other chat's pick
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ElementPickLayer));
    });

    // The owner fence is still identity: another session's pick must not leak
    // into this chat's canvas, even when the course matches.
    expect(useCanvasStore.getState().pickTarget).toBeNull();
    expect(document.querySelector('.cursor-crosshair')).toBeNull();

    await act(async () => root.unmount());
  });

  it('lets the armed pick land when the session switches bound stage while the canvas stays put', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    const { paint } = mountLegacyHost('title-1', 30);
    stubPointAt(paint);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    useElementRefsStore.getState().attachOwner('session-a');
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });

    const { root } = await renderWithChatOwner();
    const catcher = document.querySelector('.cursor-crosshair') as HTMLElement;
    expect(catcher).not.toBeNull();
    await act(async () => {
      catcher.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 40 }),
      );
    });

    // `switch_stage` updates the session-bound stage, but the canvas is still
    // showing the old course — that is now a CROSS-COURSE pick, and refs support
    // it by carrying their own stageId. Neither the session's bound stage nor a
    // click landing before navigation may veto the pick.
    await act(async () => {
      useWorkbenchStore.setState({ stageId: 'stage-2' });
      catcher.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useElementRefsStore.getState().refs).toEqual([
      expect.objectContaining({ stageId: 'stage-1', sceneId: scene.id, elementId: 'title-1' }),
    ]);
    expect(useCanvasStore.getState().pickTarget).toMatchObject({
      purpose: 'element-ref',
      stageId: 'stage-1',
    });
    expect(document.querySelector('.cursor-crosshair')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it('repositions a staged pin after a keyboard geometry commit', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    let top = 30;
    const { paint } = mountLegacyHost('title-1', top);
    paint.getBoundingClientRect = () =>
      ({ left: 10, top, width: 120, height: 40, right: 130, bottom: top + 40 }) as DOMRect;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    useElementRefsStore.getState().attachOwner('session-a');
    useElementRefsStore.getState().add({
      kind: 'slide-element',
      stageId: 'stage-1',
      sceneId: scene.id,
      elementId: 'title-1',
      elementType: 'text',
      label: '标题',
    });

    const { root } = await render(true);
    await act(async () => frames.splice(0).forEach((frame) => frame(0)));
    expect(
      (document.querySelector('[data-testid="element-ref-pin"]') as HTMLElement).style.top,
    ).toBe('30px');

    top = 46;
    const movedScene = structuredClone(scene);
    const movedElement = (movedScene.content as { canvas: { elements: Array<{ top: number }> } })
      .canvas.elements[0];
    movedElement.top = 16;
    await act(async () => useStageStore.setState({ scenes: [movedScene] }));
    await act(async () => frames.splice(0).forEach((frame) => frame(0)));

    expect(
      (document.querySelector('[data-testid="element-ref-pin"]') as HTMLElement).style.top,
    ).toBe('46px');
    await act(async () => root.unmount());
  });

  it('resizes a staged pin when text auto-height changes without pointerup', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    let height = 40;
    const { paint } = mountLegacyHost('title-1', 30);
    paint.getBoundingClientRect = () =>
      ({ left: 10, top: 30, width: 120, height, right: 130, bottom: 30 + height }) as DOMRect;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    let notifyResize: ResizeObserverCallback | null = null;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    useElementRefsStore.getState().attachOwner('session-a');
    useElementRefsStore.getState().add({
      kind: 'slide-element',
      stageId: 'stage-1',
      sceneId: scene.id,
      elementId: 'title-1',
      elementType: 'text',
      label: '标题',
    });

    const { root } = await render(true);
    await act(async () => frames.splice(0).forEach((frame) => frame(0)));
    expect(
      (document.querySelector('[data-testid="element-ref-pin"]') as HTMLElement).style.height,
    ).toBe('40px');

    height = 76;
    await act(async () => {
      notifyResize?.([], {} as ResizeObserver);
      frames.splice(0).forEach((frame) => frame(0));
    });

    expect(
      (document.querySelector('[data-testid="element-ref-pin"]') as HTMLElement).style.height,
    ).toBe('76px');
    await act(async () => root.unmount());
  });

  it('clamps the panel inside the container by its real height, re-clamping on expand', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });

    const { root } = await render();

    // The panel clamps against `rootRef` (the layer's only child), which jsdom
    // lays out as a zero box; give it the studio-frame geometry the panel is
    // supposed to stay inside.
    const layer = document.querySelector('[data-testid="element-pick-layer"]') as HTMLElement;
    const rootBox = layer.firstElementChild as HTMLElement;
    Object.defineProperty(rootBox, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          left: FRAME_RECT.left,
          top: FRAME_RECT.top,
          width: FRAME_RECT.width,
          height: FRAME_RECT.height,
          right: FRAME_RECT.width,
          bottom: FRAME_RECT.height,
        }) as DOMRect,
    });

    const panel = Array.from(layer.querySelectorAll('div')).find(
      (el) => (el as HTMLElement).style.width === '232px',
    ) as HTMLElement;
    expect(panel).toBeDefined();
    const toggle = panel.querySelector('button[aria-label]') as HTMLButtonElement;
    const header = panel.querySelector('.cursor-grab') as HTMLElement;
    // No layout engine in jsdom: simulate the panel's real height — 40px
    // collapsed (the header row), 400px expanded (header + the element rows).
    Object.defineProperty(panel, 'offsetHeight', {
      configurable: true,
      get: () => (toggle.getAttribute('aria-label') === 'edit.pick.expand' ? 40 : 400),
    });

    // Collapse, drag the now-short panel as low as its collapsed height allows…
    await act(async () => toggle.click());
    const dragToBottom = () => {
      header.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 0 }),
      );
      header.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 600 }),
      );
      header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    };
    await act(async () => dragToBottom());
    expect(panel.style.top).toBe('552px'); // 600 − 40 (collapsed) − 8

    // …then expanding the panel grows it past the container's bottom edge, and
    // the re-clamp must pull the whole panel back inside.
    await act(async () => toggle.click());
    expect(panel.style.top).toBe('192px'); // 600 − 400 (expanded) − 8

    await act(async () => root.unmount());
  });

  it('re-clamps the panel when the container shrinks in place (dock/divider drag)', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'element-ref',
      stageId: 'stage-1',
      sceneId: scene.id,
      ownerSessionId: 'session-a',
    });

    // jsdom has no ResizeObserver; capture the ones the layer tree constructs
    // so the test can fire the pick layer's container observer like a real
    // in-frame resize — a dock/divider drag re-shapes the studio frame without
    // a window resize, so the window-resize listener never runs.
    const instances: Array<{
      callback: ResizeObserverCallback;
      observed: Element[];
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    class TestResizeObserver {
      callback: ResizeObserverCallback;
      observed: Element[] = [];
      observe = vi.fn((el: Element) => {
        this.observed.push(el);
      });
      disconnect = vi.fn();
      unobserve = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        instances.push(this);
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    const { root } = await render();

    const layer = document.querySelector('[data-testid="element-pick-layer"]') as HTMLElement;
    const rootBox = layer.firstElementChild as HTMLElement;
    // The panel clamps against `rootRef`, which jsdom lays out as a zero box;
    // give it the studio-frame geometry and let the test shrink it afterwards.
    let frameHeight: number = FRAME_RECT.height;
    Object.defineProperty(rootBox, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          left: FRAME_RECT.left,
          top: FRAME_RECT.top,
          width: FRAME_RECT.width,
          height: frameHeight,
          right: FRAME_RECT.width,
          bottom: frameHeight,
        }) as DOMRect,
    });

    const panel = Array.from(layer.querySelectorAll('div')).find(
      (el) => (el as HTMLElement).style.width === '232px',
    ) as HTMLElement;
    expect(panel).toBeDefined();
    Object.defineProperty(panel, 'offsetHeight', {
      configurable: true,
      get: () => 400,
    });

    // The pick layer's own observer is the one watching the container it clamps
    // to (`CanvasOverlayPortal` observes the studio frame instead).
    const containerObserver = instances.find((o) => o.observed.includes(rootBox));
    expect(containerObserver).toBeDefined();

    // Drag the (tall) panel to the container's bottom edge…
    const header = panel.querySelector('.cursor-grab') as HTMLElement;
    await act(async () => {
      header.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 0 }),
      );
      header.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 600 }),
      );
      header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    expect(panel.style.top).toBe('192px'); // 600 − 400 − 8

    // …then the frame shrinks in place (e.g. the user drags the edit dock
    // taller). No window resize fires; the observer must see the container
    // change and pull the panel back — all the way to the top margin here,
    // since 300 − 400 − 8 is below it.
    frameHeight = 300;
    await act(async () => containerObserver?.callback([], {} as ResizeObserver));
    expect(panel.style.top).toBe('8px');

    // Leaving pick mode disconnects the observer.
    await act(async () => root.unmount());
    expect(containerObserver?.disconnect).toHaveBeenCalled();
  });

  it('disarms and clears cue preview when the current page changes in the same course', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene, { ...scene, id: 'scene-2', order: 2 }],
      currentSceneId: scene.id,
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'cue',
      stageId: 'stage-1',
      sceneId: scene.id,
      actionId: 'spotlight-1',
      cueType: 'spotlight',
    });
    useCanvasStore.getState().setSpotlight('title-1');
    useCanvasStore.getState().setLaser('title-1');
    const { root } = await render();

    await act(async () => useStageStore.setState({ currentSceneId: 'scene-2' }));

    expect(useCanvasStore.getState()).toMatchObject({
      pickTarget: null,
      spotlightElementId: '',
      laserElementId: '',
    });
    await act(async () => root.unmount());
  });
});
