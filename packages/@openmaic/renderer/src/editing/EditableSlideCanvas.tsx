'use client';

import { useRef } from 'react';

import { SlideCanvas } from '../SlideCanvas';
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
              // Line elements: a line's real hit area is its thin (often
              // diagonal) stroke, not its rectangular bounding box. Rendering a
              // rectangular blocker over the bbox would wrongly swallow clicks
              // on other visible elements around a thin diagonal line, but
              // skipping the line entirely lets a pointer-down ON the stroke
              // fall through to a box underneath (moving/selecting the wrong
              // thing). Instead render an INERT stroke-shaped blocker: a thin
              // rotated rectangle laid along the A->B segment. It consumes
              // pointer-downs on the stroke (no gesture armed — `onPointerDown`
              // only stops propagation) while leaving the rest of the bbox
              // click-through. Selection + endpoint editing land in the line
              // slice; SelectionOverlay still draws no border for lines.
              if (el.type === 'line') {
                // Segment endpoints in canvas units: (left+start) -> (left+end).
                const ax = el.left + el.start[0];
                const ay = el.top + el.start[1];
                const bx = el.left + el.end[0];
                const by = el.top + el.end[1];
                const lengthPx = Math.hypot(bx - ax, by - ay) * canvasScale;
                const angleDeg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
                // Fixed screen-space grab thickness (NOT scaled by zoom): a
                // comfortable, zoom-independent hit band centered on the stroke.
                const LINE_HIT_WIDTH_PX = 10;
                return (
                  <div
                    key={el.id}
                    data-hit-kind="line"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
                    style={{
                      position: 'absolute',
                      // Anchor the div's left edge at endpoint A, then rotate the
                      // strip about its left-center so it lies along A->B with
                      // the stroke running through the band's vertical middle.
                      left: `${viewportStyles.left + ax * canvasScale}px`,
                      top: `${viewportStyles.top + ay * canvasScale}px`,
                      width: `${lengthPx}px`,
                      height: `${LINE_HIT_WIDTH_PX}px`,
                      transform: `translateY(-${LINE_HIT_WIDTH_PX / 2}px) rotate(${angleDeg}deg)`,
                      transformOrigin: 'left center',
                      pointerEvents: 'auto',
                      cursor: 'default',
                      touchAction: 'none',
                    }}
                  />
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
