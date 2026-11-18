/**
 * A thin, injectable seam over `window.speechSynthesis` and
 * `SpeechSynthesisUtterance`, plus the shared browser voice list.
 *
 * The default port reads the globals on every call rather than capturing them
 * once, so code (and tests) that replace them after import still see the
 * current object. A fake port lets the speech player run under Node.
 */

/** The part of `SpeechSynthesisUtterance` the speech player uses. */
export interface SpeechUtteranceLike {
  text: string;
  lang: string;
  voice: SpeechSynthesisVoice | null;
  rate: number;
  volume: number;
  onstart: (() => void) | null;
  /** Speech reached a word or sentence boundary: the utterance is making progress. */
  onboundary: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

export interface SpeechSynthesisPort {
  /** Whether the browser can speak at all. */
  isAvailable(): boolean;
  /** Whether any speech on the page is playing or queued, from this player or another. */
  isBusy(): boolean;
  getVoices(): SpeechSynthesisVoice[];
  /** Listen for `voiceschanged`; returns the unsubscribe function. */
  onVoicesChanged(listener: () => void): () => void;
  createUtterance(text: string): SpeechUtteranceLike;
  speak(utterance: SpeechUtteranceLike): void;
  cancel(): void;
}

/** The voice-list part of a port, which is all {@link BrowserVoiceCatalog} needs. */
export type SpeechVoiceSource = Pick<
  SpeechSynthesisPort,
  'isAvailable' | 'getVoices' | 'onVoicesChanged'
>;

export const VOICES_LOAD_TIMEOUT_MS = 2000;

function currentSynth(): SpeechSynthesis | undefined {
  return typeof window !== 'undefined' ? window.speechSynthesis || undefined : undefined;
}

function currentUtteranceConstructor(): typeof SpeechSynthesisUtterance | undefined {
  return typeof SpeechSynthesisUtterance === 'function' ? SpeechSynthesisUtterance : undefined;
}

/** A port over whatever synth `getSynth` returns at the time of each call. */
function createSynthPort(getSynth: () => SpeechSynthesis | undefined): SpeechSynthesisPort {
  return {
    isAvailable: () => !!getSynth() && !!currentUtteranceConstructor(),
    isBusy: () => {
      const synth = getSynth();
      return !!synth && (!!synth.speaking || !!synth.pending);
    },
    getVoices: () => getSynth()?.getVoices() ?? [],
    onVoicesChanged(listener) {
      const synth = getSynth();
      // Some environments expose speechSynthesis without EventTarget methods.
      if (!synth || typeof synth.addEventListener !== 'function') return () => {};
      synth.addEventListener('voiceschanged', listener);
      return () => synth.removeEventListener('voiceschanged', listener);
    },
    createUtterance(text) {
      const Utterance = currentUtteranceConstructor();
      if (!Utterance) throw new Error('Browser does not support Speech Synthesis API');
      return new Utterance(text) as unknown as SpeechUtteranceLike;
    },
    speak: (utterance) => getSynth()?.speak(utterance as unknown as SpeechSynthesisUtterance),
    cancel: () => getSynth()?.cancel(),
  };
}

/** The page's own speech synthesis, looked up on each call. */
export const browserSpeechSynthesis: SpeechSynthesisPort = createSynthPort(currentSynth);

const EMPTY_VOICES: SpeechSynthesisVoice[] = [];

function sameVoice(a: SpeechSynthesisVoice, b: SpeechSynthesisVoice): boolean {
  return (
    a === b ||
    (a.voiceURI === b.voiceURI &&
      a.name === b.name &&
      a.lang === b.lang &&
      a.localService === b.localService &&
      a.default === b.default)
  );
}

/**
 * The browser's voice list, shared by every consumer of one synth.
 *
 * - The snapshot is read from the synth on every call and keeps its previous
 *   reference while the list is unchanged, so it is safe for
 *   `useSyncExternalStore` and never goes stale: Chrome delivers voices in
 *   batches (network voices first, local voices later).
 * - `load()` waits for a non-empty list, with a timeout. Concurrent loads
 *   share one wait, and once a load has timed out later loads return
 *   immediately instead of waiting again for every sentence.
 */
export class BrowserVoiceCatalog {
  private snapshot: SpeechSynthesisVoice[] = EMPTY_VOICES;
  private pending: Promise<SpeechSynthesisVoice[]> | null = null;
  private timedOut = false;

  constructor(private readonly source: SpeechVoiceSource) {}

  /** The current voice list, as a stable reference while it is unchanged. */
  getSnapshot = (): SpeechSynthesisVoice[] => {
    const voices = this.source.getVoices();
    const previous = this.snapshot;
    if (
      voices.length !== previous.length ||
      voices.some((voice, i) => !sameVoice(voice, previous[i]))
    ) {
      this.snapshot = voices.length > 0 ? [...voices] : EMPTY_VOICES;
    }
    return this.snapshot;
  };

  /** Listen for voice list changes; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => this.source.onVoicesChanged(listener);

  /**
   * The voices when loading is settled: a non-empty list, or whatever is there
   * after a load timed out or when speech is unavailable. `null` while a caller
   * would still have to wait.
   */
  loaded(): SpeechSynthesisVoice[] | null {
    const voices = this.getSnapshot();
    if (voices.length > 0 || this.timedOut || !this.source.isAvailable()) return voices;
    return null;
  }

  /** Wait for a non-empty voice list, or give up after `timeoutMs`. */
  load(timeoutMs: number = VOICES_LOAD_TIMEOUT_MS): Promise<SpeechSynthesisVoice[]> {
    const voices = this.loaded();
    if (voices) return Promise.resolve(voices);
    if (this.pending) return this.pending;

    this.pending = new Promise<SpeechSynthesisVoice[]>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        this.pending = null;
        resolve(this.getSnapshot());
      };
      const timer = setTimeout(() => {
        this.timedOut = true;
        finish();
      }, timeoutMs);
      unsubscribe = this.source.onVoicesChanged(() => {
        if (this.source.getVoices().length > 0) finish();
      });
    });
    return this.pending;
  }
}

const unavailableCatalog = new BrowserVoiceCatalog(createSynthPort(() => undefined));
const catalogs = new WeakMap<SpeechSynthesis, BrowserVoiceCatalog>();

/**
 * The shared catalog for the page's current `speechSynthesis`.
 *
 * Keyed by the synth object, so replacing `window.speechSynthesis` (as tests
 * do) starts a fresh catalog instead of reusing another synth's state.
 */
export function getBrowserVoiceCatalog(): BrowserVoiceCatalog {
  const synth = currentSynth();
  if (!synth) return unavailableCatalog;
  let catalog = catalogs.get(synth);
  if (!catalog) {
    catalog = new BrowserVoiceCatalog(createSynthPort(() => synth));
    catalogs.set(synth, catalog);
  }
  return catalog;
}
