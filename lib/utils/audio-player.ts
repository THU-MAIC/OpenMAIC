/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations
 * Loads pre-generated TTS audio files from IndexedDB
 * Supports browser native TTS (Web Speech API) as fallback
 *
 */

import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';

const log = createLogger('AudioPlayer');

export interface BrowserTTSOptions {
  text: string;
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  lang?: string;
}

/**
 * Audio player implementation
 */
export class AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private onEndedCallback: (() => void) | null = null;
  private muted: boolean = false;
  private volume: number = 1;
  private playbackRate: number = 1;
  private browserTTSEnabled: boolean = false;
  private currentUtterance: SpeechSynthesisUtterance | null = null;

  /**
   * Enable or disable browser native TTS fallback
   * When enabled and no pre-generated audio found, will use Web Speech API
   */
  public setBrowserTTSEnabled(enabled: boolean): void {
    this.browserTTSEnabled = enabled;
  }

  /**
   * Play audio (from IndexedDB pre-generated cache)
   * @param audioId Audio ID
   * @param browserTTSOptions Optional browser TTS options for fallback
   * @returns true if audio started playing, false if no audio (TTS disabled or not generated)
   */
  public async play(audioId: string, browserTTSOptions?: BrowserTTSOptions): Promise<boolean> {
    try {
      // Skip IndexedDB lookup if using browser native TTS (audioId will be empty or not exist)
      let audioRecord = null;
      if (audioId && audioId.trim() !== '') {
        audioRecord = await db.audioFiles.get(audioId);
      }

      if (!audioRecord) {
        // Pre-generated audio does not exist - try browser native TTS if enabled
        if (this.browserTTSEnabled && browserTTSOptions?.text) {
          return this.playWithBrowserTTS(browserTTSOptions);
        }
        // Otherwise skip silently
        return false;
      }

      // Stop current playback (including browser TTS)
      this.stop();

      // Create audio element
      this.audio = new Audio();

      // Set audio source
      const blobUrl = URL.createObjectURL(audioRecord.blob);
      this.audio.src = blobUrl;
      if (this.muted) this.audio.volume = 0;
      else this.audio.volume = this.volume;

      // Apply playback rate
      this.audio.defaultPlaybackRate = this.playbackRate;
      this.audio.playbackRate = this.playbackRate;

      // Set ended callback
      this.audio.addEventListener('ended', () => {
        URL.revokeObjectURL(blobUrl);
        this.onEndedCallback?.();
      });

      // Play
      await this.audio.play();
      // Re-apply after play() — some browsers reset during load
      this.audio.playbackRate = this.playbackRate;
      return true;
    } catch (error) {
      log.error('Failed to play audio:', error);
      throw error;
    }
  }

  /**
   * Play audio using browser native Web Speech API
   * @param options Browser TTS options
   * @returns true if started playing, false if not supported
   */
  private async playWithBrowserTTS(options: BrowserTTSOptions): Promise<boolean> {
    if (!('speechSynthesis' in window)) {
      log.warn('Browser TTS not supported');
      return false;
    }

    // Ensure voices are loaded (they may load asynchronously)
    let voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) {
      // Wait for voices to load
      await new Promise<void>((resolve) => {
        const handleVoicesChanged = () => {
          voices = window.speechSynthesis.getVoices();
          if (voices.length > 0) {
            window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
            resolve();
          }
        };
        window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
        // Timeout after 1 second
        setTimeout(() => {
          window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
          resolve();
        }, 1000);
      });
    }

    // Stop any current playback
    this.stop();

    const utterance = new SpeechSynthesisUtterance(options.text);
    this.currentUtterance = utterance;

    // Apply options
    utterance.rate = options.rate ?? this.playbackRate;
    utterance.pitch = options.pitch ?? 1;
    utterance.volume = this.muted ? 0 : (options.volume ?? this.volume);
    utterance.lang = options.lang ?? 'zh-CN';

    // Find and set voice if specified
    if (options.voice) {
      const selectedVoice = voices.find(
        (v) => v.name === options.voice || v.lang === options.voice,
      );
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      } else {
        // Try to find a Chinese voice
        const zhVoice = voices.find((v) => v.lang?.startsWith('zh'));
        if (zhVoice) utterance.voice = zhVoice;
      }
    } else {
      // No voice specified, try to find a Chinese voice if lang is zh-CN
      if (utterance.lang === 'zh-CN') {
        const zhVoice = voices.find((v) => v.lang?.startsWith('zh'));
        if (zhVoice) utterance.voice = zhVoice;
      }
    }

    // Set callbacks
    utterance.onend = () => {
      this.currentUtterance = null;
      this.onEndedCallback?.();
    };
    utterance.onerror = (event) => {
      log.error('Browser TTS error:', event.error);
      this.currentUtterance = null;
      this.onEndedCallback?.();
    };

    // Start speaking
    window.speechSynthesis.speak(utterance);
    return true;
  }

  /**
   * Pause playback
   */
  public pause(): void {
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
    }
    // Also pause browser TTS
    if (this.currentUtterance && window.speechSynthesis) {
      window.speechSynthesis.pause();
    }
  }

  /**
   * Stop playback
   */
  public stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio = null;
    }
    // Also stop browser TTS
    if (this.currentUtterance && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      this.currentUtterance = null;
    }
    // Note: onEndedCallback intentionally NOT cleared here because play()
    // calls stop() internally — clearing would break the callback chain.
    // Stale callbacks are harmless: engine mode check prevents processNext().
  }

  /**
   * Resume playback
   */
  public resume(): void {
    if (this.audio?.paused) {
      this.audio.playbackRate = this.playbackRate;
      this.audio.play().catch((error) => {
        log.error('Failed to resume audio:', error);
      });
    }
    // Also resume browser TTS
    if (this.currentUtterance && window.speechSynthesis?.paused) {
      window.speechSynthesis.resume();
    }
  }

  /**
   * Get current playback status (actively playing, not paused)
   */
  public isPlaying(): boolean {
    // Check HTML audio
    if (this.audio !== null && !this.audio.paused) return true;
    // Check browser TTS - speechSynthesis.speaking is true when speaking or paused
    if (this.currentUtterance && window.speechSynthesis?.speaking) {
      // Check if actually speaking (not paused)
      return !window.speechSynthesis.paused;
    }
    return false;
  }

  /**
   * Whether there is active audio (playing or paused, but not ended)
   * Used to decide whether to resume playback or skip to the next line
   */
  public hasActiveAudio(): boolean {
    return this.audio !== null || this.currentUtterance !== null;
  }

  /**
   * Get current playback time (milliseconds)
   */
  public getCurrentTime(): number {
    return this.audio ? this.audio.currentTime * 1000 : 0;
  }

  /**
   * Get audio duration (milliseconds)
   */
  public getDuration(): number {
    return this.audio && !isNaN(this.audio.duration) ? this.audio.duration * 1000 : 0;
  }

  /**
   * Set playback ended callback
   */
  public onEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }

  /**
   * Set mute state (takes effect immediately on currently playing audio)
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audio) {
      this.audio.volume = muted ? 0 : this.volume;
    }
  }

  /**
   * Set volume (0-1)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio && !this.muted) {
      this.audio.volume = this.volume;
    }
  }

  /**
   * Set playback speed (takes effect immediately on currently playing audio)
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2, rate));
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
    }
  }

  /**
   * Destroy the player
   */
  public destroy(): void {
    this.stop();
    this.onEndedCallback = null;
  }
}

/**
 * Create an audio player instance
 */
export function createAudioPlayer(): AudioPlayer {
  return new AudioPlayer();
}
