'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { subscribeToPersistUnavailable } from '@/lib/store/persist-health';

/**
 * Surfaces the one persistence failure the user cannot otherwise notice.
 *
 * When the storage seam refuses to write — its key never hydrated, so writing
 * would replace stored data with defaults — the app keeps working and every
 * change is lost on reload. Renders nothing until that happens.
 */
export function StorageHealthNotice() {
  const { t } = useI18n();

  useEffect(
    () =>
      subscribeToPersistUnavailable(() => {
        toast.error(t('settings.persistUnavailable'), {
          // Sticky and de-duplicated: this state does not resolve on its own,
          // and repeating it per refused write would bury the app.
          id: 'persist-unavailable',
          duration: Infinity,
        });
      }),
    [t],
  );

  return null;
}
