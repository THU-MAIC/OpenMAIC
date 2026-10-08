'use client';

import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Historical run result: regenerating audio later does not change this count. */
export function NarrationWarning({ count }: { count: number }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm"
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <p>{t('generation.narrationWarning', { count })}</p>
    </div>
  );
}
