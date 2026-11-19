import type {
  SpeechSynthesisPort,
  SpeechUtteranceLike,
} from '@/lib/audio/browser-speech-synthesis';

export class FakeUtterance implements SpeechUtteranceLike {
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
  rate = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onboundary: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(public text: string) {}
}

export function fakeVoice(voiceURI: string, lang: string, name = voiceURI): SpeechSynthesisVoice {
  return { voiceURI, name, lang, localService: true, default: false } as SpeechSynthesisVoice;
}

/**
 * An in-memory speech synthesis, usable as a port or (with `FakeUtterance` as
 * `SpeechSynthesisUtterance`) as `window.speechSynthesis`. Utterances only
 * start, end or fail when a test says so. By default `cancel()` fires
 * `interrupted` on the utterance in flight synchronously, the least forgiving
 * timing a player has to handle.
 */
export class FakeSpeechSynthesis implements SpeechSynthesisPort {
  available = true;
  interruptOnCancel = true;
  voices: SpeechSynthesisVoice[];
  readonly spoken: FakeUtterance[] = [];
  cancelCount = 0;
  private inFlight: FakeUtterance | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(voices: SpeechSynthesisVoice[] = [fakeVoice('en', 'en-US')]) {
    this.voices = voices;
  }

  isAvailable(): boolean {
    return this.available;
  }

  getVoices(): SpeechSynthesisVoice[] {
    return this.voices;
  }

  isBusy(): boolean {
    return this.inFlight !== null;
  }

  onVoicesChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lets the fake stand in for `window.speechSynthesis` as well. */
  addEventListener(type: string, listener: () => void): void {
    if (type === 'voiceschanged') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'voiceschanged') this.listeners.delete(listener);
  }

  createUtterance(text: string): FakeUtterance {
    return new FakeUtterance(text);
  }

  speak(utterance: SpeechUtteranceLike): void {
    this.spoken.push(utterance as FakeUtterance);
    this.inFlight = utterance as FakeUtterance;
  }

  /** Lets the fake stand in for `window.speechSynthesis`: busy while an utterance is in flight. */
  get speaking(): boolean {
    return this.inFlight !== null;
  }

  get pending(): boolean {
    return false;
  }

  cancel(): void {
    this.cancelCount++;
    const utterance = this.inFlight;
    this.inFlight = null;
    if (utterance && this.interruptOnCancel) utterance.onerror?.({ error: 'interrupted' });
  }

  // ---- Test controls ----

  get listenerCount(): number {
    return this.listeners.size;
  }

  get texts(): string[] {
    return this.spoken.map((u) => u.text);
  }

  get last(): FakeUtterance {
    const utterance = this.spoken.at(-1);
    if (!utterance) throw new Error('Nothing has been spoken');
    return utterance;
  }

  setVoices(voices: SpeechSynthesisVoice[]): void {
    this.voices = voices;
    for (const listener of [...this.listeners]) listener();
  }

  /** Start and finish an utterance (the last one spoken by default). */
  finish(utterance: FakeUtterance = this.last): void {
    if (this.inFlight === utterance) this.inFlight = null;
    utterance.onstart?.();
    utterance.onend?.();
  }

  /** Report progress on an utterance (a word boundary). */
  boundary(utterance: FakeUtterance = this.last): void {
    utterance.onboundary?.();
  }

  fail(error: string, utterance: FakeUtterance = this.last): void {
    if (this.inFlight === utterance) this.inFlight = null;
    utterance.onerror?.({ error });
  }
}
