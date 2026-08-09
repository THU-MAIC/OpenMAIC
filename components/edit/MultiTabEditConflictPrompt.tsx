'use client';

import { Users } from 'lucide-react';
import { VisuallyHidden } from 'radix-ui';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useI18n } from '@/lib/hooks/use-i18n';

interface MultiTabEditConflictPromptProps {
  readonly open: boolean;
  readonly onDismiss: () => void;
  readonly onOpenChange?: (open: boolean) => void;
}

/**
 * Standalone refusal dialog the slide-surface PR will mount when
 * `tryAcquireEditLock` returns false on Pro-toggle entry. Pure
 * presenter — wiring (calling `tryAcquireEditLock` / `refreshEditLock`
 * / `releaseEditLock` against the current course id, generating a
 * tabId, etc.) lives in the slide surface's edit-entry effect.
 *
 * Single dismissive action only — the user has no remediation here
 * besides closing the other tab; this dialog just makes the refusal
 * visible instead of silently dropping the click.
 */
export function MultiTabEditConflictPrompt({
  open,
  onDismiss,
  onOpenChange,
}: MultiTabEditConflictPromptProps) {
  const { t } = useI18n();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm rounded-2xl p-0 overflow-hidden border-0 shadow-[0_25px_60px_-12px_rgba(0,0,0,0.15)] dark:shadow-[0_25px_60px_-12px_rgba(0,0,0,0.5)]">
        <VisuallyHidden.Root>
          <AlertDialogTitle>{t('edit.multiTab.conflict.title')}</AlertDialogTitle>
        </VisuallyHidden.Root>
        <div className="h-1 bg-gradient-to-r from-amber-400 via-orange-400 to-red-400" />
        <div className="px-6 pt-5 pb-2 flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-full bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center mb-4 ring-1 ring-amber-200/50 dark:ring-amber-700/30">
            <Users className="w-6 h-6 text-amber-500 dark:text-amber-400" />
          </div>
          <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-1.5">
            {t('edit.multiTab.conflict.title')}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
            {t('edit.multiTab.conflict.body')}
          </p>
        </div>
        <AlertDialogFooter className="px-6 pb-5 pt-3">
          <AlertDialogAction
            onClick={onDismiss}
            className="w-full rounded-xl bg-gray-800 hover:bg-gray-900 text-white border-0 shadow-sm dark:bg-gray-200 dark:hover:bg-white dark:text-gray-900"
          >
            {t('edit.multiTab.conflict.actionDismiss')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
