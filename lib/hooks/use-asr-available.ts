'use client';

import { useSyncExternalStore } from 'react';

import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';

// Web Speech API support is constant per environment, so subscribing is a no-op.
const subscribe = () => () => {};
const getBrowserSpeechSupported = () =>
  !!(window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Single source of truth for "can the user use ASR right now".
 *
 * Speech input is available when the workspace's asr slot resolves to a
 * provider (the server's model settings decide; turning the slot off turns
 * speech input off), and, for browser speech recognition, when the browser
 * supports the Web Speech API.
 *
 * Consumed by `SpeechButton` so every call site is gated uniformly instead of
 * each one having to remember to wire the toggle through a `disabled` prop.
 */
export function useASRAvailable(): boolean {
  const { asr } = useModelCapabilities();

  // SSR-safe Web Speech support check: the server snapshot assumes supported so
  // the button is never falsely disabled before hydration.
  const browserSpeechSupported = useSyncExternalStore(
    subscribe,
    getBrowserSpeechSupported,
    () => true,
  );

  if (!asr) return false;
  return asr.registryId !== 'browser-native' || browserSpeechSupported;
}
