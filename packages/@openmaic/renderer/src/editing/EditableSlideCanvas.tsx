'use client';

import { useRef } from 'react';
import type { PPTElement } from '@openmaic/dsl';

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
 * `scale`) so the v1 fill/render contract is preserved unmodified. `scale`
 * defaults to 1 — editing runs at a controlled zoom rather than auto-fit.
 * `renderImage`/`renderVideo`/`className`/`style` pass through.
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

  const scale = props.scale ?? 1;
  const activeSelection = selection ?? EMPTY_SELECTION;

  // Overlay wrapper is `inset: 0` of the same root that SlideCanvas fills, so
  // its container size — and therefore the fit-computed centering offset — is
  // identical to SlideCanvas's own. Computing `viewportStyles` here lets the
  // interaction layer sit at the same on-screen origin as the rendered
  // elements (`viewportStyles.left/top`), instead of the wrapper's (0,0).
  const overlayRef = useRef<HTMLDivElement>(null);
  const { viewportStyles } = useViewportSize(overlayRef, {
    viewportSize: slide.viewportSize,
    viewportRatio: slide.viewportRatio,
  });

  const { workingSlide, onElementPointerDown } = useEditGesture({
    slide,
    scale,
    selection: activeSelection,
    snapping,
    onSelectionChange,
    onElementsChange,
  });

  const elements = workingSlide.elements;

  return (
    <div
      className={className}
      style={{ position: 'relative', width: '100%', height: '100%', ...style }}
    >
      <SlideCanvas
        slide={workingSlide}
        scale={scale}
        renderImage={renderImage}
        renderVideo={renderVideo}
      />

      {/* Interaction overlay: hit targets below, selection chrome above.
          Every child is offset by the same `viewportStyles.left/top` that
          SlideCanvas applies to its element container, so overlay coordinates
          line up with the rendered elements even when the container is
          letterboxed (aspect ratio != slide's). */}
      <div ref={overlayRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {elements.map((el: PPTElement) => {
          const height = 'height' in el ? el.height : 0;
          const rotate = 'rotate' in el ? el.rotate : 0;
          return (
            <div
              key={el.id}
              data-element-id={el.id}
              onPointerDown={(e) => onElementPointerDown(el, e)}
              style={{
                position: 'absolute',
                left: `${viewportStyles.left + el.left * scale}px`,
                top: `${viewportStyles.top + el.top * scale}px`,
                width: `${el.width * scale}px`,
                height: `${height * scale}px`,
                transform: `rotate(${rotate}deg)`,
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
            width: `${viewportStyles.width * scale}px`,
            height: `${viewportStyles.height * scale}px`,
            pointerEvents: 'none',
          }}
        >
          <SelectionOverlay elements={elements} selection={activeSelection} scale={scale} />
        </div>
      </div>
    </div>
  );
}
