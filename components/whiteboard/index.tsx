'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Eraser, History, Minus, PencilLine, Plus, RotateCcw, X } from 'lucide-react';
import type { PPTElement } from '@openmaic/dsl';
import type { WhiteboardElementReference } from '@/lib/types/chat';
import { ElementPickOverlay } from '@/components/canvas/slide-element-pick-overlay';
import {
  getDisplayedWhiteboard,
  isWhiteboardReferenceAvailable,
} from '@/lib/whiteboard/element-reference';
import { WhiteboardCanvas, type WhiteboardCanvasHandle } from './whiteboard-canvas';
import { WhiteboardWindow } from './whiteboard-window';
import { WhiteboardHistory } from './whiteboard-history';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { createStageAPI } from '@/lib/api/stage-api';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { refreshWhiteboardRuntimeProjection } from '@/lib/whiteboard/runtime/browser-projection';

interface WhiteboardProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  /**
   * Phone layout: the board fills the canvas region as a viewer of the teacher's
   * writing. Clearing and history are authoring tools and stay on desktop.
   */
  readonly mobile?: boolean;
  readonly elementPickActive?: boolean;
  readonly whiteboardElementReference?: WhiteboardElementReference;
  readonly onPickElement?: (element: PPTElement) => void;
  readonly onCancelElementPick?: () => void;
}

const MOBILE_ZOOM_STEP = 1.25;
const MOBILE_ZOOM_MIN = 0.2;
const MOBILE_ZOOM_MAX = 5;

/**
 * Whiteboard component
 */
export function Whiteboard({
  isOpen,
  onClose,
  mobile = false,
  elementPickActive,
  whiteboardElementReference,
  onPickElement,
  onCancelElementPick,
}: WhiteboardProps) {
  const { t } = useI18n();
  const stage = useStageStore.use.stage();
  const isClearing = useCanvasStore.use.whiteboardClearing();
  const clearingRef = useRef(false);
  const previousStageIdRef = useRef<string | undefined>(undefined);
  const wasOpenRef = useRef(isOpen);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [viewModified, setViewModified] = useState(false);
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<WhiteboardCanvasHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const snapshotCount = useWhiteboardHistoryStore((s) => s.snapshots.length);
  const runtimeProjection = useCanvasStore.use.runtimeWhiteboardProjection();

  // Get element count for indicator
  const { source, whiteboard } = getDisplayedWhiteboard(stage, runtimeProjection);
  const runtimeAuthoritative = source === 'runtime_store';
  const selectedElementId =
    whiteboardElementReference &&
    isWhiteboardReferenceAvailable(whiteboardElementReference, stage, runtimeProjection)
      ? whiteboardElementReference.elementId
      : undefined;
  const elementCount = whiteboard?.elements?.length || 0;

  useEffect(() => {
    const stageId = stage?.id;
    const stageChanged = previousStageIdRef.current !== stageId;
    const opened = !wasOpenRef.current && isOpen;
    previousStageIdRef.current = stageId;
    wasOpenRef.current = isOpen;

    if (!stageId) {
      useCanvasStore.getState().clearRuntimeWhiteboardProjection();
      return;
    }
    if (stageChanged || opened) {
      void refreshWhiteboardRuntimeProjection(stageId);
    }
  }, [isOpen, stage?.id]);

  useEffect(() => {
    if (runtimeAuthoritative) setHistoryOpen(false);
  }, [runtimeAuthoritative]);

  const stageAPI = createStageAPI(useStageStore);

  const handleClear = async () => {
    if (!whiteboard || elementCount === 0 || clearingRef.current) return;
    clearingRef.current = true;

    // Save snapshot before clearing
    if (whiteboard.elements && whiteboard.elements.length > 0) {
      useWhiteboardHistoryStore.getState().pushSnapshot(whiteboard.elements);
    }

    // Trigger cascade exit animation
    useCanvasStore.getState().setWhiteboardClearing(true);

    // Wait for cascade: base 380ms + 55ms per element, capped at 1400ms
    const animMs = Math.min(380 + elementCount * 55, 1400);
    await new Promise((resolve) => setTimeout(resolve, animMs));

    // Actually remove elements
    const result = stageAPI.whiteboard.delete(whiteboard.id);
    useCanvasStore.getState().setWhiteboardClearing(false);
    clearingRef.current = false;

    if (result.success) {
      toast.success(t('whiteboard.clearSuccess'));
    } else {
      toast.error(t('whiteboard.clearError') + result.error);
    }
  };

  const elementPickOverlay =
    (elementPickActive || selectedElementId) &&
    !runtimeAuthoritative &&
    !isClearing &&
    whiteboard &&
    onPickElement &&
    onCancelElementPick ? (
      <ElementPickOverlay
        key={elementPickActive ? 'picking' : 'selected'}
        elements={whiteboard.elements}
        picking={Boolean(elementPickActive)}
        selectedElementId={selectedElementId}
        scopeRef={contentRef}
        onPick={onPickElement}
        onCancel={onCancelElementPick}
        testId="whiteboard-element-pick-overlay"
      />
    ) : null;

  if (mobile) {
    const hasContent = elementCount > 0;
    const mobileIconButton =
      'w-11 h-11 shrink-0 grid place-items-center rounded-lg text-gray-500 dark:text-gray-400 active:bg-gray-100 dark:active:bg-gray-800 disabled:opacity-35';
    return (
      <AnimatePresence>
        {isOpen && (
          <motion.div
            data-testid="mobile-whiteboard"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.18 } }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            className="absolute inset-0 z-[120] flex flex-col overflow-hidden pointer-events-auto bg-white dark:bg-gray-900"
          >
            <div className="h-12 shrink-0 flex items-center gap-1 pl-3 pr-1 border-b border-gray-100 dark:border-gray-800">
              <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-gray-800 dark:text-gray-200">
                {t('mobileClassroom.whiteboardTitle')}
              </span>
              {hasContent && (
                <div className="flex items-center" data-testid="mobile-whiteboard-view-tools">
                  <button
                    type="button"
                    className={mobileIconButton}
                    aria-label={t('whiteboard.zoomOut')}
                    disabled={zoom <= MOBILE_ZOOM_MIN}
                    onClick={() => canvasRef.current?.setZoom(zoom / MOBILE_ZOOM_STEP)}
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <output
                    aria-live="polite"
                    className="min-w-[40px] text-center text-[11px] tabular-nums text-gray-500 dark:text-gray-400"
                  >
                    {Math.round(zoom * 100)}%
                  </output>
                  <button
                    type="button"
                    className={mobileIconButton}
                    aria-label={t('whiteboard.zoomIn')}
                    disabled={zoom >= MOBILE_ZOOM_MAX}
                    onClick={() => canvasRef.current?.setZoom(zoom * MOBILE_ZOOM_STEP)}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    className={mobileIconButton}
                    aria-label={t('whiteboard.resetView')}
                    disabled={!viewModified}
                    onClick={() => canvasRef.current?.resetView()}
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>
              )}
              <button
                type="button"
                className={mobileIconButton}
                aria-label={t('whiteboard.minimize')}
                onClick={onClose}
              >
                <X className="w-[18px] h-[18px]" />
              </button>
            </div>
            <div
              ref={contentRef}
              className="flex-1 min-h-0 relative overflow-hidden bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] dark:bg-[radial-gradient(#374151_1px,transparent_1px)] [background-size:20px_20px]"
            >
              <WhiteboardCanvas
                ref={canvasRef}
                whiteboard={whiteboard}
                onViewModifiedChange={setViewModified}
                onZoomChange={setZoom}
              />
              {elementPickOverlay}
              {!hasContent && !isClearing && (
                <div
                  data-testid="mobile-whiteboard-empty"
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center bg-white dark:bg-gray-900"
                >
                  <span className="w-11 h-11 grid place-items-center rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-400 mb-1">
                    <PencilLine className="w-5 h-5" />
                  </span>
                  <strong className="text-[13px] font-medium text-gray-800 dark:text-gray-200">
                    {t('whiteboard.mobileEmpty')}
                  </strong>
                  <p className="max-w-[240px] text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
                    {t('whiteboard.mobileEmptyHint')}
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <>
      {/* Main Whiteboard Overlay */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 30 }}
            animate={{
              opacity: 1,
              scale: 1,
              y: 0,
              transition: {
                type: 'spring',
                stiffness: 120,
                damping: 18,
                mass: 1.2,
              },
            }}
            exit={{
              opacity: 0,
              scale: 0.95,
              y: 16,
              transition: { duration: 0.5, ease: [0.4, 0, 0.2, 1] },
            }}
            className="pointer-events-none absolute inset-0 z-[120]"
          >
            <WhiteboardWindow
              // The classroom opens the sheet over the whole stage; the learner may then move it.
              initial={({ width, height }) => ({
                x: 16,
                y: 16,
                width: width - 32,
                height: height - 32,
              })}
              title={t('whiteboard.title')}
              whiteboard={whiteboard}
              contentRef={contentRef}
              onClose={onClose}
              actions={
                <>
                  {!runtimeAuthoritative && (
                    <>
                      <motion.button
                        type="button"
                        onClick={handleClear}
                        disabled={isClearing || elementCount === 0}
                        whileTap={{ scale: 0.9 }}
                        className="p-2 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none"
                        title={t('whiteboard.clear')}
                      >
                        <motion.div
                          animate={
                            isClearing ? { rotate: [0, -15, 15, -10, 10, 0] } : { rotate: 0 }
                          }
                          transition={
                            isClearing ? { duration: 0.5, ease: 'easeInOut' } : { duration: 0.2 }
                          }
                        >
                          <Eraser className="w-4 h-4" />
                        </motion.div>
                      </motion.button>
                      <div className="relative">
                        <motion.button
                          type="button"
                          onClick={() => setHistoryOpen(!historyOpen)}
                          whileTap={{ scale: 0.9 }}
                          className="relative p-2 text-gray-400 dark:text-gray-500 hover:text-purple-500 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-lg transition-colors"
                          title={t('whiteboard.history')}
                        >
                          <History className="w-4 h-4" />
                          {snapshotCount > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-purple-500 text-white text-[10px] font-bold flex items-center justify-center">
                              {snapshotCount}
                            </span>
                          )}
                        </motion.button>
                        <WhiteboardHistory
                          isOpen={historyOpen}
                          onClose={() => setHistoryOpen(false)}
                        />
                      </div>
                    </>
                  )}
                </>
              }
            >
              {elementPickOverlay}
            </WhiteboardWindow>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
