/**
 * Provider-neutral voice catalog merge.
 *
 * One implementation shared by every consumer that needs "the voices this
 * deployment can actually bind": the agent's `list_voices` tool and
 * `set_roster`'s binding validation. It merges two sources into one flat,
 * bindable list:
 *
 *   - presets: the enabled providers' registry voices (`TTS_PROVIDERS[id].voices`);
 *   - registered voices: runtime-registered voices (the session's
 *     `register_voice` results).
 *
 * Clone visibility is judged by capability bits, never by provider id:
 *
 *   - `supportsClone` gates clone-kind registered voices (they are bindable
 *     only when the deployment can synthesize clones, i.e. a registration
 *     backend is configured);
 *   - `requiresRegisteredVoice` marks a provider whose ONLY synthesizable
 *     voices are registered ones, so its registered voices stay visible
 *     regardless of `supportsClone`.
 *
 * This module is client-safe (no Node/React/server imports) so both client
 * components and server-side tool code can share it.
 */

import type { TTSVoiceInfo } from '@/lib/audio/types';

/** A voice that was registered at runtime (session `register_voice` results). */
export interface RegisteredVoiceInfo {
  providerId: string;
  voiceId: string;
  name: string;
  language?: string;
  gender?: 'male' | 'female' | 'neutral';
  description?: string;
  /**
   * `clone` voices are hidden unless the deployment can synthesize them
   * (see `VoiceCatalogOptions.supportsClone` / `requiresRegisteredVoice`).
   */
  kind?: 'prompt' | 'clone';
}

/** Minimal provider shape the merge needs (`TTSProviderConfig` satisfies it). */
export interface VoiceCatalogProvider {
  id: string;
  voices: Array<{
    id: string;
    name: string;
    language?: string;
    gender?: 'male' | 'female' | 'neutral';
    description?: string;
  }>;
  requiresRegisteredVoice?: boolean;
}

export interface VoiceCatalogOptions {
  /**
   * Whether this deployment can synthesize clone-kind registered voices (a
   * voice-registration backend is configured). Absent `clone` voices stay
   * hidden when false.
   */
  supportsClone?: boolean;
}

/** One bindable catalog entry: a preset or a registered voice, tagged with
 * its provider and the exact `providerId::voiceId` `set_roster` takes. */
export interface CatalogVoice extends Omit<TTSVoiceInfo, 'language'> {
  language?: string;
  providerId: string;
  binding: string;
}

function toCatalogVoice(
  providerId: string,
  voice: {
    id: string;
    name: string;
    language?: string;
    gender?: 'male' | 'female' | 'neutral';
    description?: string;
  },
): CatalogVoice {
  return { ...voice, providerId, binding: `${providerId}::${voice.id}` };
}

/**
 * Merge enabled providers' presets with runtime-registered voices into one
 * flat, bindable catalog.
 *
 * Order: presets first in provider order (voices in registry order), then
 * registered voices in caller order. Each entry's `binding` is the exact
 * `providerId::voiceId` string `set_roster`'s `voice` field takes.
 *
 * A registered voice is skipped when its provider is not in the enabled set
 * (nothing to synthesize on). Clone-kind registered voices are skipped when
 * the deployment cannot synthesize clones (`supportsClone` false) — UNLESS
 * the provider declares `requiresRegisteredVoice`, in which case its
 * registered voices are its only voices and must always be offered.
 */
export function buildVoiceCatalog(
  providers: VoiceCatalogProvider[],
  registeredVoices: RegisteredVoiceInfo[] = [],
  options: VoiceCatalogOptions = {},
): CatalogVoice[] {
  const enabled = new Map(providers.map((provider) => [provider.id, provider]));
  const supportsClone = options.supportsClone === true;
  const result: CatalogVoice[] = [];

  for (const provider of providers) {
    for (const voice of provider.voices) {
      result.push(toCatalogVoice(provider.id, voice));
    }
  }

  for (const registered of registeredVoices) {
    const provider = enabled.get(registered.providerId);
    if (!provider) continue; // provider not enabled — nothing to synthesize on
    if (
      registered.kind === 'clone' &&
      provider.requiresRegisteredVoice !== true &&
      !supportsClone
    ) {
      continue; // clone not synthesizable by this deployment
    }
    result.push(
      toCatalogVoice(registered.providerId, {
        id: registered.voiceId,
        name: registered.name,
        language: registered.language ?? 'auto',
        ...(registered.gender ? { gender: registered.gender } : {}),
        ...(registered.description ? { description: registered.description } : {}),
      }),
    );
  }

  return result;
}
