/**
 * Recognize an audio container from its leading bytes. Stored narration can
 * carry a wrong format label (a provider that answered WAV without a usable
 * Content-Type is recorded as mp3), and players that trust the label decode
 * the bytes with the wrong demuxer, e.g. WebKit reporting a WAV clip whose
 * streaming header carries a placeholder data length as hours long when it is
 * labelled audio/mpeg.
 *
 * Returns an extension `canonicalArchiveMedia('audio', …)` accepts, or `null`
 * when the bytes are not recognized (callers then keep the stored label).
 */
export type SniffedAudioExtension = 'wav' | 'mp3' | 'aac' | 'ogg' | 'flac' | 'm4a' | 'webm';

/** How many leading bytes {@link sniffAudioContainer} reads. */
export const AUDIO_SNIFF_BYTES = 16;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * Length of a leading ID3v2 tag (header, syncsafe body size, optional
 * footer), or `null` when the bytes do not start with one.
 */
export function id3TagLength(bytes: Uint8Array): number | null {
  if (ascii(bytes, 0, 3) !== 'ID3' || bytes.length < 10) return null;
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  const footer = bytes[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/**
 * The stream a frame header starts: 12 sync bits, then the layer bits tell
 * MPEG audio (layer I-III) from AAC ADTS (layer 00).
 */
function frameStream(bytes: Uint8Array, offset = 0): 'mp3' | 'aac' | null {
  if (bytes.length < offset + 2 || bytes[offset] !== 0xff) return null;
  const second = bytes[offset + 1];
  if ((second & 0xf0) === 0xf0 && (second & 0x06) === 0) return 'aac';
  if ((second & 0xe0) === 0xe0 && second & 0x06) return 'mp3';
  return null;
}

/**
 * Recognize the container of `bytes` (the payload's head). An ID3v2 tag is
 * skipped to the frame after it when that frame is within `bytes`; tagged
 * data whose frame lies beyond reads as MPEG audio, the common case.
 */
export function sniffAudioContainer(bytes: Uint8Array): SniffedAudioExtension | null {
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'wav';
  const tag = id3TagLength(bytes);
  if (tag !== null) return frameStream(bytes, tag) ?? 'mp3';
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'flac';
  if (ascii(bytes, 4, 4) === 'ftyp') return 'm4a';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'webm';
  }
  return frameStream(bytes);
}

/**
 * {@link sniffAudioContainer} over a Blob's head, reading the frame header
 * after a leading ID3v2 tag too; `null` on any read failure.
 */
export async function sniffAudioBlob(blob: Blob): Promise<SniffedAudioExtension | null> {
  try {
    const head = new Uint8Array(await blob.slice(0, AUDIO_SNIFF_BYTES).arrayBuffer());
    const tag = id3TagLength(head);
    if (tag === null) return sniffAudioContainer(head);
    const frame = new Uint8Array(await blob.slice(tag, tag + 4).arrayBuffer());
    return frameStream(frame) ?? 'mp3';
  } catch {
    return null;
  }
}
