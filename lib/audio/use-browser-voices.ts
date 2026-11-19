'use client';

import { useSyncExternalStore } from 'react';
import { getBrowserVoiceCatalog } from '@/lib/audio/browser-speech-synthesis';

const NO_VOICES: SpeechSynthesisVoice[] = [];
const getServerSnapshot = () => NO_VOICES;

/**
 * The browser's speech voices, kept current as `voiceschanged` fires.
 * Empty during server rendering and where speech synthesis is unavailable.
 */
export function useBrowserVoices(): SpeechSynthesisVoice[] {
  const catalog = getBrowserVoiceCatalog();
  return useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, getServerSnapshot);
}
