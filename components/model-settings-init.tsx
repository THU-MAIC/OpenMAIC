'use client';

import { useEffect } from 'react';

import { runModelSettingsImport } from '@/lib/legacy-browser-import/model-settings';
import { modelSettingsClient } from '@/lib/model-settings/client';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Import the model settings an earlier build kept in this browser, once the
 * settings store has hydrated (its migration is what sets them aside), and
 * read the workspace's model settings again when that changed them. Renders
 * nothing.
 */
export async function importLegacyModelSettings(): Promise<void> {
  const outcome = await runModelSettingsImport();
  if (outcome === 'imported') await modelSettingsClient.load();
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
