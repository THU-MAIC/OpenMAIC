'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { subscribeToPersistHealth } from '@/lib/store/persist-health';

/**
 * Surfaces the persistence failures the user cannot otherwise notice.
 *
 * When the storage seam refuses to write — its key never hydrated, so writing
 * would replace stored data with defaults — the app keeps working, the store
 * keeps updating in memory, and every change is lost on reload. Renders nothing
 * until that happens.
 */
export function StorageHealthNotice() {
  const { t } = useI18n();

  useEffect(
    () =>
      subscribeToPersistHealth(({ name, status }) => {
        // One sticky toast per key: these states do not resolve on their own,
        // and repeating them per refused write would bury the app.
        const id = `persist-health:${name}`;
        if (status === 'recovered') {
          toast.dismiss(id);
          return;
        }
        toast.error(
          status === 'changes-lost'
            ? t('settings.persistChangesLost')
            : t('settings.persistUnavailable'),
          { id, duration: Infinity },
        );
      }),
    [t],
  );

  return null;
}
