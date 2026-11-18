import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserSpeechPlayer,
  clampSpeechRate,
  type BrowserSpeechError,
  type SpeechLineSettings,
} from '@/lib/audio/browser-speech-player';
import { estimateSpeechDurationMs } from '@/lib/choreography/timing';
import { FakeSpeechSynthesis, fakeVoice } from '../helpers/fake-speech-synthesis';

function setup(options: { voices?: SpeechSynthesisVoice[]; stallGuard?: boolean } = {}) {
  const synth = new FakeSpeechSynthesis(options.voices);
  const player = new BrowserSpeechPlayer({ synth, stallGuard: options.stallGuard ?? false });
  const ended = vi.fn();
  const errors: BrowserSpeechError[] = [];
  player.onEnded(ended);
  player.onError((error) => errors.push(error));
  return { synth, player, ended, errors };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BrowserSpeechPlayer', () => {
  it('speaks one sentence at a time and ends once after the last', async () => {
    const { synth, player, ended } = setup();

    await expect(player.play('First. Second! 第三句。')).resolves.toBe(true);
    expect(synth.texts).toEqual(['First.']);
    expect(player.isPlaying()).toBe(true);

    synth.finish();
    expect(synth.texts).toEqual(['First.', 'Second!']);
    synth.finish();
    expect(synth.texts).toEqual(['First.', 'Second!', '第三句。']);
    expect(ended).not.toHaveBeenCalled();
    synth.finish();

    expect(ended).toHaveBeenCalledOnce();
    expect(player.hasActiveSpeech()).toBe(false);
    expect(player.isPlaying()).toBe(false);
  });

  it('resolves false without speaking for blank text or an unsupported browser', async () => {
    const { synth, player, ended } = setup();
    await expect(player.play('   \n ')).resolves.toBe(false);
    synth.available = false;
    await expect(player.play('Hello.')).resolves.toBe(false);
    expect(player.isSupported()).toBe(false);
    expect(synth.spoken).toHaveLength(0);
    expect(ended).not.toHaveBeenCalled();
  });

  it('reads the settings before each sentence, so changes apply from the next one', async () => {
    const { synth, player } = setup();
    const settings: SpeechLineSettings = { rate: 1.5, volume: 0.8, locale: 'de-DE' };
    const read = vi.fn(() => ({ ...settings }));

    await player.play('Guten Morgen. 你好，这是第二句。 Third.', read);
    expect(synth.last).toMatchObject({ rate: 1.5, volume: 0.8, lang: 'de-DE' });

    settings.rate = 2;
    settings.volume = 0.3;
    settings.locale = 'zh-TW';
    expect(synth.last.rate).toBe(1.5);
    synth.finish();
    expect(synth.last).toMatchObject({ rate: 2, volume: 0.3, lang: 'zh-TW' });

    settings.muted = true;
    synth.finish();
    expect(synth.last.volume).toBe(0);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('clamps the rate to what browsers accept', async () => {
    expect(clampSpeechRate(20)).toBe(10);
    expect(clampSpeechRate(0.01)).toBe(0.1);
    expect(clampSpeechRate(Number.NaN)).toBe(1);
    expect(clampSpeechRate(1.25)).toBe(1.25);

    const { synth, player } = setup();
    await player.play('Fast.', { rate: 5 * 2 * 2 });
    expect(synth.last.rate).toBe(10);
  });

  it('resolves the voice by voiceURI, name or language, and binds a Vietnamese voice for Vietnamese text', async () => {
    const english = fakeVoice('urn:english', 'en-GB', 'Daniel');
    const vietnamese = fakeVoice('urn:vi', 'vi-VN', 'Linh');
    const { synth, player } = setup({ voices: [english, vietnamese] });

    await player.play('Hello.', { voice: 'urn:english' });
    expect(synth.last).toMatchObject({ voice: english, lang: 'en-GB' });
    await player.play('Hello.', { voice: 'Daniel' });
    expect(synth.last.voice).toBe(english);
    await player.play('Hello.', { voice: 'en-GB' });
    expect(synth.last.voice).toBe(english);

    await player.play('Xin chào cả lớp!', { voice: 'default', locale: 'en-US' });
    expect(synth.last).toMatchObject({ voice: vietnamese, lang: 'vi-VN' });
    await player.play('你好。', { voice: 'missing', locale: 'zh-TW' });
    expect(synth.last).toMatchObject({ voice: null, lang: 'zh-TW' });
  });

  it('pauses by cancelling and resumes by speaking the current sentence again', async () => {
    const { synth, player, ended } = setup();
    await player.play('One. Two. Three.');
    synth.finish();
    const paused = synth.last;
    expect(paused.text).toBe('Two.');
    const cancels = synth.cancelCount;

    player.pause();
    expect(synth.cancelCount).toBe(cancels + 1);
    expect(player.isPaused()).toBe(true);
    expect(player.isPlaying()).toBe(false);
    expect(player.hasActiveSpeech()).toBe(true);
    // A late end from the cancelled utterance must not advance the line.
    synth.finish(paused);
    expect(synth.texts).toEqual(['One.', 'Two.']);

    player.resume();
    expect(synth.texts).toEqual(['One.', 'Two.', 'Two.']);
    expect(synth.last).not.toBe(paused);
    expect(player.isPlaying()).toBe(true);
    synth.finish();
    synth.finish();
    expect(synth.texts).toEqual(['One.', 'Two.', 'Two.', 'Three.']);
    expect(ended).toHaveBeenCalledOnce();
  });

  it('ignores events from a stopped line and does not end it', async () => {
    const { synth, player, ended, errors } = setup();
    await player.play('One. Two.');
    const stale = synth.last;
    const cancels = synth.cancelCount;

    player.stop();
    expect(synth.cancelCount).toBe(cancels + 1);
    synth.finish(stale);
    synth.fail('interrupted', stale);

    expect(synth.texts).toEqual(['One.']);
    expect(errors).toEqual([]);
    expect(ended).not.toHaveBeenCalled();
    expect(player.hasActiveSpeech()).toBe(false);
    // Nothing in flight any more: stop() has nothing left to cancel.
    player.stop();
    expect(synth.cancelCount).toBe(cancels + 1);
  });

  it('replaces the current line on play() without ending it', async () => {
    const { synth, player, ended } = setup();
    await player.play('Old one. Old two.');
    const stale = synth.last;
    await player.play('New.');
    synth.finish(stale);
    expect(synth.texts).toEqual(['Old one.', 'New.']);
    synth.finish();
    expect(ended).toHaveBeenCalledOnce();
  });

  it('reports a failed sentence and moves on to the next one', async () => {
    const { synth, player, ended, errors } = setup();
    await player.play('One. Two.');
    synth.fail('audio-busy');
    expect(errors).toEqual([{ code: 'audio-busy', text: 'One.' }]);
    expect(synth.texts).toEqual(['One.', 'Two.']);
    synth.fail('synthesis-failed');
    expect(errors.at(-1)).toEqual({ code: 'synthesis-failed', text: 'Two.' });
    expect(ended).toHaveBeenCalledOnce();
  });

  describe('interrupted by other speech on the page', () => {
    it('waits for the other speech to end, then speaks the interrupted sentence again', async () => {
      vi.useFakeTimers();
      const { synth, player, ended, errors } = setup();
      await player.play('One. Two.');
      const interrupted = synth.last;
      // Another speaker's cancel() interrupts this line, then it speaks.
      synth.cancel();
      expect(errors).toEqual([{ code: 'interrupted', text: 'One.' }]);
      const other = synth.createUtterance('Preview.');
      synth.speak(other);
      vi.advanceTimersByTime(5000);
      expect(synth.texts).toEqual(['One.', 'Preview.']);
      expect(player.isPlaying()).toBe(true);

      synth.finish(other);
      vi.advanceTimersByTime(250);
      expect(synth.texts).toEqual(['One.', 'Preview.', 'One.']);
      expect(synth.last).not.toBe(interrupted);
      synth.finish();
      synth.finish();
      expect(ended).toHaveBeenCalledOnce();
    });

    it('moves on after the same sentence is interrupted three times', async () => {
      vi.useFakeTimers();
      const { synth, player, ended } = setup();
      await player.play('One. Two.');
      for (let i = 0; i < 3; i++) {
        synth.fail('interrupted');
        vi.advanceTimersByTime(250);
      }
      expect(synth.texts).toEqual(['One.', 'One.', 'One.', 'Two.']);
      synth.finish();
      expect(ended).toHaveBeenCalledOnce();
      expect(player.hasActiveSpeech()).toBe(false);
    });

    it('stays paused or stopped when paused or stopped while waiting', async () => {
      vi.useFakeTimers();
      const { synth, player } = setup();
      await player.play('One. Two.');
      synth.fail('canceled');
      player.pause();
      vi.advanceTimersByTime(5000);
      expect(synth.texts).toEqual(['One.']);
      player.resume();
      expect(synth.texts).toEqual(['One.', 'One.']);

      synth.fail('interrupted');
      player.stop();
      vi.advanceTimersByTime(5000);
      expect(synth.texts).toEqual(['One.', 'One.']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('lets a preview play during narration and continues afterwards', async () => {
      vi.useFakeTimers();
      const synth = new FakeSpeechSynthesis();
      const narration = new BrowserSpeechPlayer({ synth });
      const preview = new BrowserSpeechPlayer({ synth, stallGuard: false });
      const narrationEnded = vi.fn();
      const previewEnded = vi.fn();
      narration.onEnded(narrationEnded);
      preview.onEnded(previewEnded);

      await narration.play('First. Second.');
      await preview.play('Hello preview.');
      vi.advanceTimersByTime(1000);
      expect(synth.texts).toEqual(['First.', 'Hello preview.']);
      synth.finish();
      expect(previewEnded).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(250);
      expect(synth.texts).toEqual(['First.', 'Hello preview.', 'First.']);
      synth.finish();
      synth.finish();
      expect(narrationEnded).toHaveBeenCalledOnce();
    });
  });

  it('lets the error callback stop the line', async () => {
    const { synth, player, ended } = setup();
    player.onError(() => player.stop());
    await player.play('One. Two.');
    synth.fail('network');
    expect(synth.texts).toEqual(['One.']);
    expect(ended).not.toHaveBeenCalled();
    expect(player.hasActiveSpeech()).toBe(false);
  });

  it('treats a sentence that throws while speaking as failed', async () => {
    const { synth, player, ended, errors } = setup();
    const speak = synth.speak.bind(synth);
    let calls = 0;
    synth.speak = (utterance) => {
      if (calls++ === 0) throw new Error('boom');
      speak(utterance);
    };
    await expect(player.play('One. Two.')).resolves.toBe(true);
    expect(errors).toEqual([{ code: 'synthesis-failed', text: 'One.' }]);
    synth.finish();
    expect(ended).toHaveBeenCalledOnce();
  });

  describe('stall guard', () => {
    it('cancels and skips a sentence that never ends', async () => {
      vi.useFakeTimers();
      const { synth, player, ended, errors } = setup({ stallGuard: true });
      await player.play('This sentence never finishes. Next.', { rate: 0.5 });
      const stuck = synth.last;
      const deadline =
        estimateSpeechDurationMs('This sentence never finishes.', { speed: 0.5 }) * 3 + 5000;

      vi.advanceTimersByTime(deadline - 1);
      expect(synth.texts).toEqual(['This sentence never finishes.']);
      expect(errors).toEqual([]);

      const cancels = synth.cancelCount;
      vi.advanceTimersByTime(1);
      expect(synth.cancelCount).toBeGreaterThan(cancels);
      // The cancel's own `interrupted` is not reported a second time.
      expect(errors).toEqual([{ code: 'stalled', text: 'This sentence never finishes.' }]);
      expect(synth.texts).toEqual(['This sentence never finishes.', 'Next.']);

      // A late end from the abandoned utterance does not skip "Next.".
      synth.finish(stuck);
      expect(synth.texts).toHaveLength(2);
      synth.finish();
      expect(ended).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not shorten the deadline for fast rates', async () => {
      vi.useFakeTimers();
      const { synth, player, errors } = setup({ stallGuard: true });
      const text = 'A fairly long sentence that a capped voice reads slowly.';
      await player.play(text, { rate: 10 });
      vi.advanceTimersByTime(estimateSpeechDurationMs(text) * 3 + 4999);
      expect(errors).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(errors).toEqual([{ code: 'stalled', text }]);
      expect(synth.spoken).toHaveLength(1);
    });

    it('does not cut off a slow voice that keeps reporting progress', async () => {
      vi.useFakeTimers();
      const { synth, player, ended, errors } = setup({ stallGuard: true });
      const text = 'A slow voice reads this sentence.';
      const deadline = estimateSpeechDurationMs(text) * 3 + 5000;
      await player.play(text);

      // Starting late, then word boundaries well past the first deadline.
      vi.advanceTimersByTime(deadline - 1000);
      synth.last.onstart?.();
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(deadline - 1000);
        synth.boundary();
      }
      expect(errors).toEqual([]);

      // Progress stops: the deadline runs from the last boundary.
      vi.advanceTimersByTime(deadline - 1);
      expect(errors).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(errors).toEqual([{ code: 'stalled', text }]);
      expect(ended).toHaveBeenCalledOnce();
    });

    it('ignores progress from an abandoned sentence', async () => {
      vi.useFakeTimers();
      const { synth, player } = setup({ stallGuard: true });
      await player.play('One. Two.');
      const stale = synth.last;
      player.pause();
      synth.boundary(stale);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not run while paused and restarts on resume', async () => {
      vi.useFakeTimers();
      const { synth, player, errors } = setup({ stallGuard: true });
      await player.play('Paused here.');
      player.pause();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(errors).toEqual([]);

      player.resume();
      expect(vi.getTimerCount()).toBe(1);
      synth.finish();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('is off when disabled', async () => {
      vi.useFakeTimers();
      const { player } = setup({ stallGuard: false });
      await player.play('No guard.');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('voice loading', () => {
    it('waits for the voice list before speaking', async () => {
      vi.useFakeTimers();
      const { synth, player } = setup({ voices: [] });
      const voice = fakeVoice('urn:de', 'de-DE');
      const started = player.play('Hallo.', { voice: 'urn:de' });
      expect(synth.spoken).toHaveLength(0);
      expect(player.isPlaying()).toBe(true);

      synth.setVoices([voice]);
      await expect(started).resolves.toBe(true);
      expect(synth.last.voice).toBe(voice);
    });

    it('speaks without a voice after the load times out, and does not wait again', async () => {
      vi.useFakeTimers();
      const { synth, player, ended } = setup({ voices: [] });
      const first = player.play('First line.', { locale: 'de-DE' });
      await vi.advanceTimersByTimeAsync(1999);
      expect(synth.spoken).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(first).resolves.toBe(true);
      expect(synth.last).toMatchObject({ voice: null, lang: 'de-DE' });
      synth.finish();
      expect(ended).toHaveBeenCalledOnce();

      await player.play('Second line.');
      expect(synth.texts).toEqual(['First line.', 'Second line.']);
    });

    it('resolves false for a line replaced while waiting, and only ends the new one', async () => {
      vi.useFakeTimers();
      const { synth, player, ended } = setup({ voices: [] });
      const first = player.play('First.');
      const second = player.play('Second.');
      synth.setVoices([fakeVoice('en', 'en-US')]);
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(true);
      expect(synth.texts).toEqual(['Second.']);
      synth.finish();
      expect(ended).toHaveBeenCalledOnce();
    });

    it('stays paused when voices arrive during a pause', async () => {
      vi.useFakeTimers();
      const { synth, player } = setup({ voices: [] });
      const started = player.play('Wait for me.');
      player.pause();
      synth.setVoices([fakeVoice('en', 'en-US')]);
      await expect(started).resolves.toBe(true);
      expect(synth.spoken).toHaveLength(0);
      expect(player.isPaused()).toBe(true);

      player.resume();
      expect(synth.texts).toEqual(['Wait for me.']);
    });

    it('picks up voices that arrive after the first batch', async () => {
      const network = fakeVoice('urn:network', 'en-US');
      const local = fakeVoice('urn:local', 'zh-CN');
      const { synth, player } = setup({ voices: [network] });
      await player.play('One. Two.', { voice: 'urn:local' });
      expect(synth.last.voice).toBeNull();
      synth.setVoices([network, local]);
      synth.finish();
      expect(synth.last.voice).toBe(local);
    });
  });
});
