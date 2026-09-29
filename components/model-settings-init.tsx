'use client';

import { useEffect } from 'react';

import { runModelSettingsImport } from '@/lib/legacy-browser-import/model-settings-import';
import { adoptNewerView } from '@/lib/model-settings/adopt-newer-view';
import { modelSettingsClient, type ModelSettingsClient } from '@/lib/model-settings/client';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Import the model settings an earlier build kept in this browser, once the
 * settings store has hydrated (its migration is what sets them aside), and
 * show the workspace's model settings as the import left them. Renders
 * nothing.
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

export function ModelSettingsInit() {
  useEffect(() => {
    const persist = useSettingsStore.persist;
    if (persist.hasHydrated()) {
      void importLegacyModelSettings();
      return;
    }
    let done = false;
    const unsubscribe = persist.onFinishHydration(() => {
      if (done) return;
      done = true;
      void importLegacyModelSettings();
    });
    return () => {
      done = true;
      unsubscribe();
    };
  }, []);

  return null;
}
