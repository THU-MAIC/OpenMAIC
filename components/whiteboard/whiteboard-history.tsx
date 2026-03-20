'use client';

import { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RotateCcw } from 'lucide-react';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { createStageAPI } from '@/lib/api/stage-api';
import { elementFingerprint } from '@/lib/utils/element-fingerprint';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';

interface WhiteboardHistoryProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

/**
 * Whiteboard history dropdown panel.
 * Shows a list of saved whiteboard snapshots with timestamps and element counts.
 * Clicking "Restore" replaces the current whiteboard content with the snapshot.
 */
export function WhiteboardHistory({ isOpen, onClose }: WhiteboardHistoryProps) {
  const { t } = useI18n();
  const snapshots = useWhiteboardHistoryStore((s) => s.snapshots);
  const isClearing = useCanvasStore.use.whiteboardClearing();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay listener so the click that opens the panel doesn't immediately close it
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', handler);
    };
  }, [isOpen, onClose]);

  const handleRestore = (index: number) => {
    // P1: Block restore while a clear animation is in flight — the pending
    // delete/update would overwrite the restored content moments later.
    if (isClearing) {
      toast.error(t('whiteboard.restoreError'));
      return;
    }

    const snapshot = useWhiteboardHistoryStore.getState().getSnapshot(index);
    if (!snapshot) return;

    const stageStore = useStageStore;
    const stageAPI = createStageAPI(stageStore);

    // Get or create whiteboard
    const wbResult = stageAPI.whiteboard.get();
    if (!wbResult.success || !wbResult.data) {
      return;
    }
    const whiteboardId = wbResult.data.id;

    // P2a: Skip no-op restores — if the snapshot matches what's already
    // on screen, applying it would not change elementsKey, leaving
    // restoredKey armed indefinitely and suppressing a future snapshot.
    const restoredElementsKey = snapshot.fingerprint;
    const currentKey = elementFingerprint(wbResult.data.elements ?? []);
    if (restoredElementsKey === currentKey) {
      toast.success(t('whiteboard.restored'));
      onClose();
      return;
    }

    // Set restoredKey so auto-snapshot skips the incoming change
    useWhiteboardHistoryStore.getState().setRestoredKey(restoredElementsKey);

    // Transactional restore: replace all elements in one update() call
    // instead of looping delete/add which produces intermediate states.
    const result = stageAPI.whiteboard.update({ elements: snapshot.elements }, whiteboardId);

    if (!result.success) {
      // Restore failed — clear restoredKey so auto-snapshot isn't stuck
      useWhiteboardHistoryStore.getState().setRestoredKey(null);
      console.error('Failed to restore whiteboard snapshot:', result.error);
      // P3: Dedicated restoreError key (not clearError)
      toast.error(t('whiteboard.restoreError') + (result.error ?? ''));
      return;
    }

    toast.success(t('whiteboard.restored'));
    onClose();
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={panelRef}
          initial={{ opacity: 0, y: -8, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.95 }}
          transition={{ duration: 0.15 }}
          className="absolute top-14 right-4 z-[130] w-72 max-h-80 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              {t('whiteboard.history')}
            </span>
            <span className="text-xs text-gray-400">
              {snapshots.length > 0 ? `${snapshots.length}` : ''}
            </span>
          </div>

          {/* Snapshot list */}
          <div className="flex-1 overflow-y-auto">
            {snapshots.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
                {t('whiteboard.noHistory')}
              </div>
            ) : (
              <div className="py-1">
                {[...snapshots].reverse().map((snap, reverseIdx) => {
                  const realIdx = snapshots.length - 1 - reverseIdx;
                  return (
                    <div
                      key={`${snap.timestamp}-${realIdx}`}
                      className="px-4 py-2.5 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors group"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">
                          {snap.label || `#${realIdx + 1}`}
                        </div>
                        <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                          {formatTime(snap.timestamp)} ·{' '}
                          {t('whiteboard.elementCount').replace(
                            '{count}',
                            String(snap.elements.length),
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRestore(realIdx)}
                        disabled={isClearing}
                        className="ml-2 px-2 py-1 text-xs text-sky-600 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-900/20 rounded-md opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                      >
                        <RotateCcw className="w-3 h-3" />
                        {t('whiteboard.restore')}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
