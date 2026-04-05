/**
 * Browser Native TTS (Text-to-Speech) Hook
 * Uses Web Speech API for client-side text-to-speech
 * Completely free, no API key required
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// Note: Window.SpeechSynthesis declaration is already in the global scope

export interface UseBrowserTTSOptions {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
  rate?: number; // 0.1 to 10
  pitch?: number; // 0 to 2
  volume?: number; // 0 to 1
  lang?: string; // e.g., 'zh-CN', 'en-US'
}

export function useBrowserTTS(options: UseBrowserTTSOptions = {}) {
  const {
    onStart,
    onEnd,
    onError,
    rate = 1.0,
    pitch = 1.0,
    volume = 1.0,
    lang = 'zh-CN',
  } = options;

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  /**
   * Cancel+re-speak state for instant pause & resume-from-position.
   *
   * Approach (same pattern as PlaybackEngine):
   * - pause():  call cancel() for instant silence; save text + last word boundary
   * - resume(): re-speak text.slice(lastBoundaryIndex) with the same voice
   *
   * This avoids the ~300ms delay of speechSynthesis.pause() and enables
   * resuming from approximate pause position rather than sentence start.
   */
  const pausedTextRef = useRef<string | null>(null);
  const pausedVoiceURIRef = useRef<string | undefined>(undefined);
  const lastBoundaryIndexRef = useRef(0);
  /** Flag to suppress onEnd/onError callbacks fired synchronously by cancel-for-pause */
  const cancellingForPauseRef = useRef(false);

  // Load available voices
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      return;
    }

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      setAvailableVoices(voices);
    };

    loadVoices();

    // Some browsers load voices asynchronously
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    return () => {
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  }, []);

  /**
   * Internal speak helper — shared by public speak() and resume().
   * @param isResume  When true, suppresses the onStart callback to avoid
   *                  duplicate side effects when resuming from pause.
   */
  const speakInternal = useCallback(
    (text: string, voiceURI?: string, isResume?: boolean) => {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        onError?.('浏览器不支持 Web Speech API');
        return;
      }

      // Reset pause-cancel flag — new speech (from speak() or resume()) means
      // any pending async onEnd/onError from a previous cancel-for-pause should
      // no longer be suppressed (they've either already fired or are stale).
      cancellingForPauseRef.current = false;

      // Cancel any ongoing speech
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = volume;
      utterance.lang = lang;

      // Set voice if specified
      if (voiceURI) {
        const voice = availableVoices.find((v) => v.voiceURI === voiceURI);
        if (voice) {
          utterance.voice = voice;
        }
      }

      // Track word boundaries for resume-from-position.
      // Save charIndex + charLength (= end of word) so resume skips the
      // word that was already spoken, rather than repeating it.
      utterance.onboundary = (event) => {
        if (event.name === 'word') {
          lastBoundaryIndexRef.current = event.charIndex + (event.charLength ?? 0);
        }
      };

      utterance.onstart = () => {
        setIsSpeaking(true);
        setIsPaused(false);
        if (!isResume) onStart?.();
      };

      utterance.onend = () => {
        if (cancellingForPauseRef.current) return; // suppress — pause handler owns state
        setIsSpeaking(false);
        setIsPaused(false);
        utteranceRef.current = null;
        pausedTextRef.current = null;
        onEnd?.();
      };

      utterance.onerror = (event) => {
        if (cancellingForPauseRef.current) return; // suppress — cancel-for-pause fires 'canceled'
        setIsSpeaking(false);
        setIsPaused(false);
        utteranceRef.current = null;
        pausedTextRef.current = null;
        onError?.(event.error);
      };

      utteranceRef.current = utterance;
      // Save full text + voice for potential pause+re-speak
      pausedTextRef.current = text;
      pausedVoiceURIRef.current = voiceURI;
      lastBoundaryIndexRef.current = 0;
      window.speechSynthesis.speak(utterance);
    },
    [rate, pitch, volume, lang, availableVoices, onStart, onEnd, onError],
  );

  const speak = useCallback(
    (text: string, voiceURI?: string) => {
      speakInternal(text, voiceURI, false);
    },
    [speakInternal],
  );

  const pause = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      // Cancel+re-speak pattern: cancel() is instant — no ~300ms delay
      // like speechSynthesis.pause(). Text + boundary position are already
      // saved by speakInternal, so resume() can re-speak from there.
      cancellingForPauseRef.current = true;
      window.speechSynthesis.cancel();
      // Keep cancellingForPauseRef = true for the entire pause period.
      // Chrome fires onend/onerror asynchronously after cancel(), so we
      // must NOT reset the flag here. It is reset in speakInternal() when
      // new speech starts (from speak() or resume()).
      setIsPaused(true);
    }
  }, []);

  const resume = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis && pausedTextRef.current) {
      const fullText = pausedTextRef.current;
      const voiceURI = pausedVoiceURIRef.current;
      // Slice from last word boundary for resume-from-position
      const remaining = fullText.slice(lastBoundaryIndexRef.current);
      pausedTextRef.current = null;
      setIsPaused(false);
      if (remaining.trim()) {
        speakInternal(remaining, voiceURI, true);
      } else {
        // Nothing left to speak — treat as natural end
        setIsSpeaking(false);
        utteranceRef.current = null;
        onEnd?.();
      }
    }
  }, [speakInternal, onEnd]);

  const cancel = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      pausedTextRef.current = null;
      cancellingForPauseRef.current = false;
      lastBoundaryIndexRef.current = 0;
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
      setIsPaused(false);
      utteranceRef.current = null;
    }
  }, []);

  return {
    speak,
    pause,
    resume,
    cancel,
    isSpeaking,
    isPaused,
    availableVoices,
  };
}
