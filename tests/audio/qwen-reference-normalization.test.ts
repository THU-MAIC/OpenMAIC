import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  audioBufferToMonoWav,
  normalizeQwenReferenceAudio,
  preserveRecordedVoiceName,
} from '@/lib/audio/voxcpm-voices';
import { validateReferenceAudio } from '@/lib/audio/wav-validate';

describe('Qwen reference audio normalization', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([4.999, 5, 60])(
    'validates a %s-second upload against the CosyVoice duration range',
    async (duration) => {
      const sampleRate = 24_000;
      const samples = Math.round(duration * sampleRate);
      vi.stubGlobal('window', {
        AudioContext: class {
          async decodeAudioData() {
            return {
              duration,
              sampleRate,
              numberOfChannels: 1,
              length: samples,
              getChannelData: () => new Float32Array(samples),
            };
          }
          async close() {}
        },
      });
      const result = normalizeQwenReferenceAudio(new Blob(['input audio']), 'sample.wav');
      if (duration < 5) {
        await expect(result).rejects.toThrow('between 5 and 60 seconds');
      } else {
        const normalized = await result;
        expect(
          validateReferenceAudio(new Uint8Array(await normalized.blob.arrayBuffer()))
            .durationSeconds,
        ).toBe(duration);
      }
    },
  );

  it('truncates decoder padding at the 60-second boundary', () => {
    const sampleRate = 24_000;
    const samples = Math.ceil(60.01 * sampleRate);
    const channel = new Float32Array(samples);
    const audioBuffer = {
      duration: 60.01,
      sampleRate,
      numberOfChannels: 1,
      length: samples,
      getChannelData: () => channel,
    } as unknown as AudioBuffer;

    const wav = new Uint8Array(audioBufferToMonoWav(audioBuffer, sampleRate));
    expect(validateReferenceAudio(wav).durationSeconds).toBe(60);
  });

  it('accepts only the decoder-padding tolerance and rejects genuinely long uploads', () => {
    const sampleRate = 24_000;
    const audioBuffer = (duration: number) => {
      const samples = Math.ceil(duration * sampleRate);
      const channel = new Float32Array(samples);
      return {
        duration,
        sampleRate,
        numberOfChannels: 1,
        length: samples,
        getChannelData: () => channel,
      } as unknown as AudioBuffer;
    };

    expect(() => audioBufferToMonoWav(audioBuffer(60.5), sampleRate)).not.toThrow();
    expect(() => audioBufferToMonoWav(audioBuffer(60.5001), sampleRate)).toThrow(
      'Reference audio must be a 24 kHz mono PCM WAV file between 1 and 60 seconds long',
    );
    expect(() => audioBufferToMonoWav(audioBuffer(120), sampleRate)).toThrow();
  });

  it('preserves a name typed while recording is in progress', () => {
    expect(preserveRecordedVoiceName('Typed during recording', 'Recorded Voice')).toBe(
      'Typed during recording',
    );
    expect(preserveRecordedVoiceName('  ', 'Recorded Voice')).toBe('Recorded Voice');
  });
});
