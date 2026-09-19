export const QWEN_REFERENCE_SAMPLE_RATE = 24_000;
export const QWEN_REFERENCE_CHANNELS = 1;
export const MIN_REFERENCE_DURATION_SECONDS = 1;
export const MAX_REFERENCE_DURATION_SECONDS = 60;

export interface ValidatedReferenceAudio {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
}

export class InvalidReferenceAudioError extends Error {
  readonly code = 'QWEN_VC_REFERENCE_AUDIO_INVALID';

  constructor() {
    super('Reference audio must be a 24 kHz mono PCM WAV file between 1 and 60 seconds long');
    this.name = 'InvalidReferenceAudioError';
  }
}

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Validate the exact PCM WAV format accepted by Qwen voice enrollment. */
export function validateReferenceAudio(audio: Uint8Array): ValidatedReferenceAudio {
  if (audio.byteLength < 44) throw new InvalidReferenceAudioError();

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (readAscii(audio, 0, 4) !== 'RIFF' || readAscii(audio, 8, 12) !== 'WAVE') {
    throw new InvalidReferenceAudioError();
  }
  if (view.getUint32(4, true) + 8 !== audio.byteLength) {
    throw new InvalidReferenceAudioError();
  }

  let offset = 12;
  let byteRate = 0;
  let blockAlign = 0;
  let dataBytes = 0;
  let sawFormat = false;

  while (offset + 8 <= audio.byteLength) {
    const chunkId = readAscii(audio, offset, offset + 4);
    const chunkBytes = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkBytes;
    if (chunkEnd > audio.byteLength) throw new InvalidReferenceAudioError();

    if (chunkId === 'fmt ') {
      if (sawFormat || chunkBytes < 16) throw new InvalidReferenceAudioError();
      const format = view.getUint16(chunkStart, true);
      const channels = view.getUint16(chunkStart + 2, true);
      const sampleRate = view.getUint32(chunkStart + 4, true);
      byteRate = view.getUint32(chunkStart + 8, true);
      blockAlign = view.getUint16(chunkStart + 12, true);
      const bitsPerSample = view.getUint16(chunkStart + 14, true);
      if (
        format !== 1 ||
        channels !== QWEN_REFERENCE_CHANNELS ||
        sampleRate !== QWEN_REFERENCE_SAMPLE_RATE ||
        bitsPerSample !== 16 ||
        blockAlign !== channels * 2 ||
        byteRate !== sampleRate * blockAlign
      ) {
        throw new InvalidReferenceAudioError();
      }
      sawFormat = true;
    } else if (chunkId === 'data') {
      dataBytes += chunkBytes;
    }

    offset = chunkEnd + (chunkBytes % 2);
  }

  const durationSeconds = byteRate ? dataBytes / byteRate : 0;
  if (
    offset !== audio.byteLength ||
    !sawFormat ||
    !dataBytes ||
    !blockAlign ||
    dataBytes % blockAlign !== 0 ||
    durationSeconds < MIN_REFERENCE_DURATION_SECONDS ||
    durationSeconds > MAX_REFERENCE_DURATION_SECONDS
  ) {
    throw new InvalidReferenceAudioError();
  }

  return {
    durationSeconds,
    sampleRate: QWEN_REFERENCE_SAMPLE_RATE,
    channels: QWEN_REFERENCE_CHANNELS,
  };
}
