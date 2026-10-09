import { describe, expect, it } from 'vitest';
import { sniffAudioBlob, sniffAudioContainer } from '@/lib/media/sniff-audio-container';
import { streamingWavBytes } from '../fixtures/streaming-wav';

const bytes = (...values: Array<number | string>) =>
  Uint8Array.from(
    values.flatMap((value) =>
      typeof value === 'string' ? [...value].map((char) => char.charCodeAt(0)) : [value],
    ),
  );

describe('sniffAudioContainer', () => {
  it.each([
    ['wav', streamingWavBytes(4)],
    ['mp3', bytes('ID3', 4, 0, 0, 0, 0, 0, 0)],
    ['mp3', bytes(0xff, 0xfb, 0x90, 0x64)],
    ['ogg', bytes('OggS', 0, 2)],
    ['flac', bytes('fLaC', 0, 0, 0, 34)],
    ['m4a', bytes(0, 0, 0, 0x20, 'ftypM4A ')],
    ['webm', bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f)],
  ] as const)('recognizes %s', (expected, input) => {
    expect(sniffAudioContainer(input)).toBe(expected);
  });

  it('returns null for unrecognized or too-short bytes', () => {
    expect(sniffAudioContainer(bytes('audio-bytes'))).toBeNull();
    expect(sniffAudioContainer(bytes(0xff))).toBeNull();
    expect(sniffAudioContainer(new Uint8Array())).toBeNull();
    // Frame sync with the reserved layer is not MPEG audio.
    expect(sniffAudioContainer(bytes(0xff, 0xe0))).toBeNull();
  });

  it('reads only the head of a Blob', async () => {
    expect(await sniffAudioBlob(new Blob([streamingWavBytes()], { type: 'audio/mpeg' }))).toBe(
      'wav',
    );
  });
});

describe('sniffAudioContainer behind an ID3v2 tag', () => {
  /** An ID3v2.4 tag with a syncsafe body size, followed by `frame`. */
  function tagged(frame: number[], bodySize = 200): Uint8Array<ArrayBuffer> {
    const header = [
      ...'ID3'.split('').map((char) => char.charCodeAt(0)),
      4,
      0,
      0,
      (bodySize >> 21) & 0x7f,
      (bodySize >> 14) & 0x7f,
      (bodySize >> 7) & 0x7f,
      bodySize & 0x7f,
    ];
    return Uint8Array.from([...header, ...new Array(bodySize).fill(0), ...frame, 0, 0]);
  }

  it('tells AAC ADTS from MPEG audio by the frame after the tag', async () => {
    const adts = tagged([0xff, 0xf1, 0x50, 0x80]);
    const mpeg = tagged([0xff, 0xfb, 0x90, 0x64]);
    expect(sniffAudioContainer(adts)).toBe('aac');
    expect(sniffAudioContainer(mpeg)).toBe('mp3');
    expect(await sniffAudioBlob(new Blob([adts]))).toBe('aac');
    expect(await sniffAudioBlob(new Blob([mpeg]))).toBe('mp3');
  });

  it('honours a syncsafe size above 127 bytes', async () => {
    const adts = tagged([0xff, 0xf1, 0x50, 0x80], 4000);
    expect(await sniffAudioBlob(new Blob([adts]))).toBe('aac');
  });

  it('recognizes bare ADTS and treats a tag with an unreadable frame as MPEG audio', async () => {
    expect(sniffAudioContainer(Uint8Array.from([0xff, 0xf1, 0x50, 0x80]))).toBe('aac');
    expect(await sniffAudioBlob(new Blob([tagged([0, 0, 0, 0])]))).toBe('mp3');
  });
});
