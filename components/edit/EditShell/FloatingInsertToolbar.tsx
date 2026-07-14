'use client';

import { motion, useDragControls, type MotionValue } from 'motion/react';
import { GripHorizontal } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { InsertPaletteItem } from '@/lib/edit/scene-editor-surface';
import { cn } from '@/lib/utils';
import { InsertButton } from './InsertButton';

interface Props {
  readonly items: readonly InsertPaletteItem[];
  readonly x: MotionValue<number>;
  readonly y: MotionValue<number>;
}

/**
 * Persistent insert toolbar — floats inside the center-left edge of the studio
 * canvas. Replaces the inline insert slot in CommandBar so the global stage
 * controls (back, undo
 * /redo, title, settings, Pro, Download) aren't visually mixed with
 * content-insertion affordances ("text box / image / shape ..." live
 * with the content, not with stage controls).
 *
 * Labels stay in tooltips so the vertical strip remains compact. A low-profile
 * grip lets authors move the strip anywhere inside the studio without shifting
 * the centered slide viewport or dedicating permanent layout space to it.
 */
export function FloatingInsertToolbar({ items, x, y }: Props) {
  const { t } = useI18n();
  const constraintsRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const [keyboardDragging, setKeyboardDragging] = useState(false);

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

    const bounds = constraintsRef.current?.getBoundingClientRect();
    const toolbar = toolbarRef.current?.getBoundingClientRect();
    if (!bounds || !toolbar) return;

    event.preventDefault();
    const step = event.shiftKey ? 24 : 8;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
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

  if (items.length === 0) return null;

  return (
    <div
      ref={constraintsRef}
      className="pointer-events-none absolute inset-2 z-30 flex items-center justify-start"
    >
      <motion.div
        ref={toolbarRef}
        drag
        dragListener={false}
        dragControls={dragControls}
        dragConstraints={constraintsRef}
        dragElastic={0.04}
        dragMomentum={false}
        style={{ x, y }}
        whileDrag={{ scale: 1.02 }}
        className={cn(
          'pointer-events-auto flex flex-col items-center gap-1 p-1',
          'bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md',
          'ring-1 ring-zinc-200/80 dark:ring-zinc-700/80',
          'rounded-xl shadow-md',
        )}
      >
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
          className="flex h-6 w-9 touch-none cursor-grab items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500 focus-visible:outline-2 focus-visible:outline-violet-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-400"
        >
          <GripHorizontal className="h-3 w-3" strokeWidth={2} />
        </button>
        {items.map((item) => (
          <InsertButton key={item.id} item={item} iconOnly popoverSide="right" />
        ))}
      </motion.div>
    </div>
  );
}
