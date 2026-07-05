'use client';

import { SlideCanvas } from '../SlideCanvas';
import type { EditableSlideCanvasProps, Selection } from './types';

/**
 * EditableSlideCanvas — Stage 0 scaffold for the renderer v2 editing surface,
 * shipped under the `@openmaic/renderer/editing` subpath so the read-only entry
 * (`@openmaic/renderer`) never pulls the editing bundle.
 *
 * This scaffold renders through the v1 read-only SlideCanvas and supports
 * click-to-select only. Operate handles (drag / resize / rotate), alignment
 * snapping, and ProseMirror inline editing — and the `onElementsChange` intent
 * emission — land in Part A / Part B. See the editing-surface RFC for the
 * controlled edit-intent model this shell grows into.
 *
 * It forwards `className`/`style` straight to SlideCanvas (no wrapper element) so
 * the v1 fill/auto-fit contract is preserved unchanged.
 */
export function EditableSlideCanvas(props: EditableSlideCanvasProps) {
  const { slide, scale, renderImage, renderVideo, onSelectionChange, className, style } = props;

  return (
    <SlideCanvas
      slide={slide}
      scale={scale}
      renderImage={renderImage}
      renderVideo={renderVideo}
      className={className}
      style={style}
      onElementClick={
        onSelectionChange
          ? (element) => {
              const next: Selection = { elementIds: [element.id], primaryId: element.id };
              onSelectionChange(next);
            }
          : undefined
      }
    />
  );
}
