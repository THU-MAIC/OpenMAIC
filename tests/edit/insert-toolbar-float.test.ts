// @vitest-environment jsdom
import { act, createElement, forwardRef, Fragment, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MotionValue } from 'motion/react';
import type { InsertPaletteItem } from '@/lib/edit/scene-editor-surface';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  /** The ref the strip hands to motion as its drag boundary. */
  dragConstraints: { ref: null as { current: HTMLElement | null } | null },
  /** The fold's animation-complete callback, which motion would fire itself. */
  foldComplete: { fn: null as (() => void) | null },
}));

/**
 * Motion is replaced by plain DOM so the fold is synchronous (no exit
 * animation to wait on) and so the test can see WHICH element the strip passes
 * as `dragConstraints` — the container choice is the thing under test, and a
 * real drag gesture cannot be performed in jsdom.
 */
vi.mock('motion/react', () => {
  const MOTION_ONLY_PROPS = new Set([
    'drag',
    'dragListener',
    'dragControls',
    'dragConstraints',
    'dragElastic',
    'dragMomentum',
    'whileDrag',
    'initial',
    'animate',
    'exit',
    'transition',
    'layout',
  ]);
  const MotionDiv = forwardRef<HTMLDivElement, Record<string, unknown>>(
    function MotionDiv(props, ref) {
      const forwarded: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (key === 'dragConstraints') {
          mocks.dragConstraints.ref = value as { current: HTMLElement | null };
          continue;
        }
        if (key === 'onAnimationComplete') {
          mocks.foldComplete.fn = value as () => void;
          continue;
        }
        if (MOTION_ONLY_PROPS.has(key)) continue;
        // `style={{ x, y }}` carries MotionValues, which React cannot render.
        if (key === 'style') {
          const { x: _x, y: _y, ...rest } = value as Record<string, unknown>;
          forwarded.style = rest;
          continue;
        }
        forwarded[key] = value;
      }
      return createElement('div', { ...forwarded, ref });
    },
  );
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) =>
      createElement(Fragment, null, children),
    motion: { div: MotionDiv },
    useDragControls: () => ({ start: vi.fn() }),
    useReducedMotion: () => false,
  };
});
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/edit/EditShell/InsertButton', () => ({
  InsertButton: ({ item }: { item: InsertPaletteItem }) =>
    createElement(
      'button',
      { type: 'button', 'data-testid': `insert-item-${item.id}` },
      item.label,
    ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { FloatingInsertToolbar } from '@/components/edit/EditShell/FloatingInsertToolbar';
import { ElementPickLayer } from '@/components/edit/surfaces/slide/ElementPickLayer';
import { CANVAS_OVERLAY_Z } from '@/components/edit/surfaces/slide/CanvasOverlayPortal';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { useWorkbenchStore } from '@/lib/workbench/session-store';

/** The studio frame — the OUTER container both canvas overlays are bounded to. */
const FRAME_RECT = { left: 0, top: 0, width: 1000, height: 600 } as const;
/** The slide card inside it — the inner container the strip used to be stuck in. */
const CARD_RECT = { left: 300, top: 150, width: 400, height: 300 } as const;

const items: InsertPaletteItem[] = [
  { id: 'text', label: 'Text box', icon: null, onInvoke: vi.fn() },
  { id: 'image', label: 'Image', icon: null, onInvoke: vi.fn() },
  { id: 'background', label: 'Background', icon: null, onInvoke: vi.fn() },
];

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
          content: '<p>Snell</p>',
        },
      ],
    },
  },
  actions: [],
} as unknown as Scene;

function stubRect(
  node: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
) {
  Object.defineProperty(node, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        ...rect,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      }) as DOMRect,
  });
}

/** A motion value stand-in: the strip only reads and writes the offset. */
function motionValue(initial: number) {
  const set = vi.fn();
  return { value: { get: () => initial, set } as unknown as MotionValue<number>, set };
}

/**
 * frame > card > mount point — the real ancestry, so `closest()` resolves the
 * studio frame and the card stays measurably smaller than it.
 */
function mountStudio() {
  const frame = document.createElement('div');
  frame.setAttribute('data-maic-studio-frame', 'true');
  stubRect(frame, FRAME_RECT);
  const card = document.createElement('div');
  stubRect(card, CARD_RECT);
  const container = document.createElement('div');
  card.appendChild(container);
  frame.appendChild(card);
  document.body.appendChild(frame);
  return container;
}

function Fold({ x, y }: { x: MotionValue<number>; y: MotionValue<number> }) {
  const [collapsed, setCollapsed] = useState(false);
  return createElement(FloatingInsertToolbar, {
    items,
    x,
    y,
    collapsed,
    onToggleCollapsed: () => setCollapsed((current) => !current),
  });
}

const layer = () => document.querySelector('[data-testid="insert-toolbar-layer"]') as HTMLElement;
const strip = () => document.querySelector('[data-testid="insert-toolbar"]') as HTMLElement;
const toggle = () =>
  document.querySelector('[data-testid="insert-toolbar-collapse"]') as HTMLButtonElement;
const handle = () =>
  document.querySelector('[data-testid="insert-toolbar-drag-handle"]') as HTMLButtonElement;

/** Unmounted in `afterEach`, so a failed assertion cannot leave a live root
 * writing into a body the next test has already cleared. */
let activeRoot: ReturnType<typeof createRoot> | null = null;

async function mount(node: ReturnType<typeof createElement>) {
  const container = mountStudio();
  activeRoot = createRoot(container);
  const root = activeRoot;
  await act(async () => {
    root.render(node);
  });
}

afterEach(async () => {
  if (activeRoot) {
    const root = activeRoot;
    activeRoot = null;
    await act(async () => root.unmount());
  }
  useCanvasStore.getState().resetCanvasState();
  useStageStore.setState({ stage: null, scenes: [], currentSceneId: null });
  useWorkbenchStore.setState({ sessionId: null, stageId: null });
  mocks.dragConstraints.ref = null;
  mocks.foldComplete.fn = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('floating insert toolbar', () => {
  it('bounds the strip to the studio frame, not to the slide card', async () => {
    const x = motionValue(0);
    const y = motionValue(0);
    await mount(
      createElement(FloatingInsertToolbar, {
        items,
        x: x.value,
        y: y.value,
        collapsed: false,
        onToggleCollapsed: vi.fn(),
      }),
    );

    // The overlay box takes the FRAME's geometry — the card's `overflow-hidden`
    // never sees the strip, and the strip can roam the padding beside the slide.
    expect(layer().parentElement).toBe(document.body);
    expect(layer().style.width).toBe(`${FRAME_RECT.width}px`);
    expect(layer().style.height).toBe(`${FRAME_RECT.height}px`);
    // At rest the strip sits below the app's popover layer so its own popovers
    // open above it, and the overlay box never swallows canvas clicks.
    expect(layer().style.zIndex).toBe(String(CANVAS_OVERLAY_Z.palette));
    expect(layer().style.pointerEvents).toBe('none');
    expect(strip().className).toContain('pointer-events-auto');

    // The drag boundary is the inset box inside that overlay — i.e. the frame
    // minus a margin — and NOT anything inside the card.
    const constraints = mocks.dragConstraints.ref?.current as HTMLElement;
    expect(constraints).not.toBeUndefined();
    expect(constraints.parentElement).toBe(layer());
    expect(constraints.className).toContain('inset-2');

    // Keyboard move, which clamps against that same box: jsdom lays out nothing,
    // so give the boundary the frame-minus-margin rect it has in a browser and
    // the strip a spot just inside the CARD's right edge (700).
    stubRect(constraints, {
      left: 8,
      top: 8,
      width: FRAME_RECT.width - 16,
      height: FRAME_RECT.height - 16,
    });
    stubRect(strip(), { left: 640, top: 300, width: 44, height: 160 });
    // Enter arms keyboard moving; the arrow step must be a separate flush, since
    // the armed flag is state the next handler has to see.
    await act(async () => {
      handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      handle().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
      );
    });

    // A full 24px step lands the strip at 708 — past the card's right edge and
    // still inside the frame. Bounded by the card this was clamped to 16.
    expect(CARD_RECT.left + CARD_RECT.width).toBeLessThan(684 + 24);
    expect(x.set).toHaveBeenCalledWith(24);
  });

  it('shares the picker’s bounding container and stays inert while picking', async () => {
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
      ownerSessionId: 'session-a',
    });

    const x = motionValue(0);
    const y = motionValue(0);
    await mount(
      createElement(
        Fragment,
        null,
        createElement(ElementPickLayer),
        createElement(FloatingInsertToolbar, {
          items,
          x: x.value,
          y: y.value,
          collapsed: false,
          onToggleCollapsed: vi.fn(),
        }),
      ),
    );

    // Same container, measured the same way: the element list and the insert
    // strip roam exactly one box, so their handles behave identically.
    const picker = document.querySelector('[data-testid="element-pick-layer"]') as HTMLElement;
    expect(picker).not.toBeNull();
    for (const side of ['left', 'top', 'width', 'height'] as const) {
      expect(layer().style[side]).toBe(picker.style[side]);
    }

    // While picking, the strip rises over the picker so the violet ring cannot
    // paint across it — and takes no pointer events up there, so a click in its
    // area still reaches the picker and means "pick this element".
    expect(layer().style.zIndex).toBe(String(CANVAS_OVERLAY_Z.paletteOverPicker));
    expect(strip().className).toContain('pointer-events-none');
    expect(strip().className).not.toContain('pointer-events-auto');
  });

  it('folds to its grip and back without persisting anything', async () => {
    const x = motionValue(0);
    const y = motionValue(0);
    await mount(createElement(Fold, { x: x.value, y: y.value }));

    expect(strip().dataset.collapsed).toBe('false');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-label')).toBe('edit.insert.collapseToolbar');
    expect(document.querySelectorAll('[data-testid^="insert-item-"]')).toHaveLength(items.length);

    await act(async () => toggle().click());

    // Folded: the grip and its chevron are all that is left, and the insert
    // buttons are unmounted rather than hidden (no invisible tab stops).
    expect(strip().dataset.collapsed).toBe('true');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().getAttribute('aria-label')).toBe('edit.insert.expandToolbar');
    expect(document.querySelectorAll('[data-testid^="insert-item-"]')).toHaveLength(0);
    expect(handle()).not.toBeNull();

    await act(async () => toggle().click());
    expect(strip().dataset.collapsed).toBe('false');
    expect(document.querySelectorAll('[data-testid^="insert-item-"]')).toHaveLength(items.length);
    // Session-local only: the fold leaves nothing behind in client storage.
    expect(window.localStorage.length).toBe(0);
  });
  it('pulls a strip parked at the bottom edge back inside when it expands', async () => {
    const x = motionValue(0);
    const y = motionValue(0);
    await mount(createElement(Fold, { x: x.value, y: y.value }));

    // The boundary as a browser lays it out (the frame minus its margin) with the
    // strip parked low: unfolding it grows the strip past the frame's bottom,
    // which motion does not correct on its own — `dragConstraints` only holds
    // during a gesture.
    const constraints = mocks.dragConstraints.ref?.current as HTMLElement;
    stubRect(constraints, {
      left: 8,
      top: 8,
      width: FRAME_RECT.width - 16,
      height: FRAME_RECT.height - 16,
    });
    stubRect(strip(), { left: 20, top: 500, width: 44, height: 160 });

    await act(async () => mocks.foldComplete.fn?.());

    // 592 (boundary bottom) − 660 (strip bottom) — the smallest move that fits,
    // and no horizontal drift.
    expect(y.set).toHaveBeenCalledWith(-68);
    expect(x.set).toHaveBeenCalledWith(0);
  });
});
