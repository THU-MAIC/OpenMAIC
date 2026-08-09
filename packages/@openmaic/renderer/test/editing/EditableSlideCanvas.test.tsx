// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Slide } from '@openmaic/dsl';
import { EditableSlideCanvas } from '../../src/editing/EditableSlideCanvas';
import { useViewportSize } from '../../src/hooks/useViewportSize';
import { getLineElementPath } from '../../src/utils/element';

// Mock the shared viewport-fit hook so we can force a non-zero centering
// offset. In jsdom the real hook reports container size 0 -> offset 0, which
// is why the scale-1 gesture tests below cannot catch letterboxing bugs.
vi.mock('../../src/hooks/useViewportSize', () => ({
  useViewportSize: vi.fn(),
}));

const slide = {
  id: 's',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  elements: [
    {
      id: 'a',
      type: 'text',
      left: 100,
      top: 100,
      width: 200,
      height: 80,
      rotate: 0,
      content: 'x',
      defaultFontName: 'a',
      defaultColor: '#000',
      lineHeight: 1,
    },
  ],
} as unknown as Slide;

function findHit(container: HTMLElement) {
  return container.querySelector('[data-element-id="a"]') as HTMLElement;
}

function findLineHit(container: HTMLElement) {
  return container.querySelector('[data-hit-kind="line"]') as unknown as SVGPathElement;
}

describe('EditableSlideCanvas', () => {
  beforeEach(() => {
    // Default: no centering offset (matches jsdom's zero-size container), so
    // the existing gesture tests run exactly as before.
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
  });

  it('offsets the interaction overlay by SlideCanvas centering offset', () => {
    // Letterboxed container: slide is centered with a 160px left gutter, so
    // an element rendered by SlideCanvas sits at left = 160 + el.left*scale.
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 160, top: 0, width: 1000, height: 562 },
      fitScale: 1,
    });
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );

    // Hit target must include the +160 centering offset (el.left=100 -> 260px),
    // otherwise pointer-down hit-testing misses the rendered element.
    const hit = findHit(container);
    expect(hit.style.left).toBe('260px');

    // SelectionOverlay is unchanged; its border sits inside a positioning
    // container that carries the centering offset (left: 160px).
    const border = container.querySelector('[data-selection-border]') as HTMLElement;
    expect(border.parentElement?.style.left).toBe('160px');
  });

  it('a click (no move) emits onSelectionChange only', () => {
    const onSel = vi.fn();
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(hit, { clientX: 0, clientY: 0 });
    // Selection happens once (on pointer-down); a plain click emits nothing more.
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith(
      expect.objectContaining({ elementIds: ['a'], primaryId: 'a' }),
    );
    expect(onCh).not.toHaveBeenCalled();
  });

  it('auto-fits when scale is omitted: overlay positions use fitScale', () => {
    // scale omitted -> canvasScale falls back to the hook's fitScale (0.5 here).
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 0, top: 0, width: 1000, height: 562 },
      fitScale: 0.5,
    });
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    const hit = findHit(container);
    // el.left=100 at fitScale 0.5 -> 50px; el.width=200 -> 100px.
    expect(hit.style.left).toBe('50px');
    expect(hit.style.width).toBe('100px');
  });

  it('is inert without callbacks: no interactive hit node is rendered', () => {
    const { container } = render(<EditableSlideCanvas slide={slide} scale={1} />);
    expect(container.querySelector('[data-element-id]')).toBeNull();
  });

  it('a selected line shows endpoint handles (not a bbox border); the box keeps its border', () => {
    const lineSlide = {
      ...slide,
      elements: [
        ...(slide as unknown as { elements: unknown[] }).elements,
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineSlide}
        scale={1}
        selection={{ elementIds: ['a', 'line1'], primaryId: 'line1' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    // Box element still hit-testable; line element has no draggable hit node
    // (its blocker is an inert SVG path, not a data-element-id move target).
    expect(container.querySelector('[data-element-id="a"]')).not.toBeNull();
    expect(container.querySelector('[data-element-id="line1"]')).toBeNull();
    // The selected line's chrome is its endpoint handles, NOT a bbox border.
    expect(container.querySelector('[data-line-handle="start"]')).not.toBeNull();
    expect(container.querySelector('[data-line-handle="end"]')).not.toBeNull();
    // Only the box element gets a selection border (the line does not).
    expect(container.querySelectorAll('[data-selection-border]')).toHaveLength(1);
  });

  it('a selected line renders start+end handles at correct scaled screen positions', () => {
    // Letterboxed container so the centering offset is exercised too.
    vi.mocked(useViewportSize).mockReturnValue({
      viewportStyles: { left: 160, top: 40, width: 1000, height: 562 },
      fitScale: 1,
    });
    const lineSlide = {
      ...slide,
      elements: [
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 20,
          start: [0, 0],
          end: [50, 30],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineSlide}
        scale={0.5}
        selection={{ elementIds: ['line1'], primaryId: 'line1' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    const start = container.querySelector('[data-line-handle="start"]') as HTMLElement;
    const end = container.querySelector('[data-line-handle="end"]') as HTMLElement;
    // start: left = 160 + (10+0)*0.5 = 165; top = 40 + (20+0)*0.5 = 50.
    expect(start.style.left).toBe('165px');
    expect(start.style.top).toBe('50px');
    // end: left = 160 + (10+50)*0.5 = 190; top = 40 + (20+30)*0.5 = 65.
    expect(end.style.left).toBe('190px');
    expect(end.style.top).toBe('65px');
    // No ctrl handles for a straight line.
    expect(container.querySelector('[data-line-handle="ctrl"]')).toBeNull();
  });

  it('dragging the end handle emits exactly one element.update for the line', () => {
    const onCh = vi.fn();
    const onSel = vi.fn();
    const lineSlide = {
      ...slide,
      elements: [
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineSlide}
        scale={1}
        selection={{ elementIds: ['line1'], primaryId: 'line1' }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const end = container.querySelector('[data-line-handle="end"]') as Element;
    fireEvent.pointerDown(end, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(end, { clientX: 40, clientY: 30 });
    fireEvent.pointerUp(end, { clientX: 40, clientY: 30 });
    // Exactly one reshape intent, targeting the line, of type element.update.
    expect(onCh).toHaveBeenCalledTimes(1);
    const intents = onCh.mock.calls[0][0];
    expect(intents).toHaveLength(1);
    expect(intents[0].type).toBe('element.update');
    expect(intents[0].id).toBe('line1');
    expect(intents[0].props).toBeTruthy();
    // A handle grab EDITS; it must never re-select. onSelectionChange stays
    // untouched across the whole reshape (down/move/up).
    expect(onSel).not.toHaveBeenCalled();
  });

  it('a selected curve line renders a ctrl handle whose drag emits one element.update', () => {
    // F4: a `curve` line exposes a single control handle (`ctrl`). Dragging it
    // reshapes the curve, emitting exactly one element.update — and, like every
    // handle grab, never re-selects.
    const onCh = vi.fn();
    const onSel = vi.fn();
    const curveSlide = {
      ...slide,
      elements: [
        {
          id: 'line1',
          type: 'line',
          left: 0,
          top: 0,
          start: [0, 0],
          end: [100, 0],
          curve: [50, 80],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={curveSlide}
        scale={1}
        selection={{ elementIds: ['line1'], primaryId: 'line1' }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const ctrl = container.querySelector('[data-line-handle="ctrl"]') as Element;
    expect(ctrl).not.toBeNull();
    fireEvent.pointerDown(ctrl, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(ctrl, { clientX: 20, clientY: -30 });
    fireEvent.pointerUp(ctrl, { clientX: 20, clientY: -30 });
    expect(onCh).toHaveBeenCalledTimes(1);
    const intents = onCh.mock.calls[0][0];
    expect(intents).toHaveLength(1);
    expect(intents[0].type).toBe('element.update');
    expect(intents[0].id).toBe('line1');
    expect(intents[0].props.curve).toBeTruthy();
    expect(onSel).not.toHaveBeenCalled();
  });

  it('a locked selected line renders no handles', () => {
    const lockedLine = {
      ...slide,
      elements: [
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
          lock: true,
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lockedLine}
        scale={1}
        selection={{ elementIds: ['line1'], primaryId: 'line1' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-line-handle]')).toBeNull();
  });

  it('FIX A: select-only mount (no onElementsChange) shows the highlight but NO line handles', () => {
    // Line handles are gated on EDITABILITY (onElementsChange), not generic
    // interactivity: the reshape gesture no-ops without a mutation channel, so
    // a select-only mount must NOT show draggable handles that cannot commit.
    // Selection feedback (the highlight stroke) still renders.
    const onSel = vi.fn();
    const lineSlide = {
      ...slide,
      elements: [
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineSlide}
        scale={1}
        selection={{ elementIds: ['line1'], primaryId: 'line1' }}
        onSelectionChange={onSel}
        snapping={false}
      />,
    );
    // No editability -> NO handles at all.
    expect(container.querySelector('[data-line-handle]')).toBeNull();
    // But the selection highlight is still shown (feedback).
    const highlight = container.querySelector(
      '[data-hit-kind="line-highlight"]',
    ) as unknown as SVGPathElement;
    expect(highlight).not.toBeNull();
    expect(highlight.getAttribute('stroke')).not.toBe('transparent');
  });

  it('a line renders an inert SVG-path blocker mirroring getLineElementPath (straight) and consumes stroke pointer-downs', () => {
    // R2/P2: the blocker is now an SVG <path> whose `d` is the SAME path the v1
    // renderer draws (getLineElementPath). `pointer-events: stroke` makes only
    // the fat transparent stroke a hit target, so it covers the visible line
    // (every path shape) and NOT the empty bbox: a pointer-down on the stroke
    // consumes without selecting/moving the box beneath, while an off-stroke
    // bbox click still reaches the box below.
    const onSel = vi.fn();
    const onCh = vi.fn();
    const lineOverBox = {
      ...slide,
      elements: [
        (slide as unknown as { elements: unknown[] }).elements[0], // box 'a'
        {
          id: 'line1',
          type: 'line',
          left: 100,
          top: 100,
          start: [0, 0],
          end: [100, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineOverBox}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );

    // The blocker is the SVG path, inert (no data-element-id), with `d` equal to
    // the renderer's path and a stroke-only hit region.
    const blocker = container.querySelector('[data-hit-kind="line"]') as unknown as SVGPathElement;
    expect(blocker).not.toBeNull();
    expect(blocker.getAttribute('data-element-id')).toBeNull();
    expect(blocker.tagName.toLowerCase()).toBe('path');
    expect(blocker.getAttribute('d')).toBe('M0,0 L100,50');
    expect(blocker.getAttribute('pointer-events')).toBe('stroke');
    expect(blocker.getAttribute('fill')).toBe('none');
    // Grab band (canvas units): max(10, width*scale)=max(10,2)=10 at scale 1.
    expect(blocker.getAttribute('stroke-width')).toBe('10');

    // A pointer-down on the stroke blocker selects the LINE (selectable but not
    // draggable) and consumes the pointer, so the box beneath is neither moved
    // nor selected — the selection lands on the line, never the box.
    fireEvent.pointerDown(blocker as unknown as Element, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(blocker as unknown as Element, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(blocker as unknown as Element, { clientX: 30, clientY: 20 });
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith(
      expect.objectContaining({ elementIds: ['line1'], primaryId: 'line1' }),
    );
    expect(onCh).not.toHaveBeenCalled();

    // A pointer-down in the line's bbox but away from the stroke still reaches
    // the box: its own hit target is present and drives a move.
    const boxHit = container.querySelector('[data-element-id="a"]') as HTMLElement;
    expect(boxHit).not.toBeNull();
    fireEvent.pointerDown(boxHit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(boxHit, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(boxHit, { clientX: 30, clientY: 20 });
    expect(onCh).toHaveBeenCalledTimes(1);
  });

  it('a pointer-down on a line selects it via onSelectionChange but emits no element.update (selectable, not draggable)', () => {
    // Regression: lines regressed to unselectable because the blocker only
    // stopped propagation. It must now select the line on
    // pointer-down (parity with box elements) while staying drag-inert: no
    // working copy, no move intent, ever.
    const onSel = vi.fn();
    const onCh = vi.fn();
    const lineSlide = {
      ...slide,
      elements: [
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineSlide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const blocker = container.querySelector('[data-hit-kind="line"]') as unknown as Element;
    fireEvent.pointerDown(blocker, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(blocker, { clientX: 40, clientY: 30 });
    fireEvent.pointerUp(blocker, { clientX: 40, clientY: 30 });
    // Selected once, on pointer-down (box-element parity); never draggable.
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith(
      expect.objectContaining({ elementIds: ['line1'], primaryId: 'line1' }),
    );
    expect(onCh).not.toHaveBeenCalled();
  });

  it('the line blocker still consumes the pointer when onSelectionChange is absent', () => {
    // Even with no selection callback, the blocker must block fall-through: a
    // pointer-down over a line that overlaps a box must not move the box.
    const onCh = vi.fn();
    const lineOverBox = {
      ...slide,
      elements: [
        (slide as unknown as { elements: unknown[] }).elements[0], // box 'a'
        {
          id: 'line1',
          type: 'line',
          left: 100,
          top: 100,
          start: [0, 0],
          end: [100, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineOverBox}
        scale={1}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const blocker = container.querySelector('[data-hit-kind="line"]') as unknown as Element;
    fireEvent.pointerDown(blocker, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(blocker, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(blocker, { clientX: 30, clientY: 20 });
    // Blocker consumed the pointer; the box beneath never moved.
    expect(onCh).not.toHaveBeenCalled();
  });

  it('a non-straight line blocker uses the real getLineElementPath (covers the curve, not just the chord)', () => {
    // P2: for curve/broken/cubic lines the drawn stroke bends away from the
    // start->end chord; a chord-only blocker leaves the visible curve
    // click-through. The blocker must reuse getLineElementPath so its `d`
    // traces the identical bent path the renderer draws.
    const curved = {
      id: 'line1',
      type: 'line',
      left: 0,
      top: 0,
      start: [0, 0],
      curve: [50, 80],
      end: [100, 0],
      width: 2,
      style: 'solid',
      color: '#333',
      points: ['', ''],
    };
    const curvedSlide = { ...slide, elements: [curved] } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={curvedSlide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    const blocker = container.querySelector('[data-hit-kind="line"]') as unknown as SVGPathElement;
    expect(blocker).not.toBeNull();
    const d = blocker.getAttribute('d');
    // Exactly the path the renderer draws (a quadratic curve), NOT a straight chord.
    expect(d).toBe(getLineElementPath(curved as never));
    expect(d).toContain('Q');
    expect(d).not.toBe('M0,0 L100,0');
  });

  it('the blocker grab band scales with el.width*canvasScale (min 10px screen)', () => {
    // P3: a wider rendered stroke (large el.width, or zoomed canvas) must widen
    // the grab band so its outer pixels are still covered. stroke-width is in
    // canvas units inside a scale(canvasScale) svg, so screen band =
    // stroke-width*canvasScale = max(10, el.width*canvasScale).
    const mkLine = (id: string, width: number) => ({
      id,
      type: 'line',
      left: 0,
      top: 0,
      start: [0, 0],
      end: [100, 0],
      width,
      style: 'solid',
      color: '#333',
      points: ['', ''],
    });

    // At scale 1: thin(2) clamps to the 10px min; thick(40) yields a wider band.
    const { container } = render(
      <EditableSlideCanvas
        slide={{ ...slide, elements: [mkLine('thin', 2), mkLine('thick', 40)] } as unknown as Slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
      />,
    );
    const bands = Array.from(container.querySelectorAll('[data-hit-kind="line"]')).map((b) =>
      parseFloat(b.getAttribute('stroke-width') || '0'),
    );
    expect(bands[0]).toBe(10); // thin clamped to the 10px minimum
    expect(bands[1]).toBe(40); // thick -> wider band
    expect(bands[1]).toBeGreaterThan(bands[0]);

    // Under zoom the 10px SCREEN minimum is preserved: at scale 0.5 a thin line
    // has canvas stroke-width 20 so its on-screen band is 20*0.5 = 10.
    const { container: c2 } = render(
      <EditableSlideCanvas
        slide={{ ...slide, elements: [mkLine('thin', 2)] } as unknown as Slide}
        scale={0.5}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
      />,
    );
    const swZoom = parseFloat(
      (c2.querySelector('[data-hit-kind="line"]') as Element).getAttribute('stroke-width') || '0',
    );
    expect(swZoom).toBe(20);
    expect(swZoom * 0.5).toBe(10); // screen band == 10px min
  });

  it('F1: a selected line paints a visible highlight (separate path); every blocker stays transparent', () => {
    // A selected line must show selection chrome in EVERY state. The hit
    // geometry and visual chrome are now split into two paths: the blocker is
    // ALWAYS transparent; a separate highlight path (accent stroke) is added
    // only when the line is selected — feedback even where handles are not
    // (read-only/locked).
    const mkLine = (id: string) => ({
      id,
      type: 'line',
      left: 10,
      top: 10,
      start: [0, 0],
      end: [50, 50],
      width: 2,
      style: 'solid',
      color: '#333',
      points: ['', ''],
    });
    const twoLines = {
      ...slide,
      elements: [mkLine('sel'), mkLine('unsel')],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={twoLines}
        scale={1}
        selection={{ elementIds: ['sel'], primaryId: 'sel' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    // Both lines render a blocker path; ALL blockers are transparent.
    const blockers = Array.from(
      container.querySelectorAll('[data-hit-kind="line"]'),
    ) as unknown as SVGPathElement[];
    expect(blockers).toHaveLength(2);
    expect(blockers.every((p) => p.getAttribute('stroke') === 'transparent')).toBe(true);
    // Exactly one visible highlight path (the selected line), on its own node.
    const highlights = Array.from(
      container.querySelectorAll('[data-hit-kind="line-highlight"]'),
    ) as unknown as SVGPathElement[];
    expect(highlights).toHaveLength(1);
    expect(highlights[0].getAttribute('stroke')).not.toBe('transparent');
    expect(highlights[0].getAttribute('stroke')).toBeTruthy();
  });

  it('FIX B: selecting a thin line does NOT shrink its hit band; highlight is non-interactive', () => {
    // Regression: when the blocker was ALSO the visual chrome, selecting a thin
    // line switched its stroke-width from the fat grab band to the thin
    // highlight width, shrinking the `pointer-events: stroke` hit region so
    // clicks fell through to a box beneath — a click-through that only appeared
    // once the line was selected. With the split, the blocker's hit band is
    // identical selected vs. unselected, and the highlight never hit-tests.
    const mkLine = (id: string) => ({
      id,
      type: 'line',
      left: 10,
      top: 10,
      start: [0, 0],
      end: [50, 50],
      width: 2, // thin: grab band clamps to the 10px min
      style: 'solid',
      color: '#333',
      points: ['', ''],
    });
    // Unselected reference blocker.
    const { container: cUnsel } = render(
      <EditableSlideCanvas
        slide={{ ...slide, elements: [mkLine('l')] } as unknown as Slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    const unselBlocker = cUnsel.querySelector(
      '[data-hit-kind="line"]',
    ) as unknown as SVGPathElement;
    const unselPe = unselBlocker.getAttribute('pointer-events');
    const unselSw = unselBlocker.getAttribute('stroke-width');
    expect(unselPe).toBe('stroke');
    expect(unselSw).toBe('10'); // fat grab band

    // Selected: the blocker's hit band must be UNCHANGED.
    const { container: cSel } = render(
      <EditableSlideCanvas
        slide={{ ...slide, elements: [mkLine('l')] } as unknown as Slide}
        scale={1}
        selection={{ elementIds: ['l'], primaryId: 'l' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    const selBlocker = cSel.querySelector('[data-hit-kind="line"]') as unknown as SVGPathElement;
    expect(selBlocker.getAttribute('pointer-events')).toBe(unselPe); // still 'stroke'
    expect(selBlocker.getAttribute('stroke-width')).toBe(unselSw); // still the fat band, not shrunk
    expect(selBlocker.getAttribute('stroke')).toBe('transparent'); // blocker is never the chrome

    // The highlight is a separate, purely-visual path: never hit-tests.
    const selHighlight = cSel.querySelector(
      '[data-hit-kind="line-highlight"]',
    ) as unknown as SVGPathElement;
    expect(selHighlight).not.toBeNull();
    expect(selHighlight.getAttribute('pointer-events')).toBe('none');
    expect(selHighlight.getAttribute('stroke')).not.toBe('transparent');
  });

  it('F1: a locked selected line still shows the highlight (feedback) but no handles', () => {
    const lockedLine = {
      ...slide,
      elements: [
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
          lock: true,
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lockedLine}
        scale={1}
        selection={{ elementIds: ['line1'], primaryId: 'line1' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    // Highlight present (selection feedback) even though the line is locked...
    const highlight = container.querySelector(
      '[data-hit-kind="line-highlight"]',
    ) as unknown as SVGPathElement;
    expect(highlight).not.toBeNull();
    expect(highlight.getAttribute('stroke')).not.toBe('transparent');
    // ...but a locked line is not reshapeable, so no handles.
    expect(container.querySelector('[data-line-handle]')).toBeNull();
  });

  it('F1: a selected line in a read-only mount (no callbacks) still shows the highlight', () => {
    // No selection/mutation callbacks -> the interaction layer is inert, but a
    // selected line must STILL show its highlight. Its blocker path renders
    // with a visible stroke and pointer-events disabled (never captures).
    const lineSlide = {
      ...slide,
      elements: [
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineSlide}
        scale={1}
        selection={{ elementIds: ['line1'], primaryId: 'line1' }}
      />,
    );
    // The highlight path renders with a visible stroke; it is purely visual.
    const highlight = container.querySelector(
      '[data-hit-kind="line-highlight"]',
    ) as unknown as SVGPathElement;
    expect(highlight).not.toBeNull();
    expect(highlight.getAttribute('stroke')).not.toBe('transparent');
    expect(highlight.getAttribute('pointer-events')).toBe('none');
    // Inert: the blocker in a read-only mount never captures the pointer.
    const blocker = container.querySelector('[data-hit-kind="line"]') as unknown as SVGPathElement;
    expect(blocker).not.toBeNull();
    expect(blocker.getAttribute('pointer-events')).toBe('none');
    // No handles/hit targets in a read-only mount.
    expect(container.querySelector('[data-line-handle]')).toBeNull();
    expect(container.querySelector('[data-element-id]')).toBeNull();
  });

  it('select-only host (no onElementsChange): no live movement during drag; pointer-up selects', () => {
    // R3: with only onSelectionChange, the working copy must NOT follow the
    // pointer during pointermove (nothing can commit, so a live drag would just
    // snap back). The element stays put; pointer-up selects it.
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 30, clientY: 20 });
    // No live movement: the rendered element position is unchanged mid-drag.
    expect(findHit(container).style.left).toBe('100px');
    expect(findHit(container).style.top).toBe('100px');
    fireEvent.pointerUp(hit, { clientX: 30, clientY: 20 });
    // Selection happened once (on pointer-down); no update channel to emit to.
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith(
      expect.objectContaining({ elementIds: ['a'], primaryId: 'a' }),
    );
  });

  it('select-only host leaves box and line hit layers touch-pan friendly while preserving tap selection', () => {
    // Touch suppression belongs to edit gestures, not selection. A select-only
    // mount still exposes hit layers for tap-select, but native touch panning
    // must survive when there is no mutation channel to commit a drag.
    const onSel = vi.fn();
    const lineSlide = {
      ...slide,
      elements: [
        (slide as unknown as { elements: unknown[] }).elements[0],
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineSlide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        snapping={false}
      />,
    );

    const boxHit = findHit(container);
    const lineHit = findLineHit(container);
    expect(boxHit.style.touchAction).toBe('');
    expect(lineHit.style.touchAction).toBe('');

    fireEvent.pointerDown(boxHit, { clientX: 0, clientY: 0 });
    expect(onSel).toHaveBeenLastCalledWith(
      expect.objectContaining({ elementIds: ['a'], primaryId: 'a' }),
    );
    fireEvent.pointerDown(lineHit, { clientX: 0, clientY: 0 });
    expect(onSel).toHaveBeenLastCalledWith(
      expect.objectContaining({ elementIds: ['line1'], primaryId: 'line1' }),
    );
  });

  it('editable host suppresses touch panning on box and line hit layers', () => {
    const lineSlide = {
      ...slide,
      elements: [
        (slide as unknown as { elements: unknown[] }).elements[0],
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineSlide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
        snapping={false}
      />,
    );

    expect(findHit(container).style.touchAction).toBe('none');
    expect(findLineHit(container).style.touchAction).toBe('none');
  });

  it('a drag emits exactly one element.update intent on pointer-up', () => {
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit, { clientX: 30, clientY: 20 });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh).toHaveBeenCalledWith([
      { type: 'element.update', id: 'a', props: { left: 130, top: 120 } },
    ]);
  });

  it('a diagonal move past the threshold on both axes commits a drag (Euclidean)', () => {
    // dx=dy=1.9 -> neither axis exceeds 2 (old per-axis check would misclassify
    // as a click), but hypot ≈ 2.69 > 2 so it must commit a drag intent.
    const onSel = vi.fn();
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 1.9, clientY: 1.9 });
    fireEvent.pointerUp(hit, { clientX: 1.9, clientY: 1.9 });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh).toHaveBeenCalledWith([
      { type: 'element.update', id: 'a', props: { left: 101.9, top: 101.9 } },
    ]);
    expect(onSel).not.toHaveBeenCalled();
  });

  it('fills its container: outer wrapper is width/height 100% (style can override)', () => {
    const { container } = render(
      <EditableSlideCanvas slide={slide} scale={1} onSelectionChange={vi.fn()} />,
    );
    const outer = container.firstChild as HTMLElement;
    expect(outer.style.width).toBe('100%');
    expect(outer.style.height).toBe('100%');

    // A consumer `style` still wins (merged AFTER the fill defaults).
    const { container: c2 } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        onSelectionChange={vi.fn()}
        style={{ height: '400px' }}
      />,
    );
    expect((c2.firstChild as HTMLElement).style.height).toBe('400px');
    expect((c2.firstChild as HTMLElement).style.width).toBe('100%');
  });

  it('with only onSelectionChange, a >2px drag still selects and emits no update', () => {
    const onSel = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(hit, { clientX: 30, clientY: 20 });
    // No mutation callback -> a drag-classified gesture falls back to selection.
    expect(onSel).toHaveBeenCalledTimes(1);
    expect(onSel).toHaveBeenCalledWith(
      expect.objectContaining({ elementIds: ['a'], primaryId: 'a' }),
    );
  });

  it('pointercancel reverts the working copy and leaves the hook ready for a new gesture', () => {
    const onSel = vi.fn();
    const onCh = vi.fn();
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 30, clientY: 0 });
    expect(findHit(container).style.left).toBe('130px'); // live drag moved it
    fireEvent.pointerCancel(hit, { clientX: 30, clientY: 0 });
    // Cancelled: working copy reverts, no intent, no selection change.
    expect(findHit(container).style.left).toBe('100px');
    expect(onCh).not.toHaveBeenCalled();
    expect(onSel).not.toHaveBeenCalled();

    // The hook is ready again: a fresh gesture is NOT ignored.
    fireEvent.pointerDown(hit, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { clientX: 40, clientY: 0 });
    fireEvent.pointerUp(hit, { clientX: 40, clientY: 0 });
    expect(onCh).toHaveBeenCalledTimes(1);
    expect(onCh).toHaveBeenCalledWith([
      { type: 'element.update', id: 'a', props: { left: 140, top: 100 } },
    ]);
  });

  it('locked element: no interactive move hit target is rendered', () => {
    const lockedSlide = {
      ...slide,
      elements: [
        (slide as unknown as { elements: unknown[] }).elements[0],
        {
          id: 'locked1',
          type: 'text',
          left: 300,
          top: 300,
          width: 100,
          height: 50,
          rotate: 0,
          content: 'y',
          defaultFontName: 'a',
          defaultColor: '#000',
          lineHeight: 1,
          lock: true,
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lockedSlide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
      />,
    );
    // Unlocked element still hit-testable; locked element has no hit node.
    expect(container.querySelector('[data-element-id="a"]')).not.toBeNull();
    expect(container.querySelector('[data-element-id="locked1"]')).toBeNull();
  });

  it('a locked element overlapping an unlocked one blocks the pointer instead of falling through', () => {
    // Regression: a locked element used to be skipped entirely from the hit
    // layer, so a pointer-down over
    // its (visually on-top) area fell through to whatever unlocked element's
    // hit target happened to occupy the same region underneath — moving/
    // selecting the WRONG element. The locked element now gets an inert
    // blocker at the same stacking position (same map order) so it consumes
    // the pointer instead.
    const onSel = vi.fn();
    const onCh = vi.fn();
    const overlappingLockedSlide = {
      ...slide,
      elements: [
        (slide as unknown as { elements: unknown[] }).elements[0], // 'a': left 100 top 100 w200 h80
        {
          id: 'locked1',
          type: 'text',
          left: 100,
          top: 100,
          width: 200,
          height: 80,
          rotate: 0,
          content: 'y',
          defaultFontName: 'a',
          defaultColor: '#000',
          lineHeight: 1,
          lock: true,
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={overlappingLockedSlide}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );

    // Both elements share identical screen geometry. `locked1` is later in
    // the elements array, so it is later in DOM/stacking order too — mirror
    // real overlapping-sibling hit-testing by dispatching to whichever hit
    // node currently ends up on top there. Pre-fix that's still `a`'s own hit
    // div (the locked element renders no hit node at all); post-fix it's the
    // locked blocker.
    const hitLayerNodes = container.querySelectorAll(
      '[data-element-id], [data-hit-kind="blocker"]',
    );
    const topmost = hitLayerNodes[hitLayerNodes.length - 1] as HTMLElement;

    fireEvent.pointerDown(topmost, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(topmost, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(topmost, { clientX: 30, clientY: 20 });

    // The locked blocker must consume the gesture: the unlocked element `a`
    // beneath it is neither moved (no `element.update`) nor selected.
    expect(onCh).not.toHaveBeenCalled();
    expect(onSel).not.toHaveBeenCalled();
  });

  it('a locked line blocks fall-through but is not selectable (emits no onSelectionChange)', () => {
    // F2: a locked line, like a locked box, is inert — it consumes the pointer
    // (blocks fall-through to an overlapped box beneath) but must NOT select.
    const onSel = vi.fn();
    const onCh = vi.fn();
    const lockedLineOverBox = {
      ...slide,
      elements: [
        (slide as unknown as { elements: unknown[] }).elements[0], // box 'a'
        {
          id: 'line1',
          type: 'line',
          left: 100,
          top: 100,
          start: [0, 0],
          end: [100, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
          lock: true,
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lockedLineOverBox}
        scale={1}
        selection={{ elementIds: [] }}
        onSelectionChange={onSel}
        onElementsChange={onCh}
        snapping={false}
      />,
    );
    const blocker = container.querySelector('[data-hit-kind="line"]') as unknown as Element;
    expect(blocker).not.toBeNull();
    fireEvent.pointerDown(blocker, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(blocker, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(blocker, { clientX: 30, clientY: 20 });
    // Locked: blocked the pointer (box beneath neither moved nor selected) and
    // did not select the line itself.
    expect(onSel).not.toHaveBeenCalled();
    expect(onCh).not.toHaveBeenCalled();
  });

  it('re-clicking an already-sole-selected line does not re-emit onSelectionChange', () => {
    // F3: mirror the box `alreadySolePrimary` guard — when the line is already
    // the sole primary selection, a further pointer-down must not re-emit.
    const onSel = vi.fn();
    const lineSlide = {
      ...slide,
      elements: [
        {
          id: 'line1',
          type: 'line',
          left: 10,
          top: 10,
          start: [0, 0],
          end: [50, 50],
          width: 2,
          style: 'solid',
          color: '#333',
          points: ['', ''],
        },
      ],
    } as unknown as Slide;
    const { container } = render(
      <EditableSlideCanvas
        slide={lineSlide}
        scale={1}
        selection={{ elementIds: ['line1'], primaryId: 'line1' }}
        onSelectionChange={onSel}
        onElementsChange={vi.fn()}
        snapping={false}
      />,
    );
    const blocker = container.querySelector('[data-hit-kind="line"]') as unknown as Element;
    fireEvent.pointerDown(blocker, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(blocker, { clientX: 0, clientY: 0 });
    // Already sole primary -> no redundant re-emit.
    expect(onSel).not.toHaveBeenCalled();
  });

  it('ignores a foreign pointerId; only the active pointer drives the gesture', () => {
    const { container } = render(
      <EditableSlideCanvas
        slide={slide}
        scale={1}
        selection={{ elementIds: ['a'], primaryId: 'a' }}
        onSelectionChange={vi.fn()}
        onElementsChange={vi.fn()}
        snapping={false}
      />,
    );
    const hit = findHit(container);
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    // A second pointer's move must be ignored (no cross-contamination).
    fireEvent.pointerMove(hit, { pointerId: 2, clientX: 50, clientY: 50 });
    expect(findHit(container).style.left).toBe('100px'); // unmoved
    // The active pointer still drives the working copy.
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 30, clientY: 0 });
    expect(findHit(container).style.left).toBe('130px');
  });
});
