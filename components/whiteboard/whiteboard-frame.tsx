'use client';

import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Minimize2, PencilLine, RotateCcw } from 'lucide-react';
import type { Whiteboard } from '@openmaic/dsl';
import { useI18n } from '@/lib/hooks/use-i18n';
import { WhiteboardCanvas } from './whiteboard-canvas';
import type { WhiteboardCanvasHandle } from './whiteboard-canvas';

/** The whiteboard sheet's surface; its host decides where the sheet sits. */
export const WHITEBOARD_SHELL_CLASS =
  'bg-white/95 dark:bg-gray-800/95 backdrop-blur-2xl rounded-3xl shadow-[0_32px_80px_-20px_rgba(0,0,0,0.25)] border-2 border-purple-200/60 dark:border-purple-700/60 flex flex-col overflow-hidden ring-4 ring-purple-100/40 dark:ring-purple-800/40';

/**
 * The whiteboard's title bar and canvas, shared by every place a board is shown. The host
 * supplies the board, its own toolbar actions and any layer over the canvas.
 */
export function WhiteboardFrame({
  title,
  whiteboard,
  onClose,
  actions,
  children,
  contentRef,
  draggable = false,
}: {
  readonly title: string;
  readonly whiteboard?: Whiteboard | null;
  readonly onClose: () => void;
  /** Host actions shown before the minimise button. */
  readonly actions?: ReactNode;
  /** Layers over the canvas, such as element picking. */
  readonly children?: ReactNode;
  readonly contentRef?: RefObject<HTMLDivElement | null>;
  /** Mark the title bar as the handle the surrounding window is dragged by. */
  readonly draggable?: boolean;
}) {
  const { t } = useI18n();
  const [viewModified, setViewModified] = useState(false);
  const canvasRef = useRef<WhiteboardCanvasHandle>(null);
  return (
    <>
      {/* Header */}
      <div
        data-window-drag={draggable ? '' : undefined}
        className={`h-14 px-6 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between shrink-0 bg-white/50 dark:bg-gray-800/50${draggable ? ' cursor-grab active:cursor-grabbing' : ''}`}
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center text-purple-600 dark:text-purple-400">
            <PencilLine className="w-4 h-4" />
          </div>
          <span className="font-bold text-gray-800 dark:text-gray-200 tracking-tight">{title}</span>
        </div>

        <div className="flex items-center gap-2">
          <AnimatePresence>
            {viewModified && (
              <motion.button
                type="button"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.15 }}
                onClick={() => canvasRef.current?.resetView()}
                whileTap={{ scale: 0.9 }}
                className="p-2 text-gray-400 dark:text-gray-500 hover:text-purple-500 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-lg transition-colors"
                title={t('whiteboard.resetView')}
              >
                <RotateCcw className="w-4 h-4" />
              </motion.button>
            )}
          </AnimatePresence>
          {actions}
          <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />
          <button
            type="button"
            onClick={onClose}
            data-testid="whiteboard-minimize"
            className="p-2 text-gray-400 dark:text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            title={t('whiteboard.minimize')}
          >
            <Minimize2 className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Whiteboard Content Area */}
      <div
        ref={contentRef}
        className="flex-1 relative bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#374151_1px,transparent_1px)] [background-size:24px_24px] overflow-hidden"
      >
        <WhiteboardCanvas
          ref={canvasRef}
          whiteboard={whiteboard}
          onViewModifiedChange={setViewModified}
        />
        {children}
      </div>
    </>
  );
}
