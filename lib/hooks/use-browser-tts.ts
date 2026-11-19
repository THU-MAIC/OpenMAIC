/**
 * Browser Native TTS (Text-to-Speech) Hook
 *
 * A React handle on one BrowserSpeechPlayer: speaks text with the Web Speech
 * API sentence by sentence, pauses by cancelling and resumes the sentence
 * from its start. Free, no API key required.
 */

import { useCallback, useEffect, useRef } from 'react';
import { BrowserSpeechPlayer, type SpeechLineSettings } from '@/lib/audio/browser-speech-player';

export interface UseBrowserTTSOptions {
  /** A line was spoken to the end (also when some of its sentences failed). */
  onEnd?: () => void;
  /** A sentence failed; the line continues with the next sentence. */
  onError?: (error: string) => void;
  /**
   * Language, rate, volume and mute, read before each sentence so that a
   * change applies from the next sentence. The voice comes from `speak`.
   */
  getSettings?: () => Omit<SpeechLineSettings, 'voice'>;
}

export function useBrowserTTS(options: UseBrowserTTSOptions = {}) {
  const optionsRef = useRef(options);
  const playerRef = useRef<BrowserSpeechPlayer | null>(null);

  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(
    () => () => {
      playerRef.current?.destroy();
      playerRef.current = null;
    },
    [],
  );

  /**
   * Speak `text`, replacing the current line. Resolves `false` when nothing
   * will be spoken (unsupported browser, blank text, or replaced while voices
   * were loading); `onEnd` is then not called for this line.
   */
  const speak = useCallback((text: string, voice?: string): Promise<boolean> => {
    let player = playerRef.current;
    if (!player) {
      player = new BrowserSpeechPlayer();
      player.onEnded(() => optionsRef.current.onEnd?.());
      player.onError((error) => optionsRef.current.onError?.(error.code));
      playerRef.current = player;
    }
    return player.play(text, () => ({ ...optionsRef.current.getSettings?.(), voice }));
  }, []);

  const pause = useCallback(() => playerRef.current?.pause(), []);
  const resume = useCallback(() => playerRef.current?.resume(), []);
  const cancel = useCallback(() => playerRef.current?.stop(), []);

  return { speak, pause, resume, cancel };
}
