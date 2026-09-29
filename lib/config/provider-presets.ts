/**
 * Provider presets (RFC #1701, tracked in #1725).
 *
 * A provider is an account the server can call: `{ preset, apiKey, baseUrl }`.
 * Its preset says which capabilities that one account covers and which entry of
 * each capability's registry serves it. Presets come from two sources:
 *
 * - Single-capability presets, one per built-in registry entry. Most vendors
 *   use separate keys (or separate services) per capability, so a preset only
 *   spans capabilities when one key is known to cover them.
 * - Token plan presets (`TOKEN_PLAN_PRESETS`), which cover several
 *   capabilities with one key and recommend assignments for the slots they
 *   cover.
 *
 * Preset ids are unique across both sources. Where a registry id collides with
 * another capability's registry id or a token plan id, the preset id is
 * spelled out in {@link PRESET_ID_OVERRIDES}.
 */
import { PROVIDERS } from '@/lib/ai/providers';
import { ASR_PROVIDERS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import {
  TOKEN_PLAN_PRESETS,
  type TokenPlanModality,
  type TokenPlanPreset,
} from '@/lib/config/token-plan-presets';
import { STAGE_SLOTS, type SlotCapability, type SlotId } from '@/lib/config/model-slots';
import type { LlmStage } from '@/lib/server/model-routes';

export interface PresetCapabilityTarget {
  /** Entry of that capability's built-in registry that serves the calls. */
  registryId: string;
  /** Endpoint to use instead of the registry default (token plans). */
  baseUrl?: string;
  /** Models offered through this preset, best first (token plans). */
  models?: readonly string[];
}

export interface ProviderPreset {
  id: string;
  name: string;
  kind: 'single' | 'token-plan';
  capabilities: Partial<Record<SlotCapability, PresetCapabilityTarget>>;
  /** Assignments the first-run wizard fills for slots that are still empty. */
  recommended?: Partial<Record<SlotId, string>>;
  /** True when the preset needs a caller-supplied base URL. */
  requiresBaseUrl?: boolean;
}

type RegistryEntry = { name?: string; requiresBaseUrl?: boolean };

const REGISTRIES: Record<SlotCapability, Record<string, RegistryEntry>> = {
  chat: PROVIDERS,
  tts: TTS_PROVIDERS,
  asr: ASR_PROVIDERS,
  image: IMAGE_PROVIDERS,
  video: VIDEO_PROVIDERS,
  webSearch: WEB_SEARCH_PROVIDERS,
  document: PDF_PROVIDERS,
};

/**
 * Preset ids for registry entries whose own id is taken: web search entries
 * that share an id with a chat provider, and chat providers that share an id
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
const TOKEN_PLAN_ID_OVERRIDES: Record<string, string> = { kimi: 'kimi-coding-plan' };

/**
 * Registry entries with no usable default endpoint, besides those whose
 * registry entry already says `requiresBaseUrl` (SearXNG): an Azure OpenAI
 * resource has its own endpoint, and self-hosted MinerU runs wherever the
 * operator put it.
 */
const REQUIRES_BASE_URL: Partial<Record<SlotCapability, readonly string[]>> = {
  chat: ['azure'],
  document: ['mineru'],
};

const MODALITY_CAPABILITY: Record<TokenPlanModality, SlotCapability> = {
  llm: 'chat',
  image: 'image',
  video: 'video',
  tts: 'tts',
  webSearch: 'webSearch',
};

function singlePresets(): ProviderPreset[] {
  const presets: ProviderPreset[] = [];
  for (const [capability, registry] of Object.entries(REGISTRIES) as [
    SlotCapability,
    Record<string, RegistryEntry>,
  ][]) {
    for (const [registryId, entry] of Object.entries(registry)) {
      const requiresBaseUrl =
        entry.requiresBaseUrl === true || !!REQUIRES_BASE_URL[capability]?.includes(registryId);
      presets.push({
        id: PRESET_ID_OVERRIDES[capability]?.[registryId] ?? registryId,
        name: entry.name ?? registryId,
        kind: 'single',
        capabilities: { [capability]: { registryId } },
        ...(requiresBaseUrl ? { requiresBaseUrl } : {}),
      });
    }
  }
  presets.push({
    id: 'openai-compatible',
    name: 'OpenAI-compatible endpoint',
    kind: 'single',
    capabilities: { chat: { registryId: 'openai' } },
    requiresBaseUrl: true,
  });
  return presets;
}

/** Converts a token plan into a preset: modality targets and recommendations. */
export function tokenPlanToPreset(plan: TokenPlanPreset): ProviderPreset {
  const id = TOKEN_PLAN_ID_OVERRIDES[plan.id] ?? plan.id;
  const capabilities: ProviderPreset['capabilities'] = {};
  const recommended: Partial<Record<SlotId, string>> = {};
  for (const [modality, target] of Object.entries(plan.modalities) as [
    TokenPlanModality,
    NonNullable<TokenPlanPreset['modalities'][TokenPlanModality]>,
  ][]) {
    const capability = MODALITY_CAPABILITY[modality];
    capabilities[capability] = {
      registryId: target.providerId,
      baseUrl: target.baseUrl,
      ...(target.defaultModels ? { models: target.defaultModels } : {}),
    };
    const lead = target.defaultModelId ?? target.defaultModels?.[0];
    const root = capability === 'chat' ? 'llm' : capability;
    if (lead) recommended[root as SlotId] = lead;
    for (const [stage, model] of Object.entries(target.stageRoutes ?? {})) {
      const slot = STAGE_SLOTS[stage as LlmStage];
      if (slot) recommended[slot] = model;
    }
  }
  return { id, name: plan.name, kind: 'token-plan', capabilities, recommended };
}

function buildPresets(): ProviderPreset[] {
  const plans = TOKEN_PLAN_PRESETS.map(tokenPlanToPreset);
  const planIds = new Set(plans.map((plan) => plan.id));
  // A token plan that covers a chat provider's own endpoint (MiniMax,
  // TokenDance) supersedes the single-capability preset of the same id.
  const singles = singlePresets().filter((preset) => !planIds.has(preset.id));
  return [...plans, ...singles];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = buildPresets();

const PRESET_BY_ID = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export function getProviderPreset(id: string): ProviderPreset | undefined {
  return PRESET_BY_ID.get(id);
}
