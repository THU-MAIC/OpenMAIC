'use client';

import { useMemo } from 'react';

import { slotTTSProvidersConfig, ttsSelection, type TTSSelection } from '@/lib/audio/tts-selection';
import { useAccountVoices } from '@/lib/audio/use-account-voices';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { useSettingsStore } from '@/lib/store/settings';

/** Speech synthesis as the workspace's `tts` slot defines it, with the user's voice for it. */
export function useTTSSelection(): TTSSelection | null {
  const capabilities = useModelCapabilities();
  const { voices } = useAccountVoices();
  const voice = useSettingsStore((s) => s.ttsVoice);
  const voiceProviderId = useSettingsStore((s) => s.ttsVoiceProviderId);
  const account = useSettingsStore((s) => s.ttsVoiceAccount);
  const speed = useSettingsStore((s) => s.ttsSpeed);
  return useMemo(
    () =>
      ttsSelection(capabilities, { voice, providerId: voiceProviderId, speed, account }, voices),
    [capabilities, voice, voiceProviderId, speed, account, voices],
  );
}

/** The per-provider map the voice helpers read (see {@link slotTTSProvidersConfig}). */
export function useSlotTTSProvidersConfig() {
  const { tts } = useModelCapabilities();
  const { voices } = useAccountVoices();
  return useMemo(() => slotTTSProvidersConfig(tts, voices), [tts, voices]);
}
