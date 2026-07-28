'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { acknowledgePersistLoss, subscribeToPersistHealth } from '@/lib/store/persist-health';

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
        // Two toasts per key, deliberately not one. "Storage is down" is a
        // condition that recovery retracts; "your edits were lost" is a fact
        // that recovery does not undo, so they cannot share an id — dismissing
        // the first would take the second with it. Both are sticky and
        // de-duplicated: neither resolves on its own, and repeating them per
        // refused write would bury the app.
        if (status === 'changes-lost') {
          toast.error(t('settings.persistChangesLost'), {
            id: `persist-changes-lost:${name}`,
            duration: Infinity,
            // The only way out is the user acknowledging it — and the
            // acknowledgement has to reach the channel, or the same store
            // losing changes again is swallowed as a duplicate and a later
            // subscriber resurrects a toast that was already dealt with.
            closeButton: true,
            onDismiss: () => acknowledgePersistLoss(name),
          });
          return;
        }
        const id = `persist-unavailable:${name}`;
        if (status === 'recovered') {
          toast.dismiss(id);
          return;
        }
        toast.error(t('settings.persistUnavailable'), { id, duration: Infinity });
      }),
    [t],
  );

  return null;
}
