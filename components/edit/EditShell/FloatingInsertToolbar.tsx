'use client';

import {
  AnimatePresence,
  motion,
  useDragControls,
  useReducedMotion,
  type MotionValue,
} from 'motion/react';
import { ChevronDown, GripHorizontal } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useCanvasStore } from '@/lib/store/canvas';
import type { InsertPaletteItem } from '@/lib/edit/scene-editor-surface';
import { CHROME_DURATION, CHROME_EASE } from '@/lib/edit/transitions';
import { cn } from '@/lib/utils';
// The palette and the element picker's list are the two canvas overlays that
// position themselves, so they share one host: the studio frame, via
// `CanvasOverlayPortal`. It lives beside the picker because that is where it was
// written; the frame it measures is chrome geometry, not slide-surface state.
import {
  CANVAS_OVERLAY_FRAME_SELECTOR,
  CANVAS_OVERLAY_Z,
  CanvasOverlayPortal,
} from '@/components/edit/surfaces/slide/CanvasOverlayPortal';
import { InsertButton } from './InsertButton';

interface Props {
  readonly items: readonly InsertPaletteItem[];
  readonly x: MotionValue<number>;
  readonly y: MotionValue<number>;
  /** Folded to its grip. Owned by the shell so a surface swap keeps it. */
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
}

/**
 * Persistent insert toolbar — floats over the studio canvas. Replaces the inline
 * insert slot in CommandBar so the global stage controls (back, undo
 * /redo, title, settings, Pro, Download) aren't visually mixed with
 * content-insertion affordances ("text box / image / shape ..." live
 * with the content, not with stage controls).
 *
 * Labels stay in tooltips so the vertical strip remains compact. A low-profile
 * grip lets authors move the strip anywhere inside the studio without shifting
 * the centered slide viewport or dedicating permanent layout space to it, and a
 * chevron beside the grip folds the strip down to that grip when the slide
 * underneath matters more than the tools.
 *
 * BOUNDS. The strip roams the STUDIO FRAME, not the slide card — the same
 * container the element picker's list is clamped to, reached the same way
 * (`CanvasOverlayPortal` + `CANVAS_OVERLAY_FRAME_SELECTOR`). Bounding it to the
 * card meant the strip could only ever sit on top of slide content: it could not
 * be parked in the grey padding beside the slide, and the card's
 * `overflow-hidden` clipped it on the way out. The portal's box has the frame's
 * geometry, so the drag constraints, the keyboard clamp and every measurement in
 * here mean what they always meant — one box larger.
 *
 * WHILE PICKING. The element picker deliberately covers the whole canvas, so the
 * strip rises above it (`paletteOverPicker`) to keep the picker's violet ring
 * from painting across it — and goes inert up there: it takes no pointer events,
 * so a click in its area falls through to the picker below and still means "pick
 * this element". Nothing in the strip is clickable until the pick ends; the
 * canvas underneath it is.
 */
export function FloatingInsertToolbar({ items, x, y, collapsed, onToggleCollapsed }: Props) {
  const { t } = useI18n();
  const prefersReducedMotion = useReducedMotion();
  const picking = useCanvasStore.use.pickTarget() !== null;
  const constraintsRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const [keyboardDragging, setKeyboardDragging] = useState(false);

  /**
   * Move the strip by (dx, dy), clamped so every edge stays inside the drag
   * boundary. Motion enforces `dragConstraints` during a gesture only, so both
   * of the non-gesture paths — the keyboard move and the re-clamp after the
   * fold changes the strip's height — come through here and share one rule.
   */
  const moveWithinBounds = (dx: number, dy: number) => {
    const bounds = constraintsRef.current?.getBoundingClientRect();
    const toolbar = toolbarRef.current?.getBoundingClientRect();
    if (!bounds || !toolbar) return;
    const clampedDx = Math.max(
      bounds.left - toolbar.left,
      Math.min(dx, bounds.right - toolbar.right),
    );
    const clampedDy = Math.max(
      bounds.top - toolbar.top,
      Math.min(dy, bounds.bottom - toolbar.bottom),
    );
    x.set(x.get() + clampedDx);
    y.set(y.get() + clampedDy);
  };

  const handleDragKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setKeyboardDragging((active) => !active);
      return;
    }
    if (event.key === 'Escape') {
      setKeyboardDragging(false);
      return;
    }
    if (!keyboardDragging || !event.key.startsWith('Arrow')) return;

    event.preventDefault();
    const step = event.shiftKey ? 24 : 8;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    moveWithinBounds(dx, dy);
  };

  if (items.length === 0) return null;

  const foldTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: CHROME_DURATION, ease: CHROME_EASE };

  return (
    <CanvasOverlayPortal
      zIndex={picking ? CANVAS_OVERLAY_Z.paletteOverPicker : CANVAS_OVERLAY_Z.palette}
      testId="insert-toolbar-layer"
      measureSelector={CANVAS_OVERLAY_FRAME_SELECTOR}
    >
      <div
        ref={constraintsRef}
        className="pointer-events-none absolute inset-2 flex items-center justify-start"
      >
        <motion.div
          ref={toolbarRef}
          data-testid="insert-toolbar"
          data-collapsed={collapsed}
          drag
          dragListener={false}
          dragControls={dragControls}
          dragConstraints={constraintsRef}
          dragElastic={0.04}
          dragMomentum={false}
          style={{ x, y }}
          whileDrag={{ scale: 1.02 }}
          className={cn(
            'flex flex-col items-center gap-1 p-1',
            picking ? 'pointer-events-none' : 'pointer-events-auto',
            'bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md',
            'ring-1 ring-zinc-200/80 dark:ring-zinc-700/80',
            'rounded-xl shadow-md',
          )}
        >
          {/* Grip and fold share one low-profile row, so a folded strip IS the
              grip — the same pairing the element picker's panel header uses. */}
          <div className="flex w-9 items-center">
            <button
              type="button"
              data-testid="insert-toolbar-drag-handle"
              aria-label={t('edit.insert.dragToolbarKeyboard')}
              aria-pressed={keyboardDragging}
              title={t('edit.insert.dragToolbar')}
              onPointerDown={(event) => {
                setKeyboardDragging(false);
                dragControls.start(event);
              }}
              onKeyDown={handleDragKeyDown}
              onBlur={() => setKeyboardDragging(false)}
              className="flex h-6 flex-1 touch-none cursor-grab items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500 focus-visible:outline-2 focus-visible:outline-violet-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-400"
            >
              <GripHorizontal className="h-3 w-3" strokeWidth={2} />
            </button>
            <button
              type="button"
              data-testid="insert-toolbar-collapse"
              onClick={onToggleCollapsed}
              aria-expanded={!collapsed}
              aria-label={
                collapsed ? t('edit.insert.expandToolbar') : t('edit.insert.collapseToolbar')
              }
              title={collapsed ? t('edit.insert.expandToolbar') : t('edit.insert.collapseToolbar')}
              className="grid h-6 w-4 shrink-0 place-items-center rounded-md text-zinc-300 transition-colors hover:bg-zinc-100 hover:text-zinc-500 focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-400"
            >
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', !collapsed && 'rotate-180')}
                strokeWidth={2}
                aria-hidden="true"
              />
            </button>
          </div>
          {/* The fold unmounts the buttons rather than hiding them: a folded
              strip must not keep three invisible tab stops. Expanding a strip
              parked at the frame's bottom edge grows it past that edge, so the
              re-clamp runs once the new height is settled — the same pitfall the
              element picker's panel re-clamps for. */}
          <AnimatePresence initial={false}>
            {!collapsed && (
              <motion.div
                key="insert-items"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={foldTransition}
                onAnimationComplete={() => moveWithinBounds(0, 0)}
                className="flex w-9 flex-col items-center gap-1 overflow-hidden"
              >
                {items.map((item) => (
                  <InsertButton key={item.id} item={item} iconOnly popoverSide="right" />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </CanvasOverlayPortal>
  );
}
