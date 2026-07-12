'use client';

import { Fragment, useRef } from 'react';
import type { PPTElement } from '@openmaic/dsl';

import { SlideCanvas } from '../SlideCanvas';
import { getLineElementPath } from '../utils/element';
import { useViewportSize } from '../hooks/useViewportSize';
import { SelectionOverlay } from './handles/SelectionOverlay';
import { LineHandles } from './handles/LineHandles';
import { ResizeHandles } from './handles/ResizeHandles';
import { RotateHandle } from './handles/RotateHandle';
import { MarqueeBox } from './handles/MarqueeBox';
import { isSelectionModifier, resolveClickSelection } from './core/selection';
import { useEditGesture } from './useEditGesture';
import { useLineHandleGesture } from './useLineHandleGesture';
import { useMarqueeGesture } from './useMarqueeGesture';
import { useResizeGesture } from './useResizeGesture';
import { useRotateGesture } from './useRotateGesture';
import { getResizeHandles } from './core/resize';
import { canRotate } from './core/rotate';
import { EMPTY_SELECTION, type EditableSlideCanvasProps } from './types';

/**
 * EditableSlideCanvas — the renderer v2 editing surface. It renders the
 * controlled document through the v1 read-only {@link SlideCanvas} (whose
 * render path is left untouched) and layers its own interaction surface on top:
 * a per-element hit layer that arms drag/click gestures, and a
 * {@link SelectionOverlay} driven by the controlled `selection`.
 *
 * Gestures are owned by {@link useEditGesture}: pointer-down + drag produces a
 * live working copy for 60fps feedback and, on pointer-up past a small
 * threshold, emits exactly one `element.update` intent via `onElementsChange`;
 * a click with no movement reports selection via `onSelectionChange` only.
 * Alignment guides are computed but not drawn in this PR.
 *
 * The interaction layer is a sibling overlay (same origin, positions scaled by
 * `canvasScale`) so the v1 fill/render contract is preserved unmodified. When
 * `scale` is omitted the canvas auto-fits: the overlay reads the SAME
 * `fitScale` SlideCanvas uses (both measure the same box — see the inner
 * wrapper below), so overlay and elements stay aligned at auto-fit.
 * `renderImage`/`renderVideo`/`className`/`style` pass through.
 *
 * The interaction hit layer is only mounted when a mutation/selection callback
 * is provided; with neither, the canvas renders read-only (no pointer-capturing
 * hit targets), matching the Stage-0 inert-without-callbacks contract.
 */
export function EditableSlideCanvas(props: EditableSlideCanvasProps) {
  const {
    slide,
    renderImage,
    renderVideo,
    className,
    style,
    selection,
    onSelectionChange,
    onElementsChange,
    snapping,
  } = props;

  const activeSelection = selection ?? EMPTY_SELECTION;
  const interactive = Boolean(onElementsChange || onSelectionChange);

  // Overlay wrapper is `inset: 0` of the same padding-free inner box that
  // SlideCanvas fills, so its container size — and therefore the fit-computed
  // `fitScale` and centering offset — is identical to SlideCanvas's own.
  // Computing `viewportStyles`/`fitScale` here lets the interaction layer sit
  // at the same on-screen origin and zoom as the rendered elements, including
  // when `scale` is omitted and both sides auto-fit.
  const overlayRef = useRef<HTMLDivElement>(null);
  const { viewportStyles, fitScale } = useViewportSize(overlayRef, {
    viewportSize: slide.viewportSize,
    viewportRatio: slide.viewportRatio,
  });
  const canvasScale = props.scale ?? fitScale;

  const { workingSlide, onElementPointerDown } = useEditGesture({
    slide,
    scale: canvasScale,
    selection: activeSelection,
    snapping,
    onSelectionChange,
    onElementsChange,
  });

  // Line-handle reshape gesture. It owns its own working copy (the dragged
  // line's re-normalized props) so a selected line's endpoint/control handles
  // can be dragged to reshape it. This is independent of the box move gesture
  // above — in practice only one is ever in flight — so we layer its working
  // props on top of the box gesture's `workingSlide` below.
  const { lineDrag, onHandlePointerDown } = useLineHandleGesture({
    scale: canvasScale,
    onElementsChange,
  });

  // Resize gesture (8-point handles on selected box elements). Like the line
  // gesture, it owns its own working copy (the resized box props), layered on
  // the box gesture's `workingSlide` below.
  const { resizeDrag, onResizeHandlePointerDown } = useResizeGesture({
    slide,
    scale: canvasScale,
    snapping,
    onElementsChange,
  });

  // Rotate gesture (the handle floating above a box's top edge). It converts
  // absolute pointer positions to canvas coordinates, so it needs the overlay
  // origin (`overlayRef` + `viewportStyles`) rather than just a scale.
  const { rotateDrag, onRotateHandlePointerDown } = useRotateGesture({
    overlayRef,
    viewportStyles,
    scale: canvasScale,
    onElementsChange,
  });

  // Marquee (rubber-band) gesture. It arms from a blank-canvas pointer-down on
  // the capture surface below the element hit targets, tracks a live rectangle,
  // and on release REPLACES the selection with whatever it covers (or clears it
  // on a sub-threshold blank click). The capture surface mounts for selection
  // hosts (`onSelectionChange` — see the surface comment below); the hook itself
  // also requires `onSelectionChange` to publish.
  const { marqueeRect, onCanvasPointerDown } = useMarqueeGesture({
    slide,
    scale: canvasScale,
    overlayRef,
    viewportStyles,
    selection: activeSelection,
    onSelectionChange,
  });

  // The elements to render/hit-test: the box gesture's working copy, with the
  // active handle drag's props (line reshape / resize box / rotate angle)
  // merged in so the v1 canvas, the hit layers, and the handles all preview
  // off the SAME working element and move together during a gesture. At most
  // one handle gesture is ever in flight (single-pointer hooks), so the merges
  // never compete.
  let displayElements = workingSlide.elements;
  if (lineDrag) {
    displayElements = displayElements.map((el) =>
      el.id === lineDrag.id ? ({ ...el, ...lineDrag.props } as PPTElement) : el,
    );
  }
  if (resizeDrag) {
    displayElements = displayElements.map((el) =>
      el.id === resizeDrag.id ? ({ ...el, ...resizeDrag.props } as PPTElement) : el,
    );
  }
  if (rotateDrag) {
    displayElements = displayElements.map((el) =>
      el.id === rotateDrag.id ? ({ ...el, rotate: rotateDrag.rotate } as PPTElement) : el,
    );
  }
  const displaySlide =
    displayElements === workingSlide.elements
      ? workingSlide
      : { ...workingSlide, elements: displayElements };

  const elements = displayElements;
  // Touch suppression belongs to mutation gestures: select-only hosts keep
  // native touch panning, while tap-select still receives pointer events.
  const editingTouchAction = onElementsChange ? 'none' : undefined;

  return (
    // Outer wrapper carries the documented `className`/`style` pass-through
    // (which may add padding). It fills its container by default (`width`/
    // `height: 100%`, merged BEFORE `...style` so a consumer can still override)
    // — without an explicit height the inner `height: 100%` (and SlideCanvas's
    // own `height: 100%`) would resolve against an auto-height box, so
    // `useViewportSize` reads `clientHeight ≈ 0`, `fitScale ≈ 0`, and the canvas
    // renders blank when `scale` is omitted. The inner wrapper below is
    // padding-free so that SlideCanvas (normal flow) and the overlay (`inset: 0`)
    // always measure the same box — otherwise consumer padding would diverge
    // their box models and misalign the overlay from the rendered elements.
    <div className={className} style={{ width: '100%', height: '100%', ...style }}>
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        {/* Pass `props.scale` (possibly undefined) THROUGH so SlideCanvas
            auto-fits with the same `fitScale` the overlay reads above. */}
        <SlideCanvas
          slide={displaySlide}
          scale={props.scale}
          renderImage={renderImage}
          renderVideo={renderVideo}
        />

        {/* Interaction overlay: hit targets below, selection chrome above.
            Every child is offset by the same `viewportStyles.left/top` that
            SlideCanvas applies to its element container, so overlay coordinates
            line up with the rendered elements even when the container is
            letterboxed (aspect ratio != slide's). */}
        <div ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {/* Blank-canvas marquee capture surface. Rendered FIRST so it sits
              beneath the per-element hit targets in stacking order: a pointer-
              down on an element hits that element's div (painted later, on top),
              while a pointer-down on empty canvas falls to this full-bleed layer
              and arms a rubber-band select. It is a sibling of the element hit
              divs (not an ancestor), so an element pointer-down never bubbles
              into it. Gated on SELECTION (`onSelectionChange`) so select-only
              mounts still get mouse/pen marquee and sub-threshold blank-clear.
              Touch suppression is gated separately on EDITABILITY
              (`onElementsChange`): select-only mounts preserve native touch
              panning, while touch-driven marquee requires an editable mount. */}
          {Boolean(onSelectionChange) && (
            <div
              data-marquee-surface=""
              onPointerDown={onCanvasPointerDown}
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'auto',
                touchAction: editingTouchAction,
              }}
            />
          )}
          {elements.map((el) => {
            // Line elements: a line's real hit area is its (often bent) stroke,
            // not its rectangular bounding box. A rectangular bbox blocker
            // would wrongly swallow clicks on other elements around a thin
            // diagonal line, and a straight start->end strip misses the
            // visible stroke of broken/broken2/curve/cubic lines (which bend
            // away from that chord) while blocking empty space where nothing
            // is drawn. Instead render an INERT SVG-path blocker that mirrors
            // the v1 line renderer pixel-for-pixel.
            //
            // v1 (src/elements/line/BaseLineElement.tsx:70-132) draws the line
            // at (el.left, el.top) inside SlideCanvas's `transform:
            // scale(canvasScale)` element container (SlideCanvas.tsx:153-163),
            // as an <svg overflow:visible> whose <path d={getLineElementPath}>
            // is in raw canvas units with stroke-width = el.width canvas units.
            // We reproduce that exactly: the wrapper sits at the same screen
            // origin as the other hit layers (viewportStyles.left/top +
            // coord*canvasScale) and the inner <svg> carries `transform:
            // scale(canvasScale)` (origin 0 0), so its raw-canvas-unit path maps
            // to the same on-screen pixels as the rendered line.
            //
            // `pointer-events: stroke` makes ONLY the fat transparent stroke a
            // hit target: it covers the visible line for EVERY path shape (P2)
            // and leaves the empty bbox click-through. The stroke width is the
            // grab band, at least the rendered stroke and at least a 10px
            // screen minimum (P3). It is INERT: `onPointerDown` only stops
            // propagation — no `data-element-id`, no gesture armed.
            // Known gap: endpoint markers (arrow/dot) can paint beyond the
            // stroke; their extents are NOT part of this hit target. Covering
            // them is deferred with line editing — the only fall-through case
            // is a marked line overlapping other content exactly at an
            // endpoint, on an element type that is not yet editable here.
            // A line is selected when its id is in the controlled selection.
            // Hit geometry and visual chrome are SPLIT into two paths (below):
            // a stable transparent blocker (the hit region, identical whether
            // or not the line is selected — so selecting a line never shrinks
            // its hit band) plus a separate, non-interactive highlight path
            // drawn only when selected. So a selected line has feedback in
            // EVERY state: read-only (no-callback), locked, or editable.
            // Handles (drawn much further below) are only added when the line
            // is EDITABLE (`onElementsChange`) and unlocked.
            const isSelected = activeSelection.elementIds.includes(el.id);
            if (el.type === 'line') {
              // Render the line's blocker/highlight path when it is either a
              // live hit target (interactive) OR selected (to draw the
              // highlight in a read-only mount). A read-only, unselected line
              // needs neither, so skip it.
              if (!interactive && !isSelected) return null;
              const path = getLineElementPath(el);
              // Match v1's svg box (min 24) so overflow:visible has a sensible
              // frame; the fat stroke can extend beyond it (not clipped).
              const spanW = Math.abs(el.start[0] - el.end[0]);
              const spanH = Math.abs(el.start[1] - el.end[1]);
              const svgWidth = spanW < 24 ? 24 : spanW;
              const svgHeight = spanH < 24 ? 24 : spanH;
              // Screen grab band, then converted to canvas units for the path
              // drawn inside the scale(canvasScale) svg (divide by scale so the
              // painted screen width is exactly `grabScreenPx`).
              const grabScreenPx = Math.max(10, el.width * canvasScale);
              const grabCanvas = canvasScale > 0 ? grabScreenPx / canvasScale : grabScreenPx;
              // Selection highlight stroke width, in the SAME canvas units the
              // blocker's stroke-width uses (the path is drawn inside a
              // `scale(canvasScale)` svg). At least the rendered stroke, and at
              // least 2 canvas units so a hairline line still shows a visible
              // highlight (~`max(2, el.width) * canvasScale` screen px).
              const highlightCanvas = Math.max(2, el.width);
              return (
                <div
                  key={el.id}
                  style={{
                    position: 'absolute',
                    left: `${viewportStyles.left + el.left * canvasScale}px`,
                    top: `${viewportStyles.top + el.top * canvasScale}px`,
                    width: 0,
                    height: 0,
                    pointerEvents: 'none',
                    overflow: 'visible',
                  }}
                >
                  <svg
                    overflow="visible"
                    width={svgWidth}
                    height={svgHeight}
                    style={{
                      overflow: 'visible',
                      transform: `scale(${canvasScale})`,
                      transformOrigin: '0 0',
                      pointerEvents: 'none',
                    }}
                  >
                    {/* Blocker path — the interaction hit region. It is
                        ALWAYS the same regardless of selection: a fat
                        transparent stroke (`grabCanvas`) whose `pointer-events:
                        stroke` band never changes when the line is selected.
                        This guarantees a selected thin line never lets clicks
                        fall through to a box beneath (selecting a line does NOT
                        shrink its hit band). It is INERT: `onPointerDown` only
                        stops propagation + selects-unless-locked; no drag is
                        armed. pointer-events is disabled entirely in a
                        read-only mount so a selected-but-read-only line never
                        captures the pointer. The visual selection chrome is a
                        SEPARATE, non-interactive highlight path below. */}
                    <path
                      data-hit-kind="line"
                      d={path}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={grabCanvas}
                      pointerEvents={interactive ? 'stroke' : 'none'}
                      onPointerDown={(e) => {
                        // Deferred limitation: line selection is handled here
                        // directly and bypasses `useEditGesture`, so it also
                        // bypasses the `activePointerRef` multi-pointer guard.
                        // A second pointer-down on a line during an in-flight
                        // box drag can therefore change the selection mid-
                        // gesture. More generally, the single-pointer guarantee
                        // is PER-HOOK: each gesture hook (move/marquee/line-
                        // handle/resize/rotate) guards only its own active
                        // pointer, so a second pointer can still arm a
                        // DIFFERENT hook's gesture concurrently. Cross-hook
                        // arbitration is deferred together with multi-touch
                        // support; single-pointer/mouse use (only one active
                        // pointer at a time) is unaffected.
                        //
                        // Always consume the pointer to block fall-through to
                        // an overlapped box beneath (even with no selection
                        // callback, and even when the line is locked). When a
                        // selection callback is provided, resolve the click
                        // through the SAME modifier/selection table as box
                        // elements ({@link resolveClickSelection}) so a
                        // modifier click adds/removes a line from a multi-
                        // selection too. A line is selectable but NOT draggable
                        // here: `armDrag` is ignored, no working copy is armed,
                        // and no move intent is ever emitted (line editing
                        // deferred).
                        e.stopPropagation();
                        // A locked line is inert like a locked box: it blocks
                        // fall-through (stopPropagation above) but must not be
                        // selected.
                        if (el.lock) return;
                        const { next } = resolveClickSelection({
                          element: el,
                          elements: slide.elements,
                          selection: activeSelection,
                          modifier: isSelectionModifier(e),
                        });
                        // `next` is null when nothing changes (e.g. a re-click
                        // on the current primary, or a subtractive click that
                        // would empty the selection) — no redundant re-emit.
                        if (next) onSelectionChange?.(next);
                      }}
                      style={{ cursor: 'default', touchAction: editingTouchAction }}
                    />
                    {/* Highlight path — selection chrome only, rendered when the
                        line is selected. Purely visual (`pointer-events: none`),
                        so it NEVER affects hit-testing — the blocker above owns
                        the entire hit region. Same `d`/position/scale as the
                        blocker; a thinner accent stroke (`highlightCanvas`).
                        Layered above the blocker, below the handles. Feedback in
                        read-only/locked/editable alike. */}
                    {isSelected && (
                      <path
                        data-hit-kind="line-highlight"
                        d={path}
                        fill="none"
                        stroke="#3b82f6"
                        strokeOpacity={0.7}
                        strokeWidth={highlightCanvas}
                        pointerEvents="none"
                        style={{ pointerEvents: 'none' }}
                      />
                    )}
                  </svg>
                </div>
              );
            }
            // Non-line elements never render an overlay node in a read-only
            // mount (no hit targets, no chrome — their selection border comes
            // from SelectionOverlay). Only lines draw a read-only highlight.
            if (!interactive) return null;
            // Non-line elements are narrowed here, so `width`/`height`/`rotate`
            // are directly available (no casts).
            return el.lock ? (
              // Locked elements (`el.lock`): the app editor guards locked
              // content from being moved, and — critically — a locked
              // element is the top rendered DOM node in the real app, so
              // it swallows the click rather than falling through to
              // whatever unlocked element sits beneath it. Mirror that
              // here with an INERT blocker at the same stacking position
              // (same map order, so it's on top when it visually
              // overlaps an unlocked element below it in the array):
              // `pointerEvents: 'auto'` consumes the pointer, but
              // `onPointerDown` is a no-op (no `onElementPointerDown`
              // call, no `data-element-id`) so no gesture is ever armed
              // and nothing beneath moves or gets selected. (A locked
              // element's selection border, if selected, is unaffected —
              // SelectionOverlay is untouched.)
              <div
                key={el.id}
                data-hit-kind="blocker"
                onPointerDown={(e) => {
                  e.stopPropagation();
                }}
                style={{
                  position: 'absolute',
                  left: `${viewportStyles.left + el.left * canvasScale}px`,
                  top: `${viewportStyles.top + el.top * canvasScale}px`,
                  width: `${el.width * canvasScale}px`,
                  height: `${el.height * canvasScale}px`,
                  transform: `rotate(${el.rotate}deg)`,
                  transformOrigin: 'center',
                  pointerEvents: 'auto',
                  cursor: 'default',
                  touchAction: editingTouchAction,
                }}
              />
            ) : (
              <div
                key={el.id}
                data-element-id={el.id}
                onPointerDown={(e) => onElementPointerDown(el, e)}
                style={{
                  position: 'absolute',
                  left: `${viewportStyles.left + el.left * canvasScale}px`,
                  top: `${viewportStyles.top + el.top * canvasScale}px`,
                  width: `${el.width * canvasScale}px`,
                  height: `${el.height * canvasScale}px`,
                  transform: `rotate(${el.rotate}deg)`,
                  transformOrigin: 'center',
                  pointerEvents: 'auto',
                  cursor: 'move',
                  touchAction: editingTouchAction,
                }}
              />
            );
          })}

          {/* Line handles: a selected, unlocked line's endpoint/control handles
              are its selection chrome (SelectionOverlay no longer draws a line
              border). Rendered above the stroke blocker so a handle pointer-
              down hits the handle, not the blocker beneath. Each handle reads
              the WORKING line (via `displayElements`), so during a reshape drag
              the handles track the previewed geometry. Handles use absolute
              SCREEN coordinates (they bake in `viewportStyles`), so they sit as
              direct children of the overlay, NOT inside the offset container.

              Gated on EDITABILITY (`onElementsChange`), not generic
              `interactive`: the reshape gesture no-ops without a mutation
              channel, so a select-only mount (only `onSelectionChange`) would
              otherwise show draggable handles that can never commit. In that
              case show NO handles — only the stroke highlight (feedback). */}
          {Boolean(onElementsChange) &&
            elements.map((el) => {
              if (el.type !== 'line') return null;
              if (!activeSelection.elementIds.includes(el.id) || el.lock) return null;
              return (
                <LineHandles
                  key={`line-handles-${el.id}`}
                  element={el}
                  viewportStyles={viewportStyles}
                  canvasScale={canvasScale}
                  onHandlePointerDown={(handle, e) => onHandlePointerDown(el, handle, e)}
                />
              );
            })}

          {/* Box operate handles: a selected, unlocked box element gets its
              8-point resize handles and, where the kind supports it, a rotate
              handle above the top edge. Per-kind gates live in the cores:
              `getResizeHandles` (text → width axis only, by `vertical`; code →
              none) and `canRotate` (chart/video/audio excluded). Lines are
              excluded entirely — their chrome is `LineHandles` above. Handles
              read the WORKING element (`elements`), so they track the live
              preview during a resize/rotate. Like the line handles they use
              absolute SCREEN coordinates (baking in `viewportStyles`) and are
              gated on EDITABILITY (`onElementsChange`), not generic
              `interactive`: without a mutation channel the gestures no-op, so
              a select-only mount shows no draggable handles. Shown only for a
              SINGLE-element selection: these gestures transform one element,
              and per-element handles on a multi-selection would misread as
              group scaling (which is a later slice). */}
          {Boolean(onElementsChange) &&
            activeSelection.elementIds.length === 1 &&
            elements.map((el) => {
              if (el.type === 'line') return null;
              if (!activeSelection.elementIds.includes(el.id) || el.lock) return null;
              const handles = getResizeHandles(el);
              const rotatable = canRotate(el);
              if (handles.length === 0 && !rotatable) return null;
              return (
                <Fragment key={`operate-${el.id}`}>
                  {handles.length > 0 && (
                    <ResizeHandles
                      element={el}
                      handles={handles}
                      viewportStyles={viewportStyles}
                      canvasScale={canvasScale}
                      onHandlePointerDown={(handle, e) => onResizeHandlePointerDown(el, handle, e)}
                    />
                  )}
                  {rotatable && (
                    <RotateHandle
                      element={el}
                      viewportStyles={viewportStyles}
                      canvasScale={canvasScale}
                      onPointerDown={(e) => onRotateHandlePointerDown(el, e)}
                    />
                  )}
                </Fragment>
              );
            })}

          {/* Live marquee rectangle, drawn while a blank-canvas rubber-band
              select is in flight. Purely visual (`pointerEvents: none`); it
              shares the element container's origin via `viewportStyles`. */}
          {marqueeRect && (
            <MarqueeBox
              rect={marqueeRect}
              viewportStyles={viewportStyles}
              canvasScale={canvasScale}
            />
          )}

          {/* SelectionOverlay is left untouched; wrap it in a positioning
              container matching SlideCanvas's element container so its
              per-element borders inherit the centering offset. */}
          <div
            style={{
              position: 'absolute',
              left: `${viewportStyles.left}px`,
              top: `${viewportStyles.top}px`,
              width: `${viewportStyles.width * canvasScale}px`,
              height: `${viewportStyles.height * canvasScale}px`,
              pointerEvents: 'none',
            }}
          >
            <SelectionOverlay elements={elements} selection={activeSelection} scale={canvasScale} />
          </div>
        </div>
      </div>
    </div>
  );
}
