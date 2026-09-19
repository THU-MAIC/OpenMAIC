'use client';

/**
 * ElementRefPinLayer — the staged element references, ON the canvas.
 *
 * A chip in the composer says WHAT was referenced; this says WHERE. Each staged
 * element in the current scene keeps a numbered pin at its top-left corner and a
 * hairline frame, so the list above the input box and the page below it can be
 * read as one selection. The number is the ref's position, the same one the chip
 * shows.
 *
 * Always mounted next to the picker (not only while picking): the references
 * survive leaving pick mode, and a selection you cannot see is a selection you
 * forget you made. With no references in the current scene it measures nothing
 * and renders nothing.
 *
 * Pointer-transparent throughout: this is a read-out, and the canvas underneath
 * must stay fully editable while a reference is staged. Removing one happens on
 * its chip or in the lasso tool.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCanvasStore } from '@/lib/store/canvas';
import {
  useElementRefsForSession,
  useElementRefsHoveredForSession,
} from '@/lib/store/element-refs';
import { useStageStore } from '@/lib/store/stage';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { elementPaintNode, measureElementBox, type CanvasBox } from './element-hit-test';

export function ElementRefPinLayer() {
  const sessionId = useWorkbenchStore((s) => s.sessionId);
  const refs = useElementRefsForSession(sessionId);
  const hovered = useElementRefsHoveredForSession(sessionId);
  const currentSceneId = useStageStore.use.currentSceneId();
  const currentStageId = useStageStore((s) => s.stage?.id ?? null);
  // A new content object is the stage store's scene revision. Position-only
  // edits (for example keyboard nudges) do not resize the DOM node, so this is
  // the signal that complements ResizeObserver below.
  const sceneContent = useStageStore(
    (s) => s.scenes.find((scene) => scene.id === s.currentSceneId)?.content ?? null,
  );
  // A canvas zoom / pan is an ancestor transform, so the pins have to be
  // re-measured when it changes — the same reason `useTrackedRect` watches it.
  const canvasScale = useCanvasStore.use.canvasScale();
  const pickTarget = useCanvasStore.use.pickTarget();

  const rootRef = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Record<string, CanvasBox>>({});

  const sceneRefs = useMemo(
    () =>
      refs
        .flatMap((ref, index) =>
          ref.kind === 'slide-element'
            ? [
                {
                  elementId: ref.elementId,
                  stageId: ref.stageId,
                  sceneId: ref.sceneId,
                  ordinal: index + 1,
                },
              ]
            : [],
        )
        .filter((ref) => ref.stageId === currentStageId && ref.sceneId === currentSceneId),
    [refs, currentStageId, currentSceneId],
  );

  const hoveredElementId =
    hovered && hovered.stageId === currentStageId && hovered.sceneId === currentSceneId
      ? hovered.elementId
      : null;

  const measure = useCallback(() => {
    const next: Record<string, CanvasBox> = {};
    for (const ref of sceneRefs) {
      const box = measureElementBox(ref.elementId, rootRef.current);
      if (box && (box.width > 0 || box.height > 0)) next[ref.elementId] = box;
    }
    setBoxes(next);
  }, [sceneRefs]);

  useEffect(() => {
    if (sceneRefs.length === 0) return;
    // Measured after paint and coalesced to one frame. Scene-content changes
    // cover position-only edits; ResizeObserver covers intrinsic paint-size
    // changes such as text reflow. There is deliberately no standing rAF loop.
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    schedule();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('pointerup', schedule);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
    for (const ref of sceneRefs) {
      const paint = elementPaintNode(ref.elementId);
      if (paint) observer?.observe(paint);
    }
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('pointerup', schedule);
    };
  }, [measure, sceneRefs, sceneContent, canvasScale]);

  // Pick mode keeps the canvas clean except for the staged refs themselves:
  // the pick layer owns the current hover ring, while this layer contributes
  // only each already-picked ordinal (no persistent frame).
  const pickingElementRefs = pickTarget?.purpose === 'element-ref';
  const silent = sceneRefs.length === 0;

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[110]">
      {silent
        ? null
        : sceneRefs.map((ref) => {
            const box = boxes[ref.elementId];
            if (!box) return null;
            const isHovered = ref.elementId === hoveredElementId;
            return (
              <div
                key={ref.elementId}
                data-testid="element-ref-pin"
                className={
                  pickingElementRefs
                    ? 'absolute'
                    : isHovered
                      ? 'absolute rounded-[4px] bg-violet-500/[0.07] ring-2 ring-violet-500 transition-colors'
                      : 'absolute rounded-[4px] ring-1 ring-violet-400/55 transition-colors'
                }
                style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
              >
                <span
                  className={
                    isHovered
                      ? 'absolute -left-2 -top-2 grid size-[18px] place-items-center rounded-full bg-violet-500 font-mono text-[10px] font-semibold leading-none tabular-nums text-white shadow-md shadow-violet-500/30 ring-2 ring-white dark:ring-slate-900'
                      : 'absolute -left-2 -top-2 grid size-4 place-items-center rounded-full bg-violet-500/85 font-mono text-[9px] font-semibold leading-none tabular-nums text-white ring-2 ring-white dark:ring-slate-900'
                  }
                >
                  {ref.ordinal}
                </span>
              </div>
            );
          })}
    </div>
  );
}
