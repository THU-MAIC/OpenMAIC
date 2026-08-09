/**
 * TTS provider enablement model (#665)
 *
 * A single, framework-agnostic source of truth for "which TTS providers may be
 * used", honored everywhere (voice picker, auto-assignment, fallback, toolbar
 * CTA). It collapses the previously ad-hoc gates in voice-resolver, the
 * hardcoded browser-native branch in the agent UI, and the implicit fallbacks
 * into two layered predicates:
 *
 *   configured  — the provider has a real credential path (server-managed, a
 *                 client API key, or an explicit base URL). browser-native is
 *                 intrinsically configured (it runs in the browser).
 *   enabled     — configured AND not server-disabled AND the user's per-provider
 *                 `enabled` flag is not explicitly false.
 *
 * Server precedence: `serverDisabled` (admin/server-level disable via
 * server-providers.yml / env) forces a provider off regardless of the user
 * toggle.
 *
 * No React, no IO — pure functions over the persisted ttsProvidersConfig slice,
 * so they are trivially unit-testable and safe to import in both client and
 * server code.
 */

import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { isCustomTTSProvider, type TTSProviderId } from '@/lib/audio/types';

export const BROWSER_NATIVE_TTS_PROVIDER_ID = 'browser-native-tts' as const;

/** The slice of a persisted ttsProvidersConfig entry the predicates rely on. */
export interface TTSEnablementConfig {
  apiKey?: string;
  baseUrl?: string;
  /** User-level per-provider toggle. Absent / true ⇒ allowed; false ⇒ hidden. */
  enabled?: boolean;
  isServerConfigured?: boolean;
  serverBaseUrl?: string;
  /** Server/admin force-off (server-providers.yml / env). Overrides `enabled`. */
  serverDisabled?: boolean;
  requiresApiKey?: boolean;
  customVoices?: Array<{ id: string; name: string }>;
}

type ConfigMap = Partial<Record<string, TTSEnablementConfig>>;

function hasText(value: string | undefined): boolean {
  return !!value && value.trim().length > 0;
}

/**
 * Whether a provider has a usable credential path (is "available").
 *
 * Deliberately does NOT fall back to the registry `defaultBaseUrl`: a keyless
 * local provider (e.g. Lemonade) must be shown only once the operator
 * server-configures it or the user supplies an explicit base URL — otherwise
 * its voices are selectable while nothing is actually running there (#665
 * symptom 1).
 */
export function isTTSProviderConfigured(
  providerId: TTSProviderId,
  config: TTSEnablementConfig | undefined,
): boolean {
  // Browser-native runs in-browser; it never needs a credential path.
  if (providerId === BROWSER_NATIVE_TTS_PROVIDER_ID) return true;
  if (!config) return false;
  if (config.isServerConfigured) return true;

  if (isCustomTTSProvider(providerId)) {
    // A custom provider is usable once it has a credential path or any voices
    // the user defined for it (its existing visibility rule).
    return (
      hasText(config.apiKey) || hasText(config.baseUrl) || (config.customVoices?.length ?? 0) > 0
    );
  }

  const def = TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS];
  if (!def) return false;
  if (def.requiresApiKey) return hasText(config.apiKey);
  // Keyless built-in (VoxCPM, Lemonade): require an EXPLICIT base URL.
  return hasText(config.serverBaseUrl) || hasText(config.baseUrl);
}

/**
 * Whether a provider may be used: configured, not server-disabled, and the
 * user's per-provider `enabled` flag is not explicitly false.
 */
export function isTTSProviderEnabled(
  providerId: TTSProviderId,
  config: TTSEnablementConfig | undefined,
): boolean {
  if (config?.serverDisabled) return false; // server precedence
  if (!isTTSProviderConfigured(providerId, config)) return false;
  return config?.enabled !== false;
}

/**
 * All enabled provider IDs in canonical (deterministic) registry order,
 * built-ins first then custom providers. Includes browser-native only when it
 * is explicitly enabled. Used for the toolbar empty-state CTA decision.
 */
export function listEnabledTTSProviderIds(config: ConfigMap): TTSProviderId[] {
  const ids: TTSProviderId[] = [];
  for (const id of Object.keys(TTS_PROVIDERS) as TTSProviderId[]) {
    if (isTTSProviderEnabled(id, config[id])) ids.push(id);
  }
  for (const id of Object.keys(config)) {
    if (isCustomTTSProvider(id) && isTTSProviderEnabled(id as TTSProviderId, config[id])) {
      ids.push(id as TTSProviderId);
    }
  }
  return ids;
}

/** Whether at least one TTS provider (incl. browser-native) is enabled. */
export function hasAnyEnabledTTSProvider(config: ConfigMap): boolean {
  for (const id of Object.keys(TTS_PROVIDERS) as TTSProviderId[]) {
    if (isTTSProviderEnabled(id, config[id])) return true;
  }
  for (const id of Object.keys(config)) {
    if (isCustomTTSProvider(id) && isTTSProviderEnabled(id as TTSProviderId, config[id])) {
      return true;
    }
  }
  return false;
}
