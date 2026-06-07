/**
 * VoxCPM voice-registration adapter (server-side) — the first concrete
 * implementation of the provider-neutral `VoiceRegistrationAdapter`.
 *
 * Drives the reference-by-id timbre-stability flow against vLLM-Omni
 * (`/v1/audio/voices`): synthesize a voice-design prompt once, register the
 * clip under a deterministic id, then later TTS references `voice=<id>`.
 */

import { buildVoiceDesignPrompt, type VoiceDesign } from '@/lib/audio/voice-design';
import {
  VOXCPM_VLLM_MODEL_ID,
  normalizeVoxCPMBackend,
  voxCPMBackendSupportsVoiceRegistration,
} from '@/lib/audio/voxcpm';
import type {
  VoiceRegistrationAdapter,
  VoiceRegistrationConfig,
} from '@/lib/audio/voice-registration';

function v1(baseUrl: string): string {
  const clean = baseUrl.replace(/\/$/, '');
  return clean.endsWith('/v1') ? clean : `${clean}/v1`;
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {};
}

function base64ToBlob(base64: string, mimeType?: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'audio/wav' });
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

/** Whether a voice id is already registered (vLLM-Omni has no per-name GET → list + membership). */
export async function voxCPMVoiceExists(
  cfg: VoiceRegistrationConfig,
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
  cfg: VoiceRegistrationConfig,
  params: { voiceId: string; referenceAudioBase64: string; mimeType?: string },
): Promise<string> {
  const form = new FormData();
  form.set('name', params.voiceId);
  form.set('consent', VOXCPM_VOICE_CONSENT);
  form.set(
    'audio_sample',
    base64ToBlob(params.referenceAudioBase64, params.mimeType),
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
  cfg: VoiceRegistrationConfig,
  params: { design: VoiceDesign; language?: string },
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

/** VoxCPM implementation of the provider-neutral registration adapter. */
export const voxcpmVoiceRegistrationAdapter: VoiceRegistrationAdapter = {
  supportsRegistration(options) {
    return voxCPMBackendSupportsVoiceRegistration(normalizeVoxCPMBackend(options?.backend));
  },
  voiceExists: voxCPMVoiceExists,
  registerVoice: registerVoxCPMVoice,
  bootstrapReferenceClip: bootstrapVoxCPMReferenceClip,
};
