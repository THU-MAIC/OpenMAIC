/**
 * Dependency-free audio duration measurement.
 *
 * Video export (#854) maps each narration/TTS clip onto a timeline segment,
 * which needs the clip's duration. Rather than decode audio at render time
 * (slow, and impossible to validate in a pure-manifest test without
 * FFmpeg/Chrome), we measure duration once when the client persists TTS audio
 * and store it on the `AudioFileRecord` alongside the blob.
 *
 * This module parses the container headers directly (no DOM / native audio
 * API), so it's unit-testable in plain Node and stays usable from either the
 * browser or a server context. It covers the two formats OpenMAIC's TTS
 * providers actually emit — WAV and MP3 — and returns `null` for anything it
 * cannot parse so callers degrade gracefully (store the audio, leave duration
 * undefined) instead of failing.
 */

/** Coerce common inputs into a Uint8Array view without copying when possible. */
function toBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/**
 * WAV: walk the RIFF chunk list to find `fmt ` (byte rate) and `data` (size).
 * duration = dataSize / byteRate. Walking chunks — rather than assuming fixed
 * offsets — tolerates optional chunks (LIST, fact, …) some encoders insert
 * before `data`.
 */
export function measureWavDuration(input: Uint8Array | ArrayBuffer): number | null {
  const bytes = toBytes(input);
  if (bytes.length < 12) return null;
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') return null;

  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = readUint32LE(bytes, offset + 4);
    const bodyOffset = offset + 8;
    if (chunkId === 'fmt ' && bodyOffset + 16 <= bytes.length) {
      byteRate = readUint32LE(bytes, bodyOffset + 8);
    } else if (chunkId === 'data') {
      // Some streams write 0 / 0xFFFFFFFF for an unknown-length data chunk;
      // fall back to the actual remaining bytes in that case.
      const declared = chunkSize;
      const remaining = bytes.length - bodyOffset;
      dataSize = declared > 0 && declared <= remaining ? declared : remaining;
      break;
    }
    // Chunks are word-aligned: an odd size is padded with one byte.
    offset = bodyOffset + chunkSize + (chunkSize % 2);
  }

  if (byteRate <= 0 || dataSize <= 0) return null;
  return dataSize / byteRate;
}

// MPEG audio version → layer → bitrate table (kbps). Index by version bits then
// layer bits, then the 4-bit bitrate index from the frame header.
const MP3_BITRATES: Record<string, number[]> = {
  // MPEG 1
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  // MPEG 2 / 2.5
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const MP3_SAMPLE_RATES: Record<string, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};

/** Skip an ID3v2 tag if present; returns the offset of the first audio byte. */
function skipId3v2(bytes: Uint8Array): number {
  if (bytes.length < 10 || readAscii(bytes, 0, 3) !== 'ID3') return 0;
  // Tag size is a 28-bit syncsafe integer in bytes 6..9.
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  return 10 + size;
}

/**
 * MP3: parse the first frame header for version/layer/bitrate/sample-rate, then
 * prefer a Xing/Info (or VBRI) frame count for a VBR-accurate duration. Falls
 * back to a CBR estimate (audio bytes × 8 / bitrate) when no VBR header exists.
 */
export function measureMp3Duration(input: Uint8Array | ArrayBuffer): number | null {
  const bytes = toBytes(input);
  const audioStart = skipId3v2(bytes);

  // Find the first frame sync (11 set bits: 0xFF followed by 0xE0-mask top 3).
  let frame = -1;
  for (let i = audioStart; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
      frame = i;
      break;
    }
  }
  if (frame < 0) return null;

  const b1 = bytes[frame + 1];
  const b2 = bytes[frame + 2];
  const versionBits = (b1 >> 3) & 0x03; // 0=2.5, 2=2, 3=1
  const layerBits = (b1 >> 1) & 0x03; // 3=Layer1, 2=Layer2, 1=Layer3
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleRateIdx = (b2 >> 2) & 0x03;

  if (versionBits === 1 || layerBits === 0) return null; // reserved
  if (bitrateIdx === 0 || bitrateIdx === 15) return null; // free/bad
  if (sampleRateIdx === 3) return null; // reserved

  const version = versionBits === 3 ? '1' : versionBits === 2 ? '2' : '2.5';
  const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const bitrateGroup = version === '1' ? '1' : '2';
  const bitrateKbps = MP3_BITRATES[`${bitrateGroup}-${layer}`]?.[bitrateIdx];
  const sampleRate = MP3_SAMPLE_RATES[version]?.[sampleRateIdx];
  if (!bitrateKbps || !sampleRate) return null;

  // Samples per frame: Layer1 = 384; Layer2 = 1152; Layer3 = 1152 (MPEG1) or 576 (MPEG2/2.5).
  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === '1' ? 1152 : 576;

  // Xing/Info header sits at a fixed offset after the frame header, depending on
  // MPEG version and channel mode.
  const channelMode = (bytes[frame + 3] >> 6) & 0x03; // 3 = mono
  const xingOffset =
    frame + 4 + (version === '1' ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17);
  if (xingOffset + 12 <= bytes.length) {
    const tag = readAscii(bytes, xingOffset, 4);
    if (tag === 'Xing' || tag === 'Info') {
      const flags = readUint32BE(bytes, xingOffset + 4);
      if (flags & 0x01) {
        const frameCount = readUint32BE(bytes, xingOffset + 8);
        if (frameCount > 0) return (frameCount * samplesPerFrame) / sampleRate;
      }
    }
  }

  // VBRI (Fraunhofer) header sits at a fixed 32-byte offset after the frame
  // header, independent of channel mode, with the frame count at byte 14.
  const vbriOffset = frame + 4 + 32;
  if (vbriOffset + 18 <= bytes.length && readAscii(bytes, vbriOffset, 4) === 'VBRI') {
    const frameCount = readUint32BE(bytes, vbriOffset + 14);
    if (frameCount > 0) return (frameCount * samplesPerFrame) / sampleRate;
  }

  // CBR estimate from the audio payload size: bytes × 8 bits / bitrate. Exclude
  // a trailing ID3v1 tag (last 128 bytes, 'TAG' magic) so it doesn't inflate
  // the byte count.
  let end = bytes.length;
  if (end - frame >= 128 && readAscii(bytes, end - 128, 3) === 'TAG') end -= 128;
  const audioBytes = end - frame;
  return (audioBytes * 8) / (bitrateKbps * 1000);
}

/** Recognize the container from magic bytes, ignoring any reported format. */
function sniffFormat(bytes: Uint8Array): 'wav' | 'mp3' | null {
  if (readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WAVE') return 'wav';
  if (readAscii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    return 'mp3';
  }
  return null;
}

/**
 * Measure audio duration (seconds) from raw bytes. Returns `null` when the
 * format is unsupported or the bytes cannot be parsed — callers should treat
 * `null` as "unknown duration" and still persist the audio.
 *
 * The `format` hint is derived upstream from a `Content-Type` header and can be
 * wrong (e.g. `getAudioResponseFormat` falls back to `mp3` when the type is
 * missing, while the provider actually returned WAV). So we sniff the magic
 * bytes first and only trust the hint when the content is unrecognizable — a
 * mismatched hint never sends WAV bytes through the MP3 parser (which could
 * false-sync into a wrong duration) or vice versa.
 */
export function measureAudioDuration(
  input: Uint8Array | ArrayBuffer,
  format?: string,
): number | null {
  const bytes = toBytes(input);
  if (bytes.length === 0) return null;

  // Content wins over the reported format when the magic bytes are recognized.
  const sniffed = sniffFormat(bytes);
  if (sniffed === 'wav') return measureWavDuration(bytes);
  if (sniffed === 'mp3') return measureMp3Duration(bytes);

  // Unrecognizable content: fall back to the reported format hint.
  const fmt = format?.toLowerCase();
  if (fmt === 'wav' || fmt === 'x-wav' || fmt === 'wave') return measureWavDuration(bytes);
  if (fmt === 'mp3' || fmt === 'mpeg' || fmt === 'mpga') return measureMp3Duration(bytes);
  return null;
}
