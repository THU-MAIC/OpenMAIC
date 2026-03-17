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

  const speak = useCallback(
    (text: string, voiceURI?: string) => {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        onError?.('浏览器不支持 Web Speech API');
        return;
      }

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

      utterance.onstart = () => {
        setIsSpeaking(true);
        setIsPaused(false);
        onStart?.();
      };

      utterance.onend = () => {
        setIsSpeaking(false);
        setIsPaused(false);
        utteranceRef.current = null;
        onEnd?.();
      };

      utterance.onerror = (event) => {
        setIsSpeaking(false);
        setIsPaused(false);
        utteranceRef.current = null;
        onError?.(event.error);
      };

      utterance.onpause = () => {
        setIsPaused(true);
      };

      utterance.onresume = () => {
        setIsPaused(false);
      };

      utteranceRef.current = utterance;
      window.speechSynthesis.speak(utterance);
    },
    [rate, pitch, volume, lang, availableVoices, onStart, onEnd, onError],
  );

  const pause = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.pause();
    }
  }, []);

  const resume = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.resume();
    }
  }, []);

  const cancel = useCallback(() => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
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
