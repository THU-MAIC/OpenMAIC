'use client';

import { BringToFront, SendToBack } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { reorderSlideElement } from './use-slide-surface';

const BTN =
  'flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100';

/**
 * To-front / to-back z-order buttons for the anchored bars. Two-way only —
 * intermediate forward/backward steps stay AI's domain. `onMouseDown`
 * preventDefault keeps the canvas selection alive until the click fires.
 */
export function ZOrderButtons({ elementId }: { readonly elementId: string }) {
  const { t } = useI18n();
  return (
    <>
      <button
        type="button"
        aria-label={t('edit.zorder.toFront')}
        title={t('edit.zorder.toFront')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => reorderSlideElement(elementId, 'front')}
        className={BTN}
      >
        <BringToFront className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label={t('edit.zorder.toBack')}
        title={t('edit.zorder.toBack')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => reorderSlideElement(elementId, 'back')}
        className={BTN}
      >
        <SendToBack className="h-4 w-4" />
      </button>
    </>
  );
}
