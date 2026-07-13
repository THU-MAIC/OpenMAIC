'use client';

import { motion, useDragControls } from 'motion/react';
import { GripHorizontal } from 'lucide-react';
import { useRef } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { InsertPaletteItem } from '@/lib/edit/scene-editor-surface';
import { cn } from '@/lib/utils';
import { InsertButton } from './InsertButton';

interface Props {
  readonly items: readonly InsertPaletteItem[];
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
export function FloatingInsertToolbar({ items }: Props) {
  const { t } = useI18n();
  const constraintsRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();

  if (items.length === 0) return null;

  return (
    <div
      ref={constraintsRef}
      className="pointer-events-none absolute inset-2 z-30 flex items-center justify-start"
    >
      <motion.div
        drag
        dragListener={false}
        dragControls={dragControls}
        dragConstraints={constraintsRef}
        dragElastic={0.04}
        dragMomentum={false}
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
          aria-label={t('edit.insert.dragToolbar')}
          title={t('edit.insert.dragToolbar')}
          onPointerDown={(event) => dragControls.start(event)}
          className="flex h-3 w-9 touch-none cursor-grab items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-400"
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
