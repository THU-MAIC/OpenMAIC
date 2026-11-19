/**
 * BrowserSpeechPlayer — sentence-by-sentence browser-native speech.
 *
 * The browser counterpart of `AudioPlayer` (play / pause / resume / stop /
 * onEnded), shared by classroom playback, roundtable discussion and voice
 * previews. It works around the Web Speech API's rough edges in one place:
 *
 * - Text is spoken one sentence per utterance. Chrome can cut off a long
 *   utterance without firing `onend`, which would stall whoever waits on it.
 * - Pause cancels the current sentence and resume speaks it again from its
 *   start, because `speechSynthesis.pause()` does not work in every browser.
 * - Settings (voice, language, rate, volume, mute) are read before each
 *   sentence, so a change applies from the next sentence.
 * - Every utterance event carries a token; events from a sentence that was
 *   paused, stopped, replaced or given up on are ignored.
 * - A sentence that shows no sign of progress (start, word boundary, end or
 *   error) for a generous deadline is cancelled and skipped (`stalled`), so
 *   playback cannot hang on it. Each sign of progress restarts the deadline,
 *   so a voice that is slow but still speaking is not cut off.
 * - The page has one speech queue. When another speaker (a voice preview)
 *   cancels this line's sentence, the line yields: it waits until that speech
 *   has ended, then speaks the interrupted sentence again, rather than cutting
 *   the other speaker off in turn.
 */

import { estimateSpeechDurationMs } from '@/lib/choreography/timing';
import { resolveBrowserVoice, splitSpeechSentences } from '@/lib/audio/browser-speech-text';
import {
  BrowserVoiceCatalog,
  browserSpeechSynthesis,
  getBrowserVoiceCatalog,
  type SpeechSynthesisPort,
  type SpeechUtteranceLike,
} from '@/lib/audio/browser-speech-synthesis';

export const MIN_SPEECH_RATE = 0.1;
export const MAX_SPEECH_RATE = 10;

/**
 * A sentence may go this many times its estimated reading time at the
 * requested rate (but never less than at normal speed: some voices cap the
 * rate they actually speak at) without a sign of progress…
 */
const STALL_FACTOR = 3;
/** …plus this much (network voices take a moment to start) before it counts as stalled. */
const STALL_GRACE_MS = 5000;

/** Error codes of an utterance that another speaker's `cancel()` cut off. */
const INTERRUPTION_CODES = new Set(['interrupted', 'canceled']);
/** How often a yielding line checks whether the other speech has ended. */
const YIELD_POLL_MS = 250;
/** How long a line yields at most before it speaks anyway. */
const MAX_YIELD_MS = 60_000;
/** How often one sentence is spoken again after interruptions before it is skipped. */
const MAX_INTERRUPTIONS = 2;

/** Settings for one sentence. */
export type SpeechLineSettings = {
  /** voiceURI, voice name or language tag; `default` or empty picks by text language. */
  voice?: string;
  /** Language fallback for text without a strong language signal. */
  locale?: string;
  /** Speech rate, clamped to 0.1–10. */
  rate?: number;
  /** Volume, 0–1. */
  volume?: number;
  muted?: boolean;
};

export type BrowserSpeechError = {
  /** The utterance's error code, `stalled`, or `synthesis-failed` when speaking threw. */
  code: string;
  /** The sentence that failed. */
  text: string;
};

export type BrowserSpeechPlayerOptions = {
  /** Speech synthesis to use; defaults to the page's own. */
  synth?: SpeechSynthesisPort;
  /** Voice list; defaults to one over `synth`, or the page's shared list. */
  voices?: BrowserVoiceCatalog;
  /** Skip sentences that never finish (default on). */
  stallGuard?: boolean;
};

export function clampSpeechRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate));
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.min(1, Math.max(0, volume));
}

export class BrowserSpeechPlayer {
  private readonly synth: SpeechSynthesisPort;
  private readonly voices: BrowserVoiceCatalog | null;
  private readonly stallGuard: boolean;

  private sentences: string[] = [];
  private index = 0;
  private settings: SpeechLineSettings | (() => SpeechLineSettings) | undefined;
  /** A line is in progress: from an accepted play() until it ends or is stopped. */
  private active = false;
  private paused = false;
  private waitingForVoices = false;
  /** An utterance has been handed to the synth and has not ended, failed or been cancelled. */
  private speaking = false;
  /** Bumped by stop() (and so by play()): a voice wait from an earlier line is stale. */
  private line = 0;
  /** Bumped whenever the sentence in flight is abandoned; older events are ignored. */
  private token = 0;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long the sentence in flight may go without progress. */
  private stallDeadlineMs = 0;
  /** Times the current sentence was interrupted by another speaker. */
  private interruptions = 0;

  private endedCallback: (() => void) | null = null;
  private startCallback: (() => void) | null = null;
  private errorCallback: ((error: BrowserSpeechError) => void) | null = null;

  constructor(options: BrowserSpeechPlayerOptions = {}) {
    this.synth = options.synth ?? browserSpeechSynthesis;
    this.voices = options.voices ?? (options.synth ? new BrowserVoiceCatalog(options.synth) : null);
    this.stallGuard = options.stallGuard ?? true;
  }

  /** Whether this browser can speak. */
  isSupported(): boolean {
    return this.synth.isAvailable();
  }

  /**
   * Speak `text`, replacing whatever this player was speaking.
   *
   * `settings` may be a function: it is then called before each sentence.
   * Resolves `true` once the line has started (it may still be waiting for the
   * voice list), and `false` when there is nothing to speak, speech is not
   * supported, or the line was replaced while waiting for voices. `onEnded`
   * fires only for lines that resolved `true`.
   */
  async play(
    text: string,
    settings?: SpeechLineSettings | (() => SpeechLineSettings),
  ): Promise<boolean> {
    this.stop();
    if (!this.isSupported()) return false;
    const sentences = splitSpeechSentences(text);
    if (sentences.length === 0) return false;

    const line = this.line;
    this.sentences = sentences;
    this.index = 0;
    this.settings = settings;
    this.active = true;

    const catalog = this.catalog();
    if (!catalog.loaded()) {
      this.waitingForVoices = true;
      await catalog.load();
      if (line !== this.line) return false;
      this.waitingForVoices = false;
    }
    if (!this.paused) this.speakCurrent();
    return true;
  }

  /** Pause by cancelling the current sentence; resume() speaks it again. */
  pause(): void {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.abandonSentence();
  }

  /** Continue a paused line from the start of the sentence it was paused in. */
  resume(): void {
    if (!this.active || !this.paused) return;
    this.paused = false;
    if (!this.waitingForVoices) this.speakCurrent();
  }

  /** Stop the line. `onEnded` does not fire for it, and its late events are ignored. */
  stop(): void {
    this.line++;
    this.abandonSentence();
    this.reset();
  }

  /** A line is in progress and not paused (it may be waiting for voices). */
  isPlaying(): boolean {
    return this.active && !this.paused;
  }

  isPaused(): boolean {
    return this.active && this.paused;
  }

  /** A line is in progress, playing or paused. */
  hasActiveSpeech(): boolean {
    return this.active;
  }

  /** Called once when a line has been spoken to the end, including when some of its sentences failed. */
  onEnded(callback: () => void): void {
    this.endedCallback = callback;
  }

  /** Called when each sentence starts speaking. */
  onStart(callback: () => void): void {
    this.startCallback = callback;
  }

  /**
   * Called when a sentence fails, before the line moves on to the next
   * sentence. The callback may stop() the line instead.
   */
  onError(callback: (error: BrowserSpeechError) => void): void {
    this.errorCallback = callback;
  }

  destroy(): void {
    this.stop();
    this.endedCallback = null;
    this.startCallback = null;
    this.errorCallback = null;
  }

  // ==================== Private ====================

  private catalog(): BrowserVoiceCatalog {
    return this.voices ?? getBrowserVoiceCatalog();
  }

  private readSettings(): SpeechLineSettings {
    return (typeof this.settings === 'function' ? this.settings() : this.settings) ?? {};
  }

  private reset(): void {
    this.active = false;
    this.paused = false;
    this.waitingForVoices = false;
    this.sentences = [];
    this.index = 0;
    this.settings = undefined;
    this.interruptions = 0;
  }

  /** Invalidate the sentence in flight and cancel its utterance, if there is one. */
  private abandonSentence(): void {
    this.token++;
    this.clearStallTimer();
    if (this.speaking) {
      this.speaking = false;
      this.synth.cancel();
    }
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private speakCurrent(): void {
    this.clearStallTimer();
    this.speaking = false;
    const token = ++this.token;
    if (this.index >= this.sentences.length) {
      this.reset();
      this.endedCallback?.();
      return;
    }

    const text = this.sentences[this.index];
    try {
      const settings = this.readSettings();
      const rate = clampSpeechRate(settings.rate ?? 1);
      const utterance = this.synth.createUtterance(text);
      const { voice, lang } = resolveBrowserVoice(
        this.catalog().getSnapshot(),
        settings.voice ?? '',
        text,
        settings.locale,
      );
      if (voice) utterance.voice = voice;
      utterance.lang = lang;
      utterance.rate = rate;
      utterance.volume = settings.muted ? 0 : clampVolume(settings.volume ?? 1);
      this.attach(utterance, token);

      // Chrome workaround: cancel() before speak() clears stale synthesis state
      // that can produce garbled or missing audio.
      this.synth.cancel();
      // State is set before speak(): some implementations fire events inside it.
      this.speaking = true;
      this.stallDeadlineMs =
        estimateSpeechDurationMs(text, { speed: Math.min(rate, 1) }) * STALL_FACTOR +
        STALL_GRACE_MS;
      this.armStallGuard(token);
      this.synth.speak(utterance);
    } catch {
      this.failSentence(token, 'synthesis-failed');
    }
  }

  private attach(utterance: SpeechUtteranceLike, token: number): void {
    utterance.onstart = () => {
      if (token !== this.token) return;
      this.armStallGuard(token);
      this.startCallback?.();
    };
    utterance.onboundary = () => {
      if (token === this.token) this.armStallGuard(token);
    };
    utterance.onend = () => {
      if (token !== this.token) return;
      this.interruptions = 0;
      this.index++;
      this.speakCurrent();
    };
    utterance.onerror = (event) => {
      if (token !== this.token) return;
      // The utterance is already over. Cancelling now could cut off speech that
      // another player started (that is often what interrupted this one).
      this.speaking = false;
      const code = event?.error || 'unknown';
      if (INTERRUPTION_CODES.has(code)) this.yieldSentence(token, code);
      else this.failSentence(token, code);
    };
  }

  /** (Re)start the deadline for the sentence in flight. */
  private armStallGuard(token: number): void {
    if (!this.stallGuard) return;
    this.clearStallTimer();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      this.failSentence(token, 'stalled');
    }, this.stallDeadlineMs);
  }

  /** Report a failed sentence, then move on to the next unless the callback took over. */
  private failSentence(token: number, code: string): void {
    if (token !== this.token) return;
    const text = this.sentences[this.index] ?? '';
    // Abandon first, so a cancel that fires the utterance's own error is ignored.
    this.abandonSentence();
    const next = this.token;
    this.errorCallback?.({ code, text });
    // pause(), stop() and play() all move the token on.
    if (next !== this.token) return;
    this.interruptions = 0;
    this.index++;
    this.speakCurrent();
  }

  /**
   * Another speaker's cancel() cut this sentence off. Report it, then wait until
   * that speech has ended (checking from the next poll, since some browsers
   * report the interruption before the other speech starts) and speak the
   * sentence again. A sentence interrupted too often is skipped instead.
   */
  private yieldSentence(token: number, code: string): void {
    if (++this.interruptions > MAX_INTERRUPTIONS) {
      this.failSentence(token, code);
      return;
    }
    const text = this.sentences[this.index] ?? '';
    this.abandonSentence();
    const next = this.token;
    this.errorCallback?.({ code, text });
    if (next !== this.token) return;
    const since = Date.now();
    const check = () => {
      this.stallTimer = null;
      if (next !== this.token) return;
      if (this.synth.isBusy() && Date.now() - since < MAX_YIELD_MS) {
        this.stallTimer = setTimeout(check, YIELD_POLL_MS);
      } else {
        this.speakCurrent();
      }
    };
    // The poll shares the stall timer slot, so pause() and stop() cancel it.
    this.stallTimer = setTimeout(check, YIELD_POLL_MS);
  }
}
