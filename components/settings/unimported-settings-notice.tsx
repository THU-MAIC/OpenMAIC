'use client';

/**
 * Settings of an earlier build that could not be moved to the server and are
 * kept in this browser instead (`lib/legacy-browser-import/model-settings-unimported.ts`):
 * listed with the reason, so the user can set them up again, until the user
 * discards them. One the view shows set up again leaves the list by itself: a
 * slot the workspace now sets, or a new workspace provider of its preset that
 * holds its key (see {@link settledUnimported}). A kept key is never dropped
 * on a guess: until then it can be copied, and only the user discards it.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Copy } from 'lucide-react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { maskKey, UNINFORMATIVE_KEY_MASK } from '@/lib/config/key-mask';
import type { SlotCapability } from '@/lib/config/model-slots';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  discardUnimported,
  forgetUnimported,
  readUnimported,
  unimportedKey,
  type UnimportedModelSetting,
  type UnimportedReason,
} from '@/lib/legacy-browser-import/model-settings-unimported';
import type { ModelSettingsView } from '@/lib/model-settings/client';

const CAPABILITY_LABEL: Record<SlotCapability, string> = {
  chat: 'settings.providers',
  tts: 'settings.ttsSettings',
  asr: 'settings.asrSettings',
  image: 'settings.imageSettings',
  video: 'settings.videoSettings',
  webSearch: 'settings.webSearchSettings',
  document: 'settings.documentParsingSettings',
};

const REASON_KEY: Record<UnimportedReason, string> = {
  refused: 'settings.unimported.reason.refused',
  reserved: 'settings.unimported.reason.reserved',
  'custom-service': 'settings.unimported.reason.customService',
  'key-pair': 'settings.unimported.reason.keyPair',
  unsupported: 'settings.unimported.reason.unsupported',
  unconfirmed: 'settings.unimported.reason.unconfirmed',
};

/**
 * The kept items the view shows were set up again, by {@link unimportedKey}.
 *
 * A slot is set up again once the workspace sets it. A provider is, once a
 * workspace provider of its preset that was not there when it was kept
 * (`knownProviders`) exists, and, when the kept item holds a key, that
 * provider holds the same key as far as the server says: its key is set,
 * readable, and its mask (the last four characters) is the kept key's. A key
 * too short to show in a mask, or a key pair (which a workspace provider
 * cannot hold), is never confirmed this way: the user discards it.
 */
export function settledUnimported(
  items: readonly UnimportedModelSetting[],
  view: ModelSettingsView,
): string[] {
  return items
    .filter((item) => {
      if (item.kind === 'slot') {
        return view.slots.some((slot) => slot.slot === item.id && slot.assignment !== undefined);
      }
      if (!item.preset) return false;
      const { apiKey, accessKeyId, accessKeySecret } = item.settings;
      if (accessKeyId || accessKeySecret) return false;
      const mask = apiKey ? maskKey(apiKey) : undefined;
      if (mask === UNINFORMATIVE_KEY_MASK) return false;
      const known = new Set(item.knownProviders ?? []);
      return view.providers.some(
        (provider) =>
          provider.source === 'workspace' &&
          provider.preset === item.preset &&
          !known.has(provider.id) &&
          (mask === undefined ||
            (provider.key?.set === true && !provider.key.unreadable && provider.key.mask === mask)),
      );
    })
    .map(unimportedKey);
}

export function UnimportedSettingsNotice({ view }: { view: ModelSettingsView }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  /** Bumped when the user discards the list, to read the storage again. */
  const [discarded, setDiscarded] = useState(0);

  // Read from the browser's storage whenever the view changes: what was set
  // up again leaves the list (and the storage, below).
  const { items, settled } = useMemo(() => {
    void discarded;
    const kept = readUnimported().items;
    const done = settledUnimported(kept, view);
    return { items: kept.filter((item) => !done.includes(unimportedKey(item))), settled: done };
  }, [view, discarded]);
  useEffect(() => {
    if (settled.length) forgetUnimported(settled);
  }, [settled]);

  if (!items.length) return null;

  const copyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      toast.success(t('settings.unimported.keyCopied'));
    } catch {
      toast.error(t('settings.unimported.copyFailed'));
    }
  };

  return (
    <div
      role="status"
      className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium">{t('settings.unimported.title')}</p>
          <p className="text-xs">{t('settings.unimported.description')}</p>
          <ul className="space-y-1.5">
            {items.map((item) => {
              const { apiKey, accessKeyId, accessKeySecret } = item.settings;
              const keyPair =
                accessKeyId || accessKeySecret
                  ? `AccessKey ID: ${accessKeyId ?? ''}\nAccessKey Secret: ${accessKeySecret ?? ''}`
                  : undefined;
              const key = apiKey ?? keyPair;
              return (
                <li
                  key={unimportedKey(item)}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-md bg-background/60 px-2 py-1.5"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-xs font-medium">
                      {item.kind === 'slot'
                        ? t('settings.unimported.modelChoice', {
                            slot: item.id,
                            assignment: item.settings.assignment ?? '—',
                          })
                        : item.capability
                          ? `${item.name} · ${t(CAPABILITY_LABEL[item.capability])}`
                          : item.name}
                    </p>
                    {item.settings.baseUrl && (
                      <p className="break-all font-mono text-[11px] opacity-80">
                        {item.settings.baseUrl}
                      </p>
                    )}
                    <p className="text-[11px] opacity-80">
                      {t(REASON_KEY[item.reason] ?? REASON_KEY.unconfirmed, {
                        detail: item.detail ?? '',
                      })}
                    </p>
                  </div>
                  {key && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 gap-1 text-xs"
                      onClick={() => void copyKey(key)}
                    >
                      <Copy className="size-3" />
                      {t(
                        apiKey ? 'settings.unimported.copyKey' : 'settings.unimported.copyKeyPair',
                      )}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setConfirming(true)}
            >
              {t('settings.unimported.dismiss')}
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.unimported.dismissTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.unimported.dismissDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                discardUnimported();
                setDiscarded((count) => count + 1);
                setConfirming(false);
              }}
            >
              {t('settings.unimported.dismiss')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
