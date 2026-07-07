'use client';

import { useRef } from 'react';

import { SlideCanvas } from '../SlideCanvas';
import { getLineElementPath } from '../utils/element';
import { useViewportSize } from '../hooks/useViewportSize';
import { SelectionOverlay } from './handles/SelectionOverlay';
import { useEditGesture } from './useEditGesture';
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

  const elements = workingSlide.elements;

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
          slide={workingSlide}
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
          {interactive &&
            elements.map((el) => {
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
              if (el.type === 'line') {
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
                      <path
                        data-hit-kind="line"
                        d={path}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={grabCanvas}
                        pointerEvents="stroke"
                        onPointerDown={(e) => {
                          // Always consume the pointer to block fall-through to
                          // an overlapped box beneath (even with no selection
                          // callback). When a selection callback is provided,
                          // also select the line — on pointer-down, for parity
                          // with box elements (which select via
                          // onElementPointerDown). A line is selectable but NOT
                          // draggable here: no working copy is armed and no
                          // move intent is ever emitted (line editing deferred).
                          e.stopPropagation();
                          onSelectionChange?.({ elementIds: [el.id], primaryId: el.id });
                        }}
                        style={{ cursor: 'default', touchAction: 'none' }}
                      />
                    </svg>
                  </div>
                );
              }
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
                    touchAction: 'none',
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
                    touchAction: 'none',
                  }}
                />
              );
            })}

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
