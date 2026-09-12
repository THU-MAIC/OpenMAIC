/**
 * Legacy environment fallback for the deployment speech policy.
 *
 * This is deliberately outside provider-config.ts. The latter is a
 * provider-neutral resolver and is covered by a vendor-leak guard; a concrete
 * experiment policy belongs at this vendor-specific boundary instead.
 */

import { getPersistedProviderPolicy } from '@/lib/server/persisted-provider-policy';

export interface ServerAudioPolicy {
  locked: boolean;
  ttsProviderId?: string;
  asrProviderId?: string;
}

/**
 * Return the optional hard boundary for speech generation and recognition.
 * Normal deployments remain unlocked unless explicitly configured. The
 * database-backed resolver below takes precedence when persistence is on.
 */
export function getServerAudioPolicy(): ServerAudioPolicy {
  const configured = process.env.OPENMAIC_AUDIO_ONLY_PROVIDER?.trim().toLowerCase();
  if (configured === 'doubao') {
    return { locked: true, ttsProviderId: 'doubao-tts', asrProviderId: 'doubao-asr' };
  }
  return { locked: false };
}

/** Resolve the database-backed policy, falling back to the legacy env policy
 * only when server persistence is not configured. */
export async function getEffectiveServerAudioPolicy(): Promise<ServerAudioPolicy> {
  const persisted = await getPersistedProviderPolicy();
  if (persisted) {
    return persisted.audioLocked
      ? {
          locked: true,
          ttsProviderId: persisted.ttsProviderId ?? undefined,
          asrProviderId: persisted.asrProviderId ?? undefined,
        }
      : { locked: false };
  }
  return getServerAudioPolicy();
}
