'use client';

/**
 * Provider-neutral client orchestrator for the auto-voice register-once flow.
 *
 * Given a provider id + voice design, it resolves a deterministic voice id,
 * ensures the voice is registered on the backend via `POST /api/generate/voice`
 * (which dispatches to the provider's adapter), and caches the reference clip
 * in IndexedDB so a GC'd voice can be re-registered. Callers decide *whether*
 * their provider supports registration; this module is provider-agnostic.
 */

import { db } from '@/lib/utils/database';
import { getDeterministicVoiceId, type VoiceDesign } from '@/lib/audio/voice-design';

export interface VoiceRegistrationRequestConfig {
  ttsApiKey?: string;
  ttsBaseUrl?: string;
  ttsModelId?: string;
}

function base64ToBlob(base64: string, mimeType?: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'audio/wav' });
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read reference audio'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

// Confirmed-registered + in-flight memos, keyed by (voiceId, backend, credential).
// The same voiceId may be unregistered — or inaccessible — on a different backend
// or under different credentials, so both the base URL and the API key are part
// of the key. Otherwise switching the VoxCPM base URL or account mid-session
// would skip re-registration and reuse an id from the old backend/credentials.
const registeredThisSession = new Set<string>();
const inFlight = new Map<string, Promise<string | undefined>>();

function memoKeyFor(voiceId: string, request: VoiceRegistrationRequestConfig): string {
  // In-memory only (never persisted or logged), so the raw key identity is fine.
  return `${voiceId}::${request.ttsBaseUrl ?? ''}::${request.ttsApiKey ?? ''}`;
}

async function getCachedClip(
  voiceId: string,
): Promise<{ base64: string; mimeType: string } | undefined> {
  const row = await db.autoVoiceCache.get(voiceId);
  if (!row) return undefined;
  return { base64: await blobToBase64(row.referenceAudio), mimeType: row.mimeType };
}

/**
 * Ensure the agent's deterministic auto voice is registered for `providerId`,
 * returning its voice id (or undefined when unavailable, so callers fall back
 * to the inline voice-design prompt). Lazy + idempotent: memoized per session,
 * reference clip cached in IndexedDB. register-on-invalid is handled by the
 * endpoint's existence check, which re-registers a GC'd voice from the clip.
 */
export async function ensureRegisteredVoice(
  providerId: string,
  params: { voiceDesign?: VoiceDesign; language?: string },
  request: VoiceRegistrationRequestConfig,
): Promise<string | undefined> {
  if (!params.voiceDesign) return undefined;

  const voiceId = await getDeterministicVoiceId(params.voiceDesign, {
    providerId,
    model: request.ttsModelId,
  });
  const memoKey = memoKeyFor(voiceId, request);
  if (registeredThisSession.has(memoKey)) return voiceId;

  // Coalesce concurrent calls for the same (voiceId, backend) into one request.
  const existing = inFlight.get(memoKey);
  if (existing) return existing;

  const promise = registerOnce(providerId, voiceId, memoKey, params, request).finally(() =>
    inFlight.delete(memoKey),
  );
  inFlight.set(memoKey, promise);
  return promise;
}

async function registerOnce(
  providerId: string,
  voiceId: string,
  memoKey: string,
  params: { voiceDesign?: VoiceDesign; language?: string },
  request: VoiceRegistrationRequestConfig,
): Promise<string | undefined> {
  const cached = await getCachedClip(voiceId);
  const res = await fetch('/api/generate/voice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId,
      voiceId,
      descriptor: params.voiceDesign,
      language: params.language,
      referenceAudioBase64: cached?.base64,
      mimeType: cached?.mimeType,
      ...request,
    }),
  });
  if (!res.ok) return undefined; // graceful fallback to the inline prompt path

  const data = (await res.json().catch(() => ({}))) as {
    referenceAudioBase64?: string;
    mimeType?: string;
  };
  if (data.referenceAudioBase64 && !cached) {
    await db.autoVoiceCache.put({
      voiceId,
      referenceAudio: base64ToBlob(data.referenceAudioBase64, data.mimeType),
      mimeType: data.mimeType || 'audio/wav',
      updatedAt: Date.now(),
    });
  }
  registeredThisSession.add(memoKey);
  return voiceId;
}
