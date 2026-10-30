import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes through providers without WAV normalization unchanged', async () => {
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

  it('keeps WAV blobs unchanged for funasr-asr', async () => {
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const result = await normalizeASRUploadAudio('funasr-asr', input);
    expect(result.blob).toBe(input);
    expect(result.fileName).toBe('recording.wav');
  });

  it.each(['qwen3-asr', 'Qwen3-ASR-1.7B', 'Qwen/Qwen3-ASR-1.7B', 'qwen/qwen3-asr-0.6b'])(
    'keeps existing WAV audio for compatible model %s',
    async (modelId) => {
      const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
      const result = await normalizeASRUploadAudio('openai-whisper', input, modelId);
      expect(result.blob).toBe(input);
      expect(result.fileName).toBe('recording.wav');
    },
  );

  it.each([
    'qwen3-asr',
    'qwen3-asr-1.7b',
    'Qwen3-ASR-1.7B',
    'Qwen/Qwen3-ASR-1.7B',
    'Qwen/Qwen3-ASR-0.6B',
    'qwen/qwen3-asr-1.7b',
  ])('converts browser WebM recordings to WAV for compatible model %s', async (modelId) => {
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const decodeAudioData = vi.fn().mockResolvedValue({
      sampleRate: 16000,
      length: 3,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array([0, 0.5, -0.5]),
    });
    const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      AudioContext: class {
        decodeAudioData = decodeAudioData;
        close = close;
      },
    });

    const result = await normalizeASRUploadAudio('openai-whisper', input, modelId);

    expect(result.fileName).toBe('recording.wav');
    expect(result.blob.type).toBe('audio/wav');
    const wav = new DataView(await result.blob.arrayBuffer());
    expect(new TextDecoder().decode(wav.buffer.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.buffer.slice(8, 12))).toBe('WAVE');
    expect(wav.getUint32(24, true)).toBe(16000);
    expect(wav.getInt16(46, true)).toBe(16383);
    expect(wav.getInt16(48, true)).toBe(-16384);
    expect(decodeAudioData).toHaveBeenCalledWith(await input.arrayBuffer());
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['whisper-1', 'Qwen/Qwen3-ForcedAligner-0.6B', 'other-qwen3-asr', 'qwen3-asr2'])(
    'passes through unrelated model %s without conversion',
    async (modelId) => {
      const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
      const result = await normalizeASRUploadAudio('openai-whisper', input, modelId);
      expect(result.blob).toBe(input);
      expect(result.fileName).toBe('recording.webm');
    },
  );
});

describe('normalizeASRUploadAudio (registry-driven)', () => {
  it('passes through providers whose documented formats include webm', async () => {
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    for (const providerId of ['openai-whisper', 'qwen-asr', 'azure-asr']) {
      const result = await normalizeASRUploadAudio(providerId, input);
      expect(result.blob).toBe(input);
      expect(result.fileName).toBe('recording.webm');
    }
  });

  it('keeps WAV blobs unchanged for xiaomi-asr, whose formats lack webm', async () => {
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    const result = await normalizeASRUploadAudio('xiaomi-asr', input);
    expect(result.blob).toBe(input);
    expect(result.fileName).toBe('recording.wav');
  });

  it('passes unknown custom providers through without transcoding', async () => {
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const result = await normalizeASRUploadAudio('custom-asr-mine', input);
    expect(result.blob).toBe(input);
    expect(result.fileName).toBe('recording.webm');
  });
});
