'use client';

import { useEffect, useSyncExternalStore } from 'react';

import { modelSettingsClient, type ModelSettingsClient } from './client';

/**
 * The workspace model settings, read from the server when the component
 * mounts (a cached view shows meanwhile), with the client to apply changes.
 */
export function useModelSettings(client: ModelSettingsClient = modelSettingsClient) {
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  useEffect(() => {
    void client.load();
  }, [client]);
  return { state, apply: client.apply, reload: client.load };
}
