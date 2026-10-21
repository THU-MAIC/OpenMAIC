/**
 * Preset ids (RFC #1701), as plain data: which preset a capability's registry
 * entry or a token plan becomes. Client-safe (no registry imports), so the
 * browser settings import can name presets without loading provider code;
 * `provider-presets.ts` builds the presets from the same tables.
 */
import type { SlotCapability } from '@/lib/config/model-slots';

/**
 * Preset ids for registry entries whose own id is taken: web search entries
 * that share an id with a chat provider, and image entries that share an id
 * with a token plan offering a different endpoint.
 */
export const PRESET_ID_OVERRIDES: Partial<Record<SlotCapability, Record<string, string>>> = {
  webSearch: { minimax: 'minimax-search', doubao: 'doubao-search' },
  image: { lemonade: 'lemonade-image' },
};

/**
 * Token plans whose id matches a chat provider but whose endpoint differs from
 * it (the Kimi coding plan is not the Moonshot open platform), so the plan gets
 * its own preset id and the chat provider keeps its id.
 */
export const TOKEN_PLAN_ID_OVERRIDES: Record<string, string> = { kimi: 'kimi-coding-plan' };

/** The preset of a capability's built-in registry entry. */
export function presetIdFor(capability: SlotCapability, registryId: string): string {
  return PRESET_ID_OVERRIDES[capability]?.[registryId] ?? registryId;
}

/** The preset of a token plan. */
export function tokenPlanPresetId(planId: string): string {
  return TOKEN_PLAN_ID_OVERRIDES[planId] ?? planId;
}

/**
 * Presets earlier versions offered and this build no longer has, with why
 * they were removed and the environment prefix the legacy variables used. A
 * configuration that still declares a provider with one of them keeps
 * loading: the provider resolves nothing, and the slots that named it follow
 * their parents again (see retiredProviderIds in resolve-slot.ts).
 */
export const RETIRED_PRESETS: Readonly<Record<string, { reason: string; envPrefix?: string }>> = {
  veo: {
    reason:
      'the Veo video provider was removed because Google shut down its Veo 3.1 preview models on October 22, 2026',
    envPrefix: 'VIDEO_VEO',
  },
};

/** Why a preset was removed, when it is one this build retired. */
export function retiredPresetReason(presetId: string): string | undefined {
  return Object.hasOwn(RETIRED_PRESETS, presetId) ? RETIRED_PRESETS[presetId].reason : undefined;
}
