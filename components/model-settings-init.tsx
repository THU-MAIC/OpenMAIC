'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';

import { runModelSettingsImport } from '@/lib/legacy-browser-import/model-settings-import';
import { takeUnimportedNotice } from '@/lib/legacy-browser-import/model-settings-unimported';
import { useI18n } from '@/lib/hooks/use-i18n';
import { adoptNewerView } from '@/lib/model-settings/adopt-newer-view';
import { modelSettingsClient, type ModelSettingsClient } from '@/lib/model-settings/client';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Import the model settings an earlier build kept in this browser, once the
 * settings store has hydrated (its migration is what sets them aside), and
 * show the workspace's model settings as the import left them.
 */
export async function importLegacyModelSettings(
  client: ModelSettingsClient = modelSettingsClient,
): Promise<void> {
  let answered = false;
  const outcome = await runModelSettingsImport({
    // The view the import produced, kept over any older read still in flight.
    onImported: async (view) => {
      answered = true;
      await adoptNewerView(client, view);
    },
  });
  if (outcome === 'imported' && !answered) await client.load();
}

/** The toast's text, rendered inside the toaster so it follows the language once detected. */
function UnimportedToastText() {
  const { t } = useI18n();
  return <>{t('settings.unimported.toast')}</>;
}

/**
 * After the import: tell the user once, in a toast, about settings that could
 * not be moved to the server and are kept in this browser instead (Settings →
 * Model Services lists them until the user sets them up again or discards
 * them).
 */
export function announceUnimportedModelSettings(): void {
  if (!takeUnimportedNotice()) return;
  toast.warning(<UnimportedToastText />, { id: 'model-settings-unimported', duration: 15_000 });
}

async function run(): Promise<void> {
  try {
    await importLegacyModelSettings();
  } finally {
    announceUnimportedModelSettings();
  }
}

/** Runs the import on load. Renders nothing. */
export function ModelSettingsInit() {
  useEffect(() => {
    const persist = useSettingsStore.persist;
    if (persist.hasHydrated()) {
      void run();
      return;
    }
    let done = false;
    const unsubscribe = persist.onFinishHydration(() => {
      if (done) return;
      done = true;
      void run();
    });
    return () => {
      done = true;
      unsubscribe();
    };
  }, []);

  return null;
}
