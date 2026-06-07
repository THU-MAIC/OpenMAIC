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

// Voice ids confirmed registered in this browser session — skip the round-trip.
const registeredThisSession = new Set<string>();

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
  if (registeredThisSession.has(voiceId)) return voiceId;

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
  registeredThisSession.add(voiceId);
  return voiceId;
}
