'use client';

import { useMemo } from 'react';

import { slotTTSProvidersConfig, ttsSelection, type TTSSelection } from '@/lib/audio/tts-selection';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { useSettingsStore } from '@/lib/store/settings';

/** Speech synthesis as the workspace's `tts` slot defines it, with the user's voice for it. */
export function useTTSSelection(): TTSSelection | null {
  const capabilities = useModelCapabilities();
  const voice = useSettingsStore((s) => s.ttsVoice);
  const voiceProviderId = useSettingsStore((s) => s.ttsVoiceProviderId);
  const speed = useSettingsStore((s) => s.ttsSpeed);
  return useMemo(
    () => ttsSelection(capabilities, { voice, providerId: voiceProviderId, speed }),
    [capabilities, voice, voiceProviderId, speed],
  );
}

/** The per-provider map the voice helpers read (see {@link slotTTSProvidersConfig}). */
export function useSlotTTSProvidersConfig() {
  const { tts } = useModelCapabilities();
  return useMemo(() => slotTTSProvidersConfig(tts), [tts]);
}
