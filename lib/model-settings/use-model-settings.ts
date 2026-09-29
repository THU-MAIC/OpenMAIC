'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { modelCapabilities, type ModelCapabilities } from './capabilities';
import { modelSettingsClient, type ModelSettingsClient, type ModelSettingsView } from './client';

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

/**
 * What the workspace's model settings let the client do. Reads the settings
 * once per page (the settings UI and every other reader share the view), so it
 * is cheap to use in many components.
 */
export function useModelCapabilities(
  client: ModelSettingsClient = modelSettingsClient,
): ModelCapabilities {
  const view = useModelSettingsView(client);
  return useMemo(() => modelCapabilities(view), [view]);
}

/** The workspace's model settings view, read once per page (null until read). */
export function useModelSettingsView(
  client: ModelSettingsClient = modelSettingsClient,
): ModelSettingsView | null {
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  useEffect(() => {
    if (client.getState().phase === 'idle') void client.load();
  }, [client]);
  return state.view;
}
