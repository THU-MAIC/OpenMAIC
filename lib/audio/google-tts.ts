/**
 * Google (Gemini) TTS — server adapter, dispatched from `generateTTS` in
 * `./tts-providers.ts`.
 *
 * Wire format (measured 12.09.2026 from the docs' verbatim curl):
 *   POST {baseUrl}/interactions   header x-goog-api-key
 *   { model, input, response_format: { type: 'audio' },
 *     generation_config: { speech_config: [{ voice }] } }
 * Response (API reference): audio rides in `steps[].content[]` as
 *   { type: 'audio', data: <base64>, mime_type, sample_rate, channels };
 * the Python SDK exposes the same bytes as `interaction.output_audio.data`,
 * accepted here as a fallback. Bytes are raw PCM (24 kHz, 16-bit, mono) unless
 * the mime says WAV — so the adapter always hands back a WAV.
 *
 * `lib/audio/wav-utils.ts` is `'use client'` (AudioContext) and cannot run on
 * the server; the 44-byte header is written here instead.
 */

import type { TTSModelConfig } from '@/lib/audio/types';
import {
  throwIfTtsRateLimited,
  TTSInvalidResponseError,
  type TTSGenerationResult,
} from '@/lib/audio/tts-providers';
import { GOOGLE_TTS_DEFAULT_BASE_URL, GOOGLE_TTS_DEFAULT_MODEL } from './google-tts-provider';
import { audioProviderFetch } from '@/lib/server/audio-provider-fetch';

interface AudioPart {
  type?: string;
  data?: string;
  mime_type?: string;
  sample_rate?: number;
  channels?: number;
}

function findAudioPart(json: unknown): AudioPart | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const root = json as { steps?: unknown; output_audio?: unknown };
  if (Array.isArray(root.steps)) {
    for (const step of root.steps as Array<{ content?: unknown }>) {
      if (!Array.isArray(step?.content)) continue;
      for (const part of step.content as AudioPart[]) {
        if (part?.type === 'audio' && typeof part.data === 'string') return part;
      }
    }
  }
  const sdkStyle = root.output_audio as AudioPart | undefined;
  if (sdkStyle && typeof sdkStyle.data === 'string') return sdkStyle;
  return undefined;
}

function isRiffWav(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45 // E
  );
}

/** Wrap raw 16-bit little-endian PCM in a canonical 44-byte WAV header. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  const blockAlign = channels * 2;
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

export async function generateGoogleTTS(
  config: TTSModelConfig,
  text: string,
  signal: AbortSignal,
): Promise<TTSGenerationResult> {
  const baseUrl = (config.baseUrl || GOOGLE_TTS_DEFAULT_BASE_URL).replace(/\/+$/, '');
  // Strict transport (redirect re-validation + connect-time DNS pinning); a
  // client BYOK base URL runs under the public-only policy like every provider.
  const response = await audioProviderFetch(
    `${baseUrl}/interactions`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': config.apiKey!,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        model: config.modelId || GOOGLE_TTS_DEFAULT_MODEL,
        input: text,
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: config.voice }] },
      }),
      signal,
    },
    { allowLocalNetworks: config.publicOnly ? false : undefined },
  );

  if (!response.ok) {
    throwIfTtsRateLimited('Google', response.status);
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      `Google TTS API error (${response.status}): ${body?.error?.message || response.statusText}`,
    );
  }

  const json = (await response.json().catch(() => null)) as unknown;
  const part = findAudioPart(json);
  if (!part?.data) {
    const keys = json && typeof json === 'object' ? Object.keys(json).join(',') : typeof json;
    throw new TTSInvalidResponseError(
      'Google',
      `Google TTS returned no audio part (response keys: ${keys})`,
    );
  }

  const bytes = new Uint8Array(Buffer.from(part.data, 'base64'));
  if (bytes.byteLength === 0) {
    throw new TTSInvalidResponseError('Google', 'Google TTS returned an empty audio part');
  }
  const mime = (part.mime_type || '').toLowerCase();
  if (mime.startsWith('audio/wav') || mime.startsWith('audio/x-wav') || isRiffWav(bytes)) {
    return { audio: bytes, format: 'wav' };
  }
  return {
    audio: pcm16ToWav(bytes, part.sample_rate || 24000, part.channels || 1),
    format: 'wav',
  };
}
