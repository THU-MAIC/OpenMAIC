/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations
 * Loads pre-generated TTS audio files from IndexedDB
 * Supports browser-native-tts (SpeechSynthesis) as fallback
 *
 */

import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';

const log = createLogger('AudioPlayer');

/**
 * TTS Configuration for browser-native-tts
 */
export interface BrowserTTSConfig {
  providerId: 'browser-native-tts';
  voice: string;
  speed: number;
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

  // Browser-native-tts state
  private browserTTSConfig: BrowserTTSConfig | null = null;
  private speechSynthesisUtterance: SpeechSynthesisUtterance | null = null;
  private browserTTSResolve: ((value: boolean) => void) | null = null;

  /**
   * Play audio (from URL or IndexedDB pre-generated cache)
   * @param audioId Audio ID
   * @param audioUrl Optional server-generated audio URL (takes priority over IndexedDB)
   * @returns true if audio started playing, false if no audio (TTS disabled or not generated)
   */
  public async play(audioId: string, audioUrl?: string): Promise<boolean> {
    try {
      // 1. Try audioUrl first (server-generated TTS)
      if (audioUrl && !this.browserTTSConfig) {
        this.stop();
        this.audio = new Audio();
        this.audio.src = audioUrl;
        if (this.muted) this.audio.volume = 0;
        else this.audio.volume = this.volume;
        this.audio.defaultPlaybackRate = this.playbackRate;
        this.audio.playbackRate = this.playbackRate;
        this.audio.addEventListener('ended', () => {
          this.onEndedCallback?.();
        });
        await this.audio.play();
        this.audio.playbackRate = this.playbackRate;
        return true;
      }

      // 2. Fall back to IndexedDB (client-generated TTS)
      const audioRecord = await db.audioFiles.get(audioId);

      if (!audioRecord) {
        // Pre-generated audio does not exist (generation failed), skip silently
        return false;
      }

      // Stop current playback
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
   * Pause playback
   */
  public pause(): void {
    // Pause HTML audio
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
    }
    // Pause browser-tts
    if (this.isBrowserTTSSpeaking() && !this.isBrowserTTSPaused()) {
      this.pauseBrowserTTS();
    }
  }

  /**
   * Stop playback
   */
  public stop(): void {
    // Stop HTML audio
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio = null;
    }
    // Stop browser-tts
    this.stopBrowserTTS();
    // Note: onEndedCallback intentionally NOT cleared here because play()
    // calls stop() internally — clearing would break the callback chain.
    // Stale callbacks are harmless: engine mode check prevents processNext().
  }

  /**
   * Resume playback
   */
  public resume(): void {
    // Resume HTML audio
    if (this.audio?.paused) {
      this.audio.playbackRate = this.playbackRate;
      this.audio.play().catch((error) => {
        log.error('Failed to resume audio:', error);
      });
    }
    // Resume browser-tts
    if (this.isBrowserTTSPaused()) {
      this.resumeBrowserTTS();
    }
  }

  /**
   * Get current playback status (actively playing, not paused)
   */
  public isPlaying(): boolean {
    // Check HTML audio
    if (this.audio !== null && !this.audio.paused) {
      return true;
    }
    // Check browser-tts
    if (this.isBrowserTTSSpeaking() && !this.isBrowserTTSPaused()) {
      return true;
    }
    return false;
  }

  /**
   * Whether there is active audio (playing or paused, but not ended)
   * Used to decide whether to resume playback or skip to the next line
   */
  public hasActiveAudio(): boolean {
    // Check HTML audio
    if (this.audio !== null) {
      return true;
    }
    // Check browser-tts (speaking or paused)
    if (
      'speechSynthesis' in window &&
      (window.speechSynthesis.speaking || window.speechSynthesis.paused)
    ) {
      return true;
    }
    return false;
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
    // Note: SpeechSynthesis rate cannot be changed mid-speech, only for new utterances
  }

  /**
   * Set browser-native-tts configuration
   */
  public setBrowserTTSConfig(config: BrowserTTSConfig | null): void {
    this.browserTTSConfig = config;
  }

  /**
   * Play audio with fallback to browser-native-tts
   * @param audioId Pre-generated audio ID (from IndexedDB)
   * @param text Text to speak if pre-generated audio not available (for browser-tts)
   * @returns true if any audio started playing, false if no audio
   */
  public async playWithFallback(audioId: string, text: string): Promise<boolean> {
    // If browser-native-tts is configured, always use it with the current voice setting
    // (user may have changed voice via locale switch, so pre-generated audio is stale)
    if (this.browserTTSConfig && text) {
      const browserTTSStarted = await this.playBrowserTTS(text);
      if (browserTTSStarted) {
        return true;
      }
    }

    // For other TTS providers: try pre-generated audio first (server-generated, voice is fixed)
    if (audioId) {
      const audioStarted = await this.play(audioId);
      if (audioStarted) {
        return true;
      }
    }

    // No audio available
    return false;
  }

  /**
   * Check if browser-native-tts is available and configured
   */
  public isBrowserTTSEnabled(): boolean {
    return this.browserTTSConfig !== null && 'speechSynthesis' in window;
  }

  /**
   * Play audio using browser-native-tts (SpeechSynthesis)
   * @param text Text to speak
   * @returns true if speech started, false if browser-tts not available
   */
  public async playBrowserTTS(text: string): Promise<boolean> {
    if (!this.browserTTSConfig || !('speechSynthesis' in window)) {
      return false;
    }

    try {
      // Stop any current playback
      this.stop();
      window.speechSynthesis.cancel();

      const { voice, speed } = this.browserTTSConfig;

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = speed;

      // Get voices - handle async loading
      const getVoices = (): SpeechSynthesisVoice[] => {
        const voices = window.speechSynthesis.getVoices();
        return voices.length > 0 ? voices : [];
      };

      let voices = getVoices();

      // If no voices loaded yet, wait for voiceschanged event (max 3 seconds)
      if (voices.length === 0) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 3000);
          const onVoicesChanged = () => {
            clearTimeout(timeout);
            voices = getVoices();
            window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
            resolve();
          };
          window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
        });
      }

      voices = getVoices();
      let selectedVoice: SpeechSynthesisVoice | null = null;
      let userLangCode: string | null = null;

      // Track whether user set a specific voice/language (not 'default')
      const userHasPreference = voice && voice !== 'default';

      if (voices.length > 0) {
        // 1. Try to match by exact voice name/id
        selectedVoice = voices.find((v) => v.name === voice || v.voiceURI === voice) || null;

        // 2. Try to match by language code (e.g. 'zh-HK', 'zh-CN', 'en-US')
        if (!selectedVoice && userHasPreference) {
          selectedVoice =
            voices.find((v) => v.lang === voice) ||
            voices.find((v) => v.lang.startsWith(voice)) ||
            voices.find((v) => voice.startsWith(v.lang)) ||
            voices.find((v) => v.lang.startsWith(voice.split('-')[0])) ||
            null;
        }
      }

      // 3. If user set a language preference but no matching voice found,
      // set utterance.lang directly so browser uses its best voice for that language
      if (!selectedVoice && userHasPreference) {
        userLangCode = voice;
        utterance.lang = voice;
      }

      // 4. Only use text auto-detection when user has NO explicit preference
      if (!selectedVoice && !userLangCode) {
        // Detect text language
        const hasMandarin = /[一-鿿㐀-䶿]/.test(text);
        const hasTraditionalChinese =
          /[一-鿿㐀-䶿]/.test(text) &&
          (/[們讓著開發區塊點擊收藏視頻音樂電影時尚遊戲科技運動汽車書籍新聞天氣應用程式]/u.test(
            text,
          ) ||
            /[會已經因為所以這個那個什麼哪裡誰怎樣為什麼能夠可以]/u.test(text));
        const hasCantonese = /[咁唔佢咁啲叻冇係咪梗噉咩]/u.test(text);
        const hasJapanese = /[぀-ゟ゠-ヿ]/.test(text);
        const hasKorean = /[가-힯]/.test(text);

        if (hasCantonese) {
          selectedVoice =
            voices.find((v) => v.lang.startsWith('yue')) ||
            voices.find((v) => v.lang.includes('HK')) ||
            voices.find((v) => v.lang.includes('Cantonese')) ||
            voices.find((v) => v.lang === 'zh-HK') ||
            voices.find((v) => v.lang === 'zh-TW') ||
            null;
        } else if (hasTraditionalChinese) {
          selectedVoice =
            voices.find((v) => v.lang.startsWith('zh-TW')) ||
            voices.find((v) => v.lang.includes('TW')) ||
            voices.find((v) => v.lang.includes('Hant')) ||
            voices.find((v) => v.lang === 'zh-HK') ||
            null;
        } else if (hasMandarin) {
          selectedVoice =
            voices.find((v) => v.lang.startsWith('zh-CN') || v.lang.startsWith('cmn')) ||
            voices.find((v) => v.lang.includes('CN') && !v.lang.includes('HK')) ||
            voices.find((v) => v.lang.includes('Hans')) ||
            null;
        } else if (hasJapanese) {
          selectedVoice = voices.find((v) => v.lang.startsWith('ja')) || null;
        } else if (hasKorean) {
          selectedVoice = voices.find((v) => v.lang.startsWith('ko')) || null;
        }
      }

      if (selectedVoice) {
        utterance.voice = selectedVoice;
        utterance.lang = selectedVoice.lang;
      }

      // Set up callbacks for speech end/error
      this.browserTTSResolve = (resolved) => {
        this.browserTTSResolve = null;
        this.speechSynthesisUtterance = null;
        if (resolved) {
          this.onEndedCallback?.();
        }
      };

      utterance.onend = () => {
        this.browserTTSResolve?.(true);
      };

      utterance.onerror = (event) => {
        // 'canceled' is expected when stop/pause is called — not a real error
        if (event.error !== 'canceled') {
          log.error('Browser TTS error:', event.error);
        }
        this.browserTTSResolve?.(false);
      };

      this.speechSynthesisUtterance = utterance;
      window.speechSynthesis.speak(utterance);

      return true;
    } catch (error) {
      log.error('Failed to play browser TTS:', error);
      return false;
    }
  }

  /**
   * Pause browser-native-tts
   */
  public pauseBrowserTTS(): void {
    if ('speechSynthesis' in window && window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
    }
  }

  /**
   * Resume browser-native-tts
   */
  public resumeBrowserTTS(): void {
    if ('speechSynthesis' in window && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  }

  /**
   * Stop browser-native-tts
   */
  public stopBrowserTTS(): void {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.speechSynthesisUtterance = null;
    this.browserTTSResolve = null;
  }

  /**
   * Check if browser-tts is currently speaking
   */
  public isBrowserTTSSpeaking(): boolean {
    return 'speechSynthesis' in window && window.speechSynthesis.speaking;
  }

  /**
   * Check if browser-tts is paused
   */
  public isBrowserTTSPaused(): boolean {
    return 'speechSynthesis' in window && window.speechSynthesis.paused;
  }

  /**
   * Destroy the player
   */
  public destroy(): void {
    this.stop();
    this.stopBrowserTTS();
    this.onEndedCallback = null;
  }
}

/**
 * Create an audio player instance
 */
export function createAudioPlayer(): AudioPlayer {
  return new AudioPlayer();
}
