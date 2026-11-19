import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserVoiceCatalog, getBrowserVoiceCatalog } from '@/lib/audio/browser-speech-synthesis';
import { FakeSpeechSynthesis, fakeVoice } from '../helpers/fake-speech-synthesis';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BrowserVoiceCatalog', () => {
  it('keeps the snapshot reference while the list is unchanged and refreshes it when voices change', () => {
    const network = fakeVoice('urn:network', 'en-US');
    const synth = new FakeSpeechSynthesis([network]);
    const catalog = new BrowserVoiceCatalog(synth);

    const first = catalog.getSnapshot();
    expect(first).toEqual([network]);
    // Equal voices from a fresh getVoices() array keep the same snapshot.
    synth.voices = [{ ...network } as SpeechSynthesisVoice];
    expect(catalog.getSnapshot()).toBe(first);

    const local = fakeVoice('urn:local', 'zh-CN');
    synth.setVoices([network, local]);
    const second = catalog.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.map((v) => v.voiceURI)).toEqual(['urn:network', 'urn:local']);
  });

  it('shares one wait between concurrent loads and resolves on the first non-empty list', async () => {
    vi.useFakeTimers();
    const synth = new FakeSpeechSynthesis([]);
    const catalog = new BrowserVoiceCatalog(synth);

    const a = catalog.load();
    const b = catalog.load();
    expect(b).toBe(a);
    expect(synth.listenerCount).toBe(1);
    expect(catalog.loaded()).toBeNull();

    // An empty voiceschanged does not end the wait.
    synth.setVoices([]);
    const voice = fakeVoice('en', 'en-US');
    synth.setVoices([voice]);
    await expect(a).resolves.toEqual([voice]);
    expect(synth.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(catalog.loaded()).toEqual([voice]);
  });

  it('gives up after the timeout and does not wait again', async () => {
    vi.useFakeTimers();
    const synth = new FakeSpeechSynthesis([]);
    const catalog = new BrowserVoiceCatalog(synth);

    const load = catalog.load();
    await vi.advanceTimersByTimeAsync(1999);
    expect(catalog.loaded()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await expect(load).resolves.toEqual([]);
    expect(synth.listenerCount).toBe(0);

    expect(catalog.loaded()).toEqual([]);
    await expect(catalog.load()).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves immediately when speech is unavailable', async () => {
    const synth = new FakeSpeechSynthesis([]);
    synth.available = false;
    await expect(new BrowserVoiceCatalog(synth).load()).resolves.toEqual([]);
  });

  it('notifies subscribers on voiceschanged', () => {
    const synth = new FakeSpeechSynthesis([]);
    const catalog = new BrowserVoiceCatalog(synth);
    const listener = vi.fn();
    const unsubscribe = catalog.subscribe(listener);
    synth.setVoices([fakeVoice('en', 'en-US')]);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    synth.setVoices([]);
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('getBrowserVoiceCatalog', () => {
  function stubSynth(voices: SpeechSynthesisVoice[]) {
    const synth = { getVoices: () => voices, cancel() {}, speak() {} };
    vi.stubGlobal('window', { speechSynthesis: synth });
    return synth;
  }

  it('shares one catalog per speechSynthesis object and starts fresh when it is replaced', () => {
    stubSynth([fakeVoice('a', 'en-US')]);
    const first = getBrowserVoiceCatalog();
    expect(getBrowserVoiceCatalog()).toBe(first);
    expect(first.getSnapshot().map((v) => v.voiceURI)).toEqual(['a']);

    stubSynth([fakeVoice('b', 'de-DE')]);
    const second = getBrowserVoiceCatalog();
    expect(second).not.toBe(first);
    expect(second.getSnapshot().map((v) => v.voiceURI)).toEqual(['b']);
  });

  it('tolerates a speechSynthesis without addEventListener', () => {
    stubSynth([]);
    const unsubscribe = getBrowserVoiceCatalog().subscribe(() => {});
    expect(unsubscribe).not.toThrow();
  });

  it('is empty without speech synthesis', async () => {
    vi.stubGlobal('window', {});
    expect(getBrowserVoiceCatalog().getSnapshot()).toEqual([]);
    await expect(getBrowserVoiceCatalog().load()).resolves.toEqual([]);
  });
});
