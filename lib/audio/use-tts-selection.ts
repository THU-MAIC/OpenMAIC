'use client';

import { useMemo, useSyncExternalStore } from 'react';

import type { AccountVoice } from '@/lib/audio/types';
import { slotTTSProvidersConfig, ttsSelection, type TTSSelection } from '@/lib/audio/tts-selection';
import { useAccountVoices } from '@/lib/audio/use-account-voices';
import { subscribeDeviceOwnerKey } from '@/lib/device-storage/owner-key';
import type { ModelCapabilities } from '@/lib/model-settings/capabilities';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { useSettingsStore } from '@/lib/store/settings';

/** Speech synthesis as the workspace's `tts` slot defines it, with the user's voice for it. */
export function useTTSSelection(): TTSSelection | null {
  const capabilities = useModelCapabilities();
  const { voices } = useAccountVoices();
  return useTTSSelectionFor(capabilities, voices);
}

/** The account can become known before or after its voice catalogue responds. */
export function useTTSSelectionFor(
  { tts, ttsVoiceAccount, ttsVoiceRejectionScope }: ModelCapabilities,
  voices: AccountVoice[],
) {
  const scope = useSyncExternalStore(
    subscribeDeviceOwnerKey,
    () => ttsVoiceAccount?.scope,
    () => undefined,
  );
  const missingVoice = ttsVoiceAccount?.missingVoice;
  const voice = useSettingsStore((s) => s.ttsVoice);
  const voiceProviderId = useSettingsStore((s) => s.ttsVoiceProviderId);
  const account = useSettingsStore((s) => s.ttsVoiceAccount);
  const speed = useSettingsStore((s) => s.ttsSpeed);
  return useMemo(
    () =>
      ttsSelection(
        { tts, ttsVoiceAccount: { scope, missingVoice }, ttsVoiceRejectionScope },
        { voice, providerId: voiceProviderId, speed, account },
        voices,
      ),
    [
      tts,
      scope,
      missingVoice,
      ttsVoiceRejectionScope,
      voice,
      voiceProviderId,
      speed,
      account,
      voices,
    ],
  );
}

/** The per-provider map the voice helpers read (see {@link slotTTSProvidersConfig}). */
export function useSlotTTSProvidersConfig() {
  const { tts } = useModelCapabilities();
  const { voices } = useAccountVoices();
  return useMemo(() => slotTTSProvidersConfig(tts, voices), [tts, voices]);
}
