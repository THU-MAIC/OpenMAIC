import { TTS_PROVIDERS } from '@/lib/audio/constants';

const voiceIdsWithBundledSamples = new Set(
  TTS_PROVIDERS['smallest-tts'].voices.map((v) => v.id),
);

/**
 * Public URL for a bundled Smallest AI voice preview clip (static WAV under /public).
 * Used instead of calling the TTS API when previewing voices in the UI.
 */
export function getBundledSmallestTtsVoiceSampleUrl(voiceId: string): string | null {
  if (!voiceIdsWithBundledSamples.has(voiceId)) return null;
  return `/audio/tts-previews/smallest-tts/${voiceId}.wav`;
}
