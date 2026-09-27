// @vitest-environment jsdom
import { act, createElement, useState, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTElement, PPTLineElement, PPTTextElement } from '@openmaic/dsl';
import type { AlignmentLineProps } from '@/lib/types/edit';
import { useCanvasStore } from '@/lib/store/canvas';
import { useKeyboardStore } from '@/lib/store/keyboard';
import { useDragElement } from '@/components/slide-renderer/Editor/Canvas/hooks/useDragElement';

// Persistence is outside this gesture test; the store, hook, and mouse events are real.
const persistence = vi.hoisted(() => ({ updateSlide: vi.fn(), addHistorySnapshot: vi.fn() }));
vi.mock('@/lib/hooks/use-canvas-operations', () => ({
  useCanvasOperations: () => ({ updateSlide: persistence.updateSlide }),
}));
vi.mock('@/lib/hooks/use-history-snapshot', () => ({
  useHistorySnapshot: () => ({ addHistorySnapshot: persistence.addHistorySnapshot }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;

function line(overrides: Partial<PPTLineElement> = {}): PPTLineElement {
  return {
    id: 'line',
    type: 'line',
    left: 100,
    top: 100,
    width: 2,
    start: [0, 0],
    end: [100, 0],
    style: 'solid',
    color: '#000000',
    points: ['', ''],
    ...overrides,
  };
}

function box(overrides: Partial<PPTTextElement> = {}): PPTTextElement {
  return {
    id: 'box',
    type: 'text',
    left: 200,
    top: 120,
    width: 80,
    height: 40,
    rotate: 0,
    content: '<p>Box</p>',
    defaultFontName: 'Arial',
    defaultColor: '#000000',
    ...overrides,
  };
}

function mount(elements: PPTElement[], activeGroupElementId = '') {
  useCanvasStore.setState({
    activeElementIdList: elements.map(({ id }) => id),
    activeGroupElementId,
  });
  const ref: RefObject<PPTElement[]> = { current: elements };
  function Harness() {
    const [current, setElements] = useState(elements);
    const [guides, setGuides] = useState<AlignmentLineProps[]>([]);
    const { dragElement } = useDragElement(ref, setElements, setGuides);
    return createElement(
      'button',
      {
        onMouseDown: (event) => dragElement(event, current[0]),
        'data-guides': JSON.stringify(guides),
      },
      'Drag',
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness)));
  const button = container.querySelector('button')!;
  act(() =>
    button.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100 }),
    ),
  );
  return {
    ref,
    move(dx: number, dy: number) {
      act(() =>
        document.dispatchEvent(
          new MouseEvent('mousemove', { clientX: 100 + dx, clientY: 100 + dy }),
        ),
      );
    },
    finish(dx: number, dy: number) {
      act(() =>
        document.dispatchEvent(new MouseEvent('mouseup', { clientX: 100 + dx, clientY: 100 + dy })),
      );
    },
    guides: () => JSON.parse(button.dataset.guides!) as AlignmentLineProps[],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.setState({ viewportSize: 1000, viewportRatio: 0.6, canvasScale: 1 });
  useKeyboardStore.setState({ shiftKeyState: false });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.onmousemove = document.onmouseup = null;
  document.ontouchmove = document.ontouchend = null;
  document.body.replaceChildren();
});

describe('legacy canvas line drag bounds', () => {
  it('snaps a quadratic control hull to the bottom and persists that position', () => {
    const drag = mount([line({ curve: [50, 60] })]);
    drag.move(20, 442);
    expect(drag.ref.current[0]).toMatchObject({ left: 120, top: 540 });
    expect(drag.guides()).toContainEqual({
      type: 'horizontal',
      axis: { x: -50, y: 600 },
      length: 1100,
    });
    drag.finish(20, 442);
    expect(persistence.updateSlide).toHaveBeenCalledWith({ elements: drag.ref.current });
    expect(persistence.addHistorySnapshot).toHaveBeenCalledOnce();
  });

  it('snaps the negative cubic control hull at non-unit canvas scale', () => {
    useCanvasStore.setState({ canvasScale: 2 });
    const drag = mount([
      line({
        cubic: [
          [-40, 60],
          [160, -30],
        ],
      }),
    ]);
    drag.move(-124, 40);
    expect(drag.ref.current[0]).toMatchObject({ left: 40, top: 120 });
  });

  it('snaps offset endpoints by their actual minimum', () => {
    const drag = mount([line({ start: [20, 30], end: [80, 90] })]);
    drag.move(-118, 20);
    expect(drag.ref.current[0]).toMatchObject({ left: -20, top: 120 });
  });

  it('uses the full mixed-selection union on successive moves', () => {
    const drag = mount([box(), line({ broken: [50, -40] })]);
    drag.move(20, -58);
    expect(drag.ref.current.map(({ left, top }) => ({ left, top }))).toEqual([
      { left: 220, top: 60 },
      { left: 120, top: 40 },
    ]);
    drag.move(30, -57);
    expect(drag.ref.current.map(({ left, top }) => ({ left, top }))).toEqual([
      { left: 230, top: 60 },
      { left: 130, top: 40 },
    ]);
  });

  it('ignores the unused double-elbow coordinate during group-member dragging', () => {
    const drag = mount([line({ end: [100, 20], broken2: [-40, 800] }), box()], 'line');
    drag.move(-62, 478);
    expect(drag.ref.current[0]).toMatchObject({ left: 40, top: 580 });
    expect(drag.ref.current[1]).toEqual(box());
  });

  it('preserves rotated-element bounds', () => {
    const drag = mount([box({ left: 100, top: 100, width: 80, height: 40, rotate: 90 })]);
    drag.move(-118, 30);
    expect(drag.ref.current[0].left).toBeCloseTo(-20);
    expect(drag.ref.current[0].top).toBeCloseTo(130);
  });
});
