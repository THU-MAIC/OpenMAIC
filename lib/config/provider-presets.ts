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
import { presetIdFor, tokenPlanPresetId } from '@/lib/config/preset-ids';
import { STAGE_SLOTS, type SlotCapability, type SlotId } from '@/lib/config/model-slots';
import type { LlmStage } from '@/lib/server/model-routes';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';
import type { ThinkingCapability } from '@/lib/types/provider';

export interface PresetCapabilityTarget {
  /** Entry of that capability's built-in registry that serves the calls. */
  registryId: string;
  /** Endpoint to use instead of the registry default (token plans). */
  baseUrl?: string;
  /** Models offered through this preset, best first (token plans). */
  models?: readonly string[];
  /** The model a provider-only reference means (token plans); else the registry's default. */
  defaultModel?: string;
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
  /** True when the preset authenticates with a key pair (`credentials`) rather than one key. */
  requiresCredentials?: boolean;
  /**
   * False when the registry entry only supplies the transport, so its model
   * catalogue says nothing about the models behind the endpoint (a custom
   * OpenAI-compatible server).
   */
  trustsModelCatalogue?: false;
}

type RegistryEntry = {
  name?: string;
  requiresApiKey?: boolean;
  requiresBaseUrl?: boolean;
  requiresCredentials?: boolean;
};

const REGISTRIES: Record<SlotCapability, Record<string, RegistryEntry>> = {
  chat: PROVIDERS,
  tts: TTS_PROVIDERS,
  asr: ASR_PROVIDERS,
  image: IMAGE_PROVIDERS,
  video: VIDEO_PROVIDERS,
  webSearch: WEB_SEARCH_PROVIDERS,
  document: PDF_PROVIDERS,
};

export { PRESET_ID_OVERRIDES } from '@/lib/config/preset-ids';

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
        id: presetIdFor(capability, registryId),
        name: entry.name ?? registryId,
        kind: 'single',
        capabilities: { [capability]: { registryId } },
        ...(requiresBaseUrl ? { requiresBaseUrl } : {}),
        ...(entry.requiresCredentials ? { requiresCredentials: true } : {}),
      });
    }
  }
  presets.push({
    id: 'openai-compatible',
    name: 'OpenAI-compatible endpoint',
    kind: 'single',
    capabilities: { chat: { registryId: 'openai' } },
    requiresBaseUrl: true,
    trustsModelCatalogue: false,
  });
  return presets;
}

/** Converts a token plan into a preset: modality targets and recommendations. */
export function tokenPlanToPreset(plan: TokenPlanPreset): ProviderPreset {
  const id = tokenPlanPresetId(plan.id);
  const capabilities: ProviderPreset['capabilities'] = {};
  const recommended: Partial<Record<SlotId, string>> = {};
  for (const [modality, target] of Object.entries(plan.modalities) as [
    TokenPlanModality,
    NonNullable<TokenPlanPreset['modalities'][TokenPlanModality]>,
  ][]) {
    const capability = MODALITY_CAPABILITY[modality];
    const lead = target.defaultModelId ?? target.defaultModels?.[0];
    capabilities[capability] = {
      registryId: target.providerId,
      baseUrl: target.baseUrl,
      ...(target.defaultModels ? { models: target.defaultModels } : {}),
      ...(lead ? { defaultModel: lead } : {}),
    };
    const root = capability === 'chat' ? 'llm' : capability;
    if (lead) recommended[root as SlotId] = lead;
    // A capability without models to pick (web search) is served by the
    // provider alone: the recommendation names its registry entry, which the
    // first-run wizard turns into a provider-only assignment.
    else if (!target.defaultModels?.length) recommended[root as SlotId] = target.providerId;
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

/** The registry's default endpoint for a capability's provider, if it has one. */
export function registryDefaultBaseUrl(
  capability: SlotCapability,
  registryId: string,
): string | undefined {
  const entry = REGISTRIES[capability][registryId] as { defaultBaseUrl?: string } | undefined;
  return entry?.defaultBaseUrl || undefined;
}

/**
 * Whether a capability's provider needs a key to be called (a local server or
 * a keyless search does not). Unknown entries are taken to need one.
 */
export function registryRequiresApiKey(capability: SlotCapability, registryId: string): boolean {
  return REGISTRIES[capability][registryId]?.requiresApiKey !== false;
}

export interface CatalogueModel {
  id: string;
  name: string;
  /** What the registry says the model can do (chat models), for the settings to show. */
  capabilities?: {
    streaming?: boolean;
    tools?: boolean;
    vision?: boolean;
    thinking?: ThinkingCapability;
  };
  contextWindow?: number;
  outputWindow?: number;
}

type RegistryModel = {
  id: string;
  name?: string;
  capabilities?: CatalogueModel['capabilities'];
  contextWindow?: number;
  outputWindow?: number;
};

/**
 * A model as the catalogue lists it: its name and what the registry knows of
 * it. A chat model the registry does not list (a token plan's, or one a
 * provider pins) still gets the thinking controls the metadata knows for it.
 */
export function catalogueModel(
  capability: SlotCapability,
  registryId: string,
  id: string,
  known?: RegistryModel,
): CatalogueModel {
  const thinking =
    known?.capabilities?.thinking ??
    (capability === 'chat' ? getCatalogThinkingCapability(registryId, id) : undefined);
  const capabilities = { ...known?.capabilities, ...(thinking ? { thinking } : {}) };
  return {
    id,
    name: known?.name ?? id,
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    ...(known?.contextWindow ? { contextWindow: known.contextWindow } : {}),
    ...(known?.outputWindow ? { outputWindow: known.outputWindow } : {}),
  };
}

/**
 * The models a preset offers for a capability, best first: a token plan's own
 * list, else the registry's catalogue. Empty for a capability without one
 * (web search, document extraction) or a preset that does not offer it.
 */
export function presetModels(preset: ProviderPreset, capability: SlotCapability): CatalogueModel[] {
  const target = preset.capabilities[capability];
  if (!target) return [];
  const known = registryModels(capability, target.registryId);
  const ids = target.models ?? known.map((model) => model.id);
  return ids.map((id) =>
    catalogueModel(
      capability,
      target.registryId,
      id,
      known.find((model) => model.id === id),
    ),
  );
}

/** The models a capability's registry entry lists. */
export function registryModels(
  capability: SlotCapability,
  registryId: string,
): readonly RegistryModel[] {
  const entry = REGISTRIES[capability][registryId] as
    | { models?: readonly RegistryModel[] }
    | undefined;
  return entry?.models ?? [];
}
