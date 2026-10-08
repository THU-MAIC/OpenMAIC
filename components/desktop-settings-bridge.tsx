'use client';

import { useEffect } from 'react';

import { modelSettingsClient, type ModelSettingsClient } from '@/lib/model-settings/client';
import { DESKTOP_SETTINGS_SYNC_VERSION } from '@/lib/store/settings-sync';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Run one poll without hiding whether the caller should retry. */
export async function syncDesktopSettingsOnce(
  fetchImpl: Fetch,
  client: Pick<ModelSettingsClient, 'load'>,
): Promise<'idle' | 'retry' | 'confirmed'> {
  try {
    const pending = await fetchImpl('/api/desktop-sync', { cache: 'no-store' });
    if (pending.status === 204) return 'idle';
    if (pending.status !== 200) return 'retry';
    const payload = (await pending.json()) as { id?: unknown; version?: unknown };
    if (payload.version !== DESKTOP_SETTINGS_SYNC_VERSION || typeof payload.id !== 'string') {
      return 'retry';
    }

    const post = (action: 'register' | 'apply' | 'confirm') =>
      fetchImpl('/api/desktop-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id: payload.id }),
      });
    if (!(await post('register')).ok) return 'retry';
    const applied = await post('apply');
    if (!applied.ok) return 'retry';
    const saved = (await applied.json()) as { saved?: unknown; revision?: unknown };
    if (
      saved.saved !== true ||
      (saved.revision !== null &&
        (typeof saved.revision !== 'number' || !Number.isInteger(saved.revision)))
    ) {
      return 'retry';
    }

    const state = await client.load({ fresh: true });
    const loadedRevision = state.view?.revision ?? -1;
    const savedRevision = saved.revision ?? -1;
    if (state.phase !== 'ready' || !state.view || loadedRevision < savedRevision) return 'retry';
    return (await post('confirm')).ok ? 'confirmed' : 'retry';
  } catch {
    return 'retry';
  }
}

/**
 * Ask the local server to copy one pending workspace configuration to this
 * desktop owner. Electron injects the session credential into these requests;
 * it is never exposed to renderer JavaScript.
 */
export function DesktopSettingsBridge() {
  useEffect(() => {
    if (!window.openmaicDesktop?.isDesktop) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const sync = async () => {
      await syncDesktopSettingsOnce(fetch, modelSettingsClient);
      if (!cancelled) timer = setTimeout(() => void sync(), 2000);
    };

    void sync();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  return null;
}
