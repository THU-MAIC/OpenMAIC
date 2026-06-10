'use client';

import { useSyncExternalStore } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { ASR_PROVIDERS } from '@/lib/audio/constants';
import type { BuiltInASRProviderId } from '@/lib/audio/types';

// Web Speech API support is constant per environment, so subscribing is a no-op.
const subscribe = () => () => {};
const getBrowserSpeechSupported = () =>
  !!(window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Single source of truth for "can the user use ASR right now".
 *
 * Combines the three things that gate speech input:
 * - the global on/off toggle (`asrEnabled`),
 * - whether the selected provider is actually usable (keyless, has a client
 *   key, or is server-managed — mirrors the `cfgOk` check in media-popover),
 * - and, for `browser-native`, whether the browser supports the Web Speech API.
 *
 * Consumed by `SpeechButton` so every call site is gated uniformly instead of
 * each one having to remember to wire the toggle through a `disabled` prop.
 */
export function useASRAvailable(): boolean {
  const asrEnabled = useSettingsStore((s) => s.asrEnabled);
  const asrProviderId = useSettingsStore((s) => s.asrProviderId);
  const providerConfig = useSettingsStore((s) => s.asrProvidersConfig[s.asrProviderId]);

  // SSR-safe Web Speech support check: the server snapshot assumes supported so
  // the button is never falsely disabled before hydration.
  const browserSpeechSupported = useSyncExternalStore(
    subscribe,
    getBrowserSpeechSupported,
    () => true,
  );

  const builtIn = ASR_PROVIDERS[asrProviderId as BuiltInASRProviderId];
  const requiresKey = builtIn ? builtIn.requiresApiKey : (providerConfig?.requiresApiKey ?? true);
  // Trim to match what the recorder actually sends — a whitespace-only key is
  // dropped at request time, so it must not count as configured here.
  const keyOk =
    !requiresKey || !!providerConfig?.apiKey?.trim() || !!providerConfig?.isServerConfigured;
  // Custom providers are unusable until at least one model is configured
  // (mirrors the media-popover listing rule that hides model-less customs).
  const modelOk = !!builtIn || (providerConfig?.customModels?.length ?? 0) > 0;
  const browserOk = asrProviderId !== 'browser-native' || browserSpeechSupported;

  return asrEnabled && keyOk && modelOk && browserOk;
}
