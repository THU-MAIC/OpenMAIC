'use client';

import { History } from 'lucide-react';
import { VisuallyHidden } from 'radix-ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useI18n } from '@/lib/hooks/use-i18n';

interface SlideHistoryRestorePromptProps {
  readonly open: boolean;
  readonly onRestore: () => void;
  readonly onDiscard: () => void;
  /**
   * Mirrors Radix's AlertDialog `onOpenChange`. Closing the dialog via
   * outside click or `Escape` lands here with `open === false`; parent
   * decides whether that counts as discard or as "ask again later". The
   * default action buttons (`Restore` / `Discard`) call their handlers
   * directly and do NOT go through this callback first.
   */
  readonly onOpenChange?: (open: boolean) => void;
}

/**
 * Standalone prompt the slide-surface PR will mount when entering edit
 * mode and finds persisted history for the current scene. Pure
 * presenter — wiring (handler bodies, gating on
 * `hasPersistedSlideHistory(sceneId)`, etc.) belongs in the slide
 * surface's edit-entry effect.
 */
export function SlideHistoryRestorePrompt({
  open,
  onRestore,
  onDiscard,
  onOpenChange,
}: SlideHistoryRestorePromptProps) {
  const { t } = useI18n();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm rounded-2xl p-0 overflow-hidden border-0 shadow-[0_25px_60px_-12px_rgba(0,0,0,0.15)] dark:shadow-[0_25px_60px_-12px_rgba(0,0,0,0.5)]">
        <VisuallyHidden.Root>
          <AlertDialogTitle>{t('edit.history.restore.title')}</AlertDialogTitle>
        </VisuallyHidden.Root>
        <div className="h-1 bg-gradient-to-r from-violet-400 via-violet-500 to-indigo-400" />
        <div className="px-6 pt-5 pb-2 flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-full bg-violet-50 dark:bg-violet-900/20 flex items-center justify-center mb-4 ring-1 ring-violet-200/50 dark:ring-violet-700/30">
            <History className="w-6 h-6 text-violet-500 dark:text-violet-400" />
          </div>
          <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-1.5">
            {t('edit.history.restore.title')}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
            {t('edit.history.restore.body')}
          </p>
        </div>
        <AlertDialogFooter className="px-6 pb-5 pt-3 flex-row gap-3">
          <AlertDialogCancel onClick={onDiscard} className="flex-1 rounded-xl">
            {t('edit.history.restore.actionDiscard')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onRestore}
            className="flex-1 rounded-xl bg-violet-600 hover:bg-violet-700 text-white border-0 shadow-md shadow-violet-200/50 dark:bg-violet-500 dark:hover:bg-violet-400 dark:shadow-violet-900/30"
          >
            {t('edit.history.restore.actionRestore')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
