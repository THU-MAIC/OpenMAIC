import { getTTSProvider, isKnownTTSProviderId, TTS_PROVIDERS } from '@/lib/audio/constants';
import type { BuiltInTTSProviderId } from '@/lib/audio/types';
import { findSlot, type ModelSettingsView } from '@/lib/model-settings/client';
import { knownDeviceOwnerKey } from '@/lib/device-storage/owner-key';

/** The account a private voice belongs to, independent of unrelated workspace settings edits. */
export function voiceAccountScope(
  view: ModelSettingsView | null,
  providerId?: string,
  voiceId?: string,
): string | undefined {
  const target = view && findSlot(view, 'tts')?.effective;
  if (
    !view ||
    target?.status !== 'assigned' ||
    (providerId !== undefined && providerId !== target.registryId)
  )
    return;
  const registry = TTS_PROVIDERS[target.registryId as BuiltInTTSProviderId];
  if (!registry?.supportsAccountVoices) return;
  // Built-in and operator-declared choices are usable wherever the service offers them.
  if (
    voiceId !== undefined &&
    (!voiceId ||
      registry.voices.some((v) => v.id === voiceId) ||
      target.voices?.some((v) => v.id === voiceId))
  )
    return;
  const provider = view.providers.find(
    (entry) => entry.id === target.providerId && entry.source === target.providerSource,
  );
  if (provider) {
    return JSON.stringify([provider.source, provider.id, provider.baseUrl, provider.key?.mask]);
  }
}

export interface VoiceAccount {
  readonly scope?: string;
  /** A cloud-only preference that this account's latest list could not find. */
  missingVoice?: string;
}

/** The same owner/service partition as the browser's saved clones. */
export function ownedVoiceScope(service?: string): string | undefined {
  const owner = knownDeviceOwnerKey();
  return owner && service ? `${owner}:${service}` : undefined;
}

const rejectionScopes = new WeakMap<ModelSettingsView, string>();
let nextRejectionScope = 0;

export function voiceRejectionScopeFor(
  view: ModelSettingsView | null | undefined,
  registryId: string | undefined,
): string | undefined {
  if (!view || !registryId || !isKnownTTSProviderId(registryId)) return;
  if (!getTTSProvider(registryId)?.scopeVoiceRejectionsToSettings) return;
  let scope = rejectionScopes.get(view);
  if (scope === undefined) {
    scope = `tts-view:${++nextRejectionScope}`;
    rejectionScopes.set(view, scope);
  }
  return scope;
}

const accounts = new WeakMap<ModelSettingsView, VoiceAccount>();

/** Selection and playback share the availability of the pick, without retaining a private list. */
export function voiceAccountFor(
  view: ModelSettingsView | null | undefined,
): VoiceAccount | undefined {
  if (!view) return;
  let account = accounts.get(view);
  if (!account) {
    const scope = voiceAccountScope(view);
    if (!scope) return;
    account = {
      get scope() {
        return ownedVoiceScope(scope);
      },
    };
    accounts.set(view, account);
  }
  return account;
}
