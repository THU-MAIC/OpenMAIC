/**
 * VoxCPM voice-registration backend client (server-side).
 *
 * Drives the reference-by-id timbre-stability flow against backends that
 * expose a runtime voice-registration API (vLLM-Omni `/v1/audio/voices`):
 * synthesize a voice-design prompt once, register the resulting clip under a
 * deterministic id, then reference `voice=<id>` on later speech requests.
 */

import {
  buildVoiceDesignPrompt,
  VOXCPM_VLLM_MODEL_ID,
  type VoxCPMVoiceDesign,
} from '@/lib/audio/voxcpm';

export interface VoxCPMRegistrationConfig {
  baseUrl: string; // backend root or `.../v1`
  apiKey?: string;
  model?: string;
}

function v1(baseUrl: string): string {
  const clean = baseUrl.replace(/\/$/, '');
  return clean.endsWith('/v1') ? clean : `${clean}/v1`;
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {};
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** vLLM-Omni requires a consent string on voice registration. */
const VOXCPM_VOICE_CONSENT = 'I confirm I have the right to use this voice sample.';

/** A short neutral sentence used to synthesize the bootstrap reference clip. */
const BOOTSTRAP_SENTENCE: Record<string, string> = {
  default: 'Hello, welcome to today’s lesson. Let us begin.',
  zh: '你好，欢迎来到今天的课程，我们开始吧。',
};

function bootstrapSentence(language?: string): string {
  if (!language) return BOOTSTRAP_SENTENCE.default;
  const key = language.toLowerCase().split(/[-_]/)[0];
  return BOOTSTRAP_SENTENCE[key] || BOOTSTRAP_SENTENCE.default;
}

/**
 * Whether a voice id is already registered on the backend.
 *
 * vLLM-Omni exposes no per-name GET (that route is 405); list all voices and
 * check membership.
 */
export async function voxCPMVoiceExists(
  cfg: VoxCPMRegistrationConfig,
  voiceId: string,
): Promise<boolean> {
  const res = await fetch(`${v1(cfg.baseUrl)}/audio/voices`, {
    method: 'GET',
    headers: authHeaders(cfg.apiKey),
  });
  if (!res.ok) return false;
  const data = (await res.json().catch(() => ({}))) as { voices?: unknown };
  return Array.isArray(data.voices) && data.voices.includes(voiceId);
}

/** Register (or re-register, idempotently) a reference clip under `voiceId`. */
export async function registerVoxCPMVoice(
  cfg: VoxCPMRegistrationConfig,
  params: { voiceId: string; referenceAudioBase64: string; mimeType?: string },
): Promise<string> {
  const form = new FormData();
  form.set('name', params.voiceId);
  form.set('consent', VOXCPM_VOICE_CONSENT);
  form.set(
    'audio_sample',
    new Blob([base64ToBytes(params.referenceAudioBase64)], { type: params.mimeType || 'audio/wav' }),
    `${params.voiceId}.wav`,
  );

  const res = await fetch(`${v1(cfg.baseUrl)}/audio/voices`, {
    method: 'POST',
    headers: authHeaders(cfg.apiKey),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`VoxCPM voice registration failed: ${res.status}`);
  }
  const data = (await res.json().catch(() => ({}))) as { voice?: { name?: string } };
  return data.voice?.name || params.voiceId;
}

/** Synthesize the voice-design prompt once into a reference clip. */
export async function bootstrapVoxCPMReferenceClip(
  cfg: VoxCPMRegistrationConfig,
  params: { design: VoxCPMVoiceDesign; language?: string },
): Promise<{ referenceAudioBase64: string; mimeType: string }> {
  const prompt = buildVoiceDesignPrompt(params.design);
  const sample = bootstrapSentence(params.language);
  const res = await fetch(`${v1(cfg.baseUrl)}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...authHeaders(cfg.apiKey) },
    body: JSON.stringify({
      model: cfg.model || VOXCPM_VLLM_MODEL_ID,
      input: prompt ? `(${prompt})${sample}` : sample,
      voice: 'default',
      response_format: 'wav',
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`VoxCPM bootstrap synthesis failed: ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    referenceAudioBase64: bytesToBase64(bytes),
    mimeType: res.headers.get('content-type') || 'audio/wav',
  };
}
