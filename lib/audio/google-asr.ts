/**
 * Google (Gemini 3.5 Transcribe) ASR — server adapter, dispatched from
 * `transcribeAudio` in `./asr-providers.ts`.
 *
 * Wire format (measured 16.09.2026, ai.google.dev/gemini-api/docs/transcribe +
 * docs/interactions/audio):
 *   POST {baseUrl}/interactions   header x-goog-api-key
 *   { model, input: [{ type: 'audio', data: <base64>, mime_type }],
 *     generation_config: { transcription_config: { language_codes: [...] } } }
 *   `language_codes` are BCP-47 (`tr-TR`); omitted for auto-detect.
 * Response: transcript in `output_text`; the same text also rides in
 *   `steps[].content[]` as `{ type: 'text', text }` — read as a fallback.
 * Inline audio is the documented Interactions shape for short clips (20 MB
 * request cap); the transcribe guide prefers the Files API (`uri`) for long
 * recordings — a mic utterance is seconds, so inline is used here.
 */

import type { ASRModelConfig } from '@/lib/audio/types';
import type { ASRTranscriptionResult } from '@/lib/audio/asr-providers';
import {
  GOOGLE_ASR_DEFAULT_BASE_URL,
  GOOGLE_ASR_DEFAULT_MODEL,
  GOOGLE_ASR_LANGUAGES,
} from './google-asr-provider';

/**
 * Map whatever the client stored as `asrLanguage` onto a code the model
 * accepts: exact BCP-47 hit → itself; a bare language (`tr`, from the Whisper
 * list) → the first BCP-47 entry with that prefix; `auto`/unknown → undefined
 * (= let the model detect). Exported for tests.
 */
export function resolveGoogleASRLanguage(language?: string): string | undefined {
  const lang = language?.trim();
  if (!lang || lang === 'auto') return undefined;
  if (GOOGLE_ASR_LANGUAGES.includes(lang)) return lang;
  const prefix = lang.split('-')[0].toLowerCase();
  const byPrefix = GOOGLE_ASR_LANGUAGES.find(
    (code) => code !== 'auto' && code.split('-')[0].toLowerCase() === prefix,
  );
  if (byPrefix) return byPrefix;
  if (prefix === 'zh') return 'cmn-Hans-CN';
  return undefined;
}

async function toBytes(audio: Buffer | Blob): Promise<{ bytes: Uint8Array; mime: string }> {
  if (audio instanceof Blob) {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    // `audio/webm;codecs=opus` → `audio/webm`; the API wants the bare type.
    const mime = (audio.type || '').split(';')[0].trim().toLowerCase();
    return { bytes, mime: mime || 'audio/webm' };
  }
  if (audio instanceof Buffer) {
    return { bytes: new Uint8Array(audio), mime: 'audio/webm' };
  }
  throw new Error('Invalid audio buffer type');
}

interface ContentPart {
  type?: string;
  text?: string;
}

function collectStepText(json: { steps?: unknown }): string | undefined {
  if (!Array.isArray(json.steps)) return undefined;
  const texts: string[] = [];
  for (const step of json.steps as Array<{ content?: unknown }>) {
    if (!Array.isArray(step?.content)) continue;
    for (const part of step.content as ContentPart[]) {
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    }
  }
  return texts.length > 0 ? texts.join('') : undefined;
}

export async function transcribeGoogleASR(
  config: ASRModelConfig,
  audioBuffer: Buffer | Blob,
): Promise<ASRTranscriptionResult> {
  const { bytes, mime } = await toBytes(audioBuffer);
  if (bytes.byteLength === 0) {
    return { text: '' };
  }

  const baseUrl = (config.baseUrl || GOOGLE_ASR_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const languageCode = resolveGoogleASRLanguage(config.language);

  const response = await fetch(`${baseUrl}/interactions`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': config.apiKey!,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model: config.modelId || GOOGLE_ASR_DEFAULT_MODEL,
      input: [
        {
          type: 'audio',
          data: Buffer.from(bytes).toString('base64'),
          mime_type: mime,
        },
      ],
      generation_config: {
        transcription_config: languageCode ? { language_codes: [languageCode] } : {},
      },
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    const detail = body?.error?.message || response.statusText;
    if (response.status === 429) {
      throw new Error(`Google ASR rate limited (429): ${detail}`);
    }
    throw new Error(`Google ASR API error (${response.status}): ${detail}`);
  }

  const json = (await response.json().catch(() => null)) as {
    output_text?: unknown;
    steps?: unknown;
  } | null;
  if (!json || typeof json !== 'object') {
    throw new Error('Google ASR returned a non-JSON body');
  }
  if (typeof json.output_text === 'string') {
    return { text: json.output_text.trim() };
  }
  const stepText = collectStepText(json);
  if (stepText !== undefined) {
    return { text: stepText.trim() };
  }
  throw new Error(
    `Google ASR returned no transcript (response keys: ${Object.keys(json).join(',')})`,
  );
}
