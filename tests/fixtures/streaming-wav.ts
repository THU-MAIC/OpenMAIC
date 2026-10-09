/**
 * A WAV clip as some TTS providers stream it: 24 kHz mono 16-bit PCM whose
 * RIFF and data chunk sizes are placeholders (the length was unknown when the
 * header was written), so a demuxer that trusts them sees hours of audio.
 */
export const STREAMING_WAV_DATA_LENGTH_PLACEHOLDER = 2147483547;

export function streamingWavBytes(samples = 2400): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      bytes[offset + index] = text.charCodeAt(index);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, STREAMING_WAV_DATA_LENGTH_PLACEHOLDER + 36, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, STREAMING_WAV_DATA_LENGTH_PLACEHOLDER, true);
  for (let index = 0; index < samples; index++) {
    view.setInt16(44 + index * 2, Math.round(Math.sin(index / 10) * 8000), true);
  }
  return bytes;
}
