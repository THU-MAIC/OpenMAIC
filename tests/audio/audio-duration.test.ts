import { describe, expect, it } from 'vitest';
import {
  measureAudioDuration,
  measureMp3Duration,
  measureWavDuration,
} from '@/lib/audio/audio-duration';

/** Build a minimal 44-byte-header PCM WAV for a given duration. */
function buildWav(
  seconds: number,
  sampleRate = 8000,
  channels = 1,
  bitsPerSample = 16,
): Uint8Array {
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const dataSize = Math.round(byteRate * seconds);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buffer);
}

/**
 * Build a CBR MP3 (MPEG-1 Layer III, 128 kbps, 44100 Hz, mono) of roughly the
 * requested duration by repeating a valid frame header + padding. Duration is
 * estimated from total audio bytes, so exact frame content doesn't matter.
 */
function buildCbrMp3(seconds: number): Uint8Array {
  const bitrateKbps = 128;
  const sampleRate = 44100;
  const samplesPerFrame = 1152;
  const frameLength = Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate));
  const frameCount = Math.round((seconds * sampleRate) / samplesPerFrame);
  const bytes = new Uint8Array(frameLength * frameCount);
  for (let f = 0; f < frameCount; f++) {
    const off = f * frameLength;
    bytes[off] = 0xff; // sync
    bytes[off + 1] = 0xfb; // MPEG1, Layer III, no CRC
    bytes[off + 2] = 0x90; // 128 kbps (0x9), 44100 Hz (0x0), no padding
    bytes[off + 3] = 0xc0; // mono
  }
  return bytes;
}

/**
 * Build a single MPEG-1 Layer III mono frame carrying a Xing/Info header with a
 * known frame count. The header sits at frame + 4 + 17 for MPEG-1 mono.
 */
function buildXingMp3(frameCount: number, tag: 'Xing' | 'Info' = 'Xing'): Uint8Array {
  const bytes = new Uint8Array(512);
  bytes[0] = 0xff; // sync
  bytes[1] = 0xfb; // MPEG1, Layer III, no CRC
  bytes[2] = 0x90; // 128 kbps, 44100 Hz, no padding
  bytes[3] = 0xc0; // mono
  const off = 4 + 17;
  tag.split('').forEach((c, i) => (bytes[off + i] = c.charCodeAt(0)));
  const dv = new DataView(bytes.buffer);
  dv.setUint32(off + 4, 0x01, false); // flags: frame-count present
  dv.setUint32(off + 8, frameCount, false);
  return bytes;
}

/**
 * Build a single MPEG-1 mono frame carrying a VBRI header with a known frame
 * count. VBRI sits at a fixed frame + 4 + 32 offset, frame count at byte 14.
 */
function buildVbriMp3(frameCount: number): Uint8Array {
  const bytes = new Uint8Array(512);
  bytes[0] = 0xff;
  bytes[1] = 0xfb;
  bytes[2] = 0x90;
  bytes[3] = 0xc0;
  const off = 4 + 32;
  'VBRI'.split('').forEach((c, i) => (bytes[off + i] = c.charCodeAt(0)));
  new DataView(bytes.buffer).setUint32(off + 14, frameCount, false);
  return bytes;
}

describe('measureWavDuration', () => {
  it('measures duration from a PCM WAV header', () => {
    const wav = buildWav(2.5);
    expect(measureWavDuration(wav)).toBeCloseTo(2.5, 3);
  });

  it('tolerates an odd-length preceding chunk (word alignment)', () => {
    // Prepend a LIST chunk of odd size before data; parser must skip its pad byte.
    const base = buildWav(1);
    const list = new Uint8Array(8 + 3 + 1); // header + 3-byte body + 1 pad
    const dv = new DataView(list.buffer);
    'LIST'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
    dv.setUint32(4, 3, true);
    // Splice the LIST chunk in right after the WAVE tag (offset 12).
    const out = new Uint8Array(base.length + list.length);
    out.set(base.subarray(0, 12), 0);
    out.set(list, 12);
    out.set(base.subarray(12), 12 + list.length);
    // Fix RIFF size.
    new DataView(out.buffer).setUint32(4, out.length - 8, true);
    expect(measureWavDuration(out)).toBeCloseTo(1, 3);
  });

  it('returns null for non-RIFF bytes', () => {
    expect(measureWavDuration(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });
});

describe('measureMp3Duration', () => {
  it('estimates duration of a CBR MP3', () => {
    const mp3 = buildCbrMp3(3);
    const d = measureMp3Duration(mp3);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(2.5);
    expect(d!).toBeLessThan(3.5);
  });

  it('skips a leading ID3v2 tag', () => {
    const mp3 = buildCbrMp3(2);
    const id3 = new Uint8Array(10 + 20);
    'ID3'.split('').forEach((c, i) => (id3[i] = c.charCodeAt(0)));
    id3[6] = 0;
    id3[7] = 0;
    id3[8] = 0;
    id3[9] = 20; // syncsafe size = 20
    const out = new Uint8Array(id3.length + mp3.length);
    out.set(id3, 0);
    out.set(mp3, id3.length);
    const d = measureMp3Duration(out);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(1.5);
    expect(d!).toBeLessThan(2.5);
  });

  it('returns null when no frame sync is found', () => {
    expect(measureMp3Duration(new Uint8Array(64))).toBeNull();
  });

  it('uses the Xing frame count for VBR-accurate duration', () => {
    // 153 frames × 1152 samples / 44100 Hz ≈ 3.997 s.
    const d = measureMp3Duration(buildXingMp3(153));
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo((153 * 1152) / 44100, 3);
  });

  it('uses an Info (CBR) header frame count too', () => {
    const d = measureMp3Duration(buildXingMp3(100, 'Info'));
    expect(d!).toBeCloseTo((100 * 1152) / 44100, 3);
  });

  it('uses the VBRI frame count when no Xing/Info header is present', () => {
    const d = measureMp3Duration(buildVbriMp3(200));
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo((200 * 1152) / 44100, 3);
  });

  it('excludes a trailing ID3v1 tag from the CBR estimate', () => {
    const mp3 = buildCbrMp3(2);
    const withTag = new Uint8Array(mp3.length + 128);
    withTag.set(mp3, 0);
    'TAG'.split('').forEach((c, i) => (withTag[mp3.length + i] = c.charCodeAt(0)));
    // The 128-byte tag must not inflate the estimate: same duration as without.
    expect(measureMp3Duration(withTag)).toBeCloseTo(measureMp3Duration(mp3)!, 3);
  });
});

describe('measureAudioDuration', () => {
  it('dispatches on the wav format hint', () => {
    expect(measureAudioDuration(buildWav(1.5), 'wav')).toBeCloseTo(1.5, 3);
  });

  it('dispatches on the mp3 format hint', () => {
    const d = measureAudioDuration(buildCbrMp3(1), 'mp3');
    expect(d).not.toBeNull();
  });

  it('sniffs format when no hint is given', () => {
    expect(measureAudioDuration(buildWav(1))).toBeCloseTo(1, 3);
    expect(measureAudioDuration(buildCbrMp3(1))).not.toBeNull();
  });

  it('trusts content over a wrong format hint (mp3 hint, WAV bytes)', () => {
    // getAudioResponseFormat falls back to 'mp3' when Content-Type is missing,
    // but the provider may actually return WAV. Content must win.
    expect(measureAudioDuration(buildWav(2.5), 'mp3')).toBeCloseTo(2.5, 3);
  });

  it('trusts content over a wrong format hint (wav hint, MP3 bytes)', () => {
    const d = measureAudioDuration(buildCbrMp3(2), 'wav');
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(1.5);
    expect(d!).toBeLessThan(2.5);
  });

  it('degrades to null on empty or unsupported input (caller still persists)', () => {
    expect(measureAudioDuration(new Uint8Array(0))).toBeNull();
    expect(measureAudioDuration(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 'flac')).toBeNull();
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', () => {
    const wav = buildWav(2);
    const copy = wav.slice().buffer as ArrayBuffer;
    expect(measureAudioDuration(copy, 'wav')).toBeCloseTo(2, 3);
  });
});
