import { describe, expect, it } from 'vitest';
import { isWavBlob, normalizeASRUploadAudio } from '@/lib/audio/wav-utils';

describe('isWavBlob', () => {
  it('detects audio/wav MIME type', () => {
    const blob = new Blob([new Uint8Array(4)], { type: 'audio/wav' });
    expect(isWavBlob(blob)).toBe(true);
  });

  it('detects audio/x-wav MIME type', () => {
    const blob = new Blob([new Uint8Array(4)], { type: 'audio/x-wav' });
    expect(isWavBlob(blob)).toBe(true);
  });

  it('detects .wav file extension when MIME is missing', () => {
    const blob = new Blob([new Uint8Array(4)]);
    expect(isWavBlob(blob, 'recording.wav')).toBe(true);
    expect(isWavBlob(blob, 'recording.WAV')).toBe(true);
  });

  it('returns false for non-WAV blobs without a wav filename', () => {
    const blob = new Blob([new Uint8Array(4)], { type: 'audio/webm' });
    expect(isWavBlob(blob)).toBe(false);
    expect(isWavBlob(blob, 'recording.webm')).toBe(false);
  });
});

describe('normalizeASRUploadAudio', () => {
  it('passes through non-lemonade providers unchanged', async () => {
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const result = await normalizeASRUploadAudio('openai-whisper', input);
    expect(result.blob).toBe(input);
    expect(result.fileName).toBe('recording.webm');
  });

  it('keeps WAV blobs unchanged for lemonade-asr', async () => {
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const result = await normalizeASRUploadAudio('lemonade-asr', input);
    expect(result.blob).toBe(input);
    expect(result.fileName).toBe('recording.wav');
  });
});
