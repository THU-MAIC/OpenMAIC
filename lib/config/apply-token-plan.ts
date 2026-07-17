import type { ProviderId } from '@/lib/types/provider';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import type {
  TokenPlanModality,
  TokenPlanModalityTarget,
  TokenPlanPreset,
} from './token-plan-presets';
import { MODALITY_ORDER } from './token-plan-presets';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';
import { PROVIDERS } from '@/lib/ai/providers';
import { findModelById } from '@/lib/ai/model-aliases';
import type { ModelInfo } from '@/lib/types/provider';

/**
 * The subset of settings-store setters needed to fill a token plan across
 * modalities. Injected so the orchestration is a pure, testable function.
 * Signatures mirror the store actions so they can be passed verbatim.
 */
export interface TokenPlanActions {
  setProviderConfig: (id: ProviderId, config: Record<string, unknown>) => void;
  setImageProviderConfig: (
    id: ImageProviderId,
    config: Partial<{
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      customModels: Array<{ id: string; name: string }>;
      replaceBuiltInModels: boolean;
    }>,
  ) => void;
  setVideoProviderConfig: (
    id: VideoProviderId,
    config: Partial<{
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      customModels: Array<{ id: string; name: string }>;
      replaceBuiltInModels: boolean;
    }>,
  ) => void;
  setTTSProviderConfig: (
    id: TTSProviderId,
    config: Partial<{ apiKey: string; baseUrl: string; enabled: boolean; modelId: string }>,
  ) => void;
  setWebSearchProviderConfig: (
    id: WebSearchProviderId,
    config: Partial<{ apiKey: string; baseUrl: string; enabled: boolean }>,
  ) => void;
  /**
   * Optional model-selection setters. When provided, applying an image/video
   * modality that declares `defaultModels` also makes that provider+model the
   * active selection, so the plan's model is used out of the box. Optional so
   * `applyTokenPlan` stays usable in tests/headless callers without them.
   */
  setImageProvider?: (id: ImageProviderId) => void;
  setImageModelId?: (modelId: string) => void;
  setVideoProvider?: (id: VideoProviderId) => void;
  setVideoModelId?: (modelId: string) => void;
}

export interface ApplyResult {
  modality: TokenPlanModality;
  // 'pending' is a UI-only state the settings page sets while a live probe is in
  // flight; applyTokenPlan itself only ever returns 'lit' or 'failed'.
  status: 'pending' | 'lit' | 'failed';
  providerId: string;
  detail?: string;
}

/**
 * Fills the API key into every modality the preset declares and enables it.
 * Each modality is isolated: a thrown setter doesn't abort the others.
 *
 * Note: this fills config synchronously. For LLM, the caller may additionally
 * trigger model probing (via /api/provider/probe-models) to populate the model
 * list — that's async and lives in the UI, not here.
 */
export function applyTokenPlan(
  preset: TokenPlanPreset,
  apiKey: string,
  actions: TokenPlanActions,
): ApplyResult[] {
  const results: ApplyResult[] = [];

  for (const modality of MODALITY_ORDER) {
    const target = preset.modalities[modality];
    if (!target) continue;

    try {
      applyModality(modality, target, preset, apiKey, actions);
      results.push({ modality, status: 'lit', providerId: target.providerId });
    } catch (err) {
      results.push({
        modality,
        status: 'failed',
        providerId: target.providerId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

function catalogModelFor(target: TokenPlanModalityTarget, id: string): ModelInfo | undefined {
  const direct = findModelById(
    target.providerId,
    PROVIDERS[target.providerId as ProviderId]?.models,
    id,
  );
  if (direct) return direct;

  const allModels = Object.values(PROVIDERS).flatMap((provider) => provider.models);
  return (
    allModels.find((m) => m.id === id) ??
    allModels.find((m) => m.id.toLowerCase() === id.toLowerCase())
  );
}

function tokenPlanModelInfo(target: TokenPlanModalityTarget, id: string): ModelInfo {
  const catalog = catalogModelFor(target, id);
  const thinking = getCatalogThinkingCapability(target.providerId, id);
  if (catalog) {
    return {
      ...catalog,
      id,
      name: catalog.name || id,
      capabilities: {
        ...catalog.capabilities,
        ...(thinking ? { thinking } : {}),
      },
    };
  }
  return {
    id,
    name: id,
    capabilities: {
      streaming: true,
      tools: true,
      vision: false,
      ...(thinking ? { thinking } : {}),
    },
  };
}

function applyModality(
  modality: TokenPlanModality,
  target: TokenPlanModalityTarget,
  preset: TokenPlanPreset,
  apiKey: string,
  actions: TokenPlanActions,
): void {
  switch (modality) {
    case 'llm':
      actions.setProviderConfig(target.providerId as ProviderId, {
        apiKey,
        baseUrl: target.baseUrl,
        type: target.apiFormat ?? 'openai',
        name: preset.name,
        icon: preset.icon,
        requiresApiKey: true,
        isBuiltIn: false,
        // Seed the model list from the preset's curated `defaultModels`.
        // Token-plan apply never probes individual models; unsupported tier
        // picks surface at generation time instead of being silently pruned.
        // Overlay the built-in thinking capability so seeded models keep their
        // thinking control instead of silently losing it (the probe step does
        // the same when it replaces this list).
        models: (target.defaultModels ?? []).map((id) => tokenPlanModelInfo(target, id)),
        ...(target.modelsUrl ? { modelsUrl: target.modelsUrl } : {}),
      });
      break;
    case 'image': {
      // Inject the plan's model ids as custom models (the registry defaults may
      // not be valid on this plan's endpoint), and make the first the active
      // selection so image generation works out of the box.
      const customModels = (target.defaultModels ?? []).map((id) => ({ id, name: id }));
      actions.setImageProviderConfig(target.providerId as ImageProviderId, {
        apiKey,
        baseUrl: target.baseUrl,
        enabled: true,
        ...(customModels.length ? { customModels, replaceBuiltInModels: true } : {}),
      });
      if (customModels.length) {
        actions.setImageProvider?.(target.providerId as ImageProviderId);
        actions.setImageModelId?.(customModels[0].id);
      }
      break;
    }
    case 'video': {
      const customModels = (target.defaultModels ?? []).map((id) => ({ id, name: id }));
      actions.setVideoProviderConfig(target.providerId as VideoProviderId, {
        apiKey,
        baseUrl: target.baseUrl,
        enabled: true,
        ...(customModels.length ? { customModels, replaceBuiltInModels: true } : {}),
      });
      if (customModels.length) {
        actions.setVideoProvider?.(target.providerId as VideoProviderId);
        actions.setVideoModelId?.(customModels[0].id);
      }
      break;
    }
    case 'tts':
      actions.setTTSProviderConfig(target.providerId as TTSProviderId, {
        apiKey,
        baseUrl: target.baseUrl,
        enabled: true,
        ...(target.defaultModelId ? { modelId: target.defaultModelId } : {}),
      });
      break;
    case 'webSearch':
      actions.setWebSearchProviderConfig(target.providerId as WebSearchProviderId, {
        apiKey,
        baseUrl: target.baseUrl,
        enabled: true,
      });
      break;
  }
}

/**
 * Removes a token plan: clears the API key and disables every modality it
 * declared. For LLM, applying overwrote the shared built-in provider in place
 * (baseUrl, models, name, icon, isBuiltIn: false, …), so removal must restore
 * those built-in defaults — not just clear the key — or the provider stays
 * pointed at the plan endpoint with plan-specific model ids. For image/video,
 * the store switches the active selection away when the provider is disabled
 * (see setImageProviderConfig/setVideoProviderConfig). Each modality is isolated
 * — a thrown setter doesn't abort the rest.
 */
export function removeTokenPlan(preset: TokenPlanPreset, actions: TokenPlanActions): ApplyResult[] {
  const results: ApplyResult[] = [];

  for (const modality of MODALITY_ORDER) {
    const target = preset.modalities[modality];
    if (!target) continue;

    try {
      removeModality(modality, target, actions);
      results.push({ modality, status: 'lit', providerId: target.providerId });
    } catch (err) {
      results.push({
        modality,
        status: 'failed',
        providerId: target.providerId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

function removeModality(
  modality: TokenPlanModality,
  target: TokenPlanModalityTarget,
  actions: TokenPlanActions,
): void {
  switch (modality) {
    case 'llm': {
      // Applying overwrote the built-in provider in place. Restore its built-in
      // defaults so it doesn't linger on the plan endpoint with plan model ids
      // and isBuiltIn:false. The store's LLM resolver then switches the active
      // selection away since the restored config has no key. Custom (non-built-
      // in) providers aren't in the registry — just clear the key for those.
      const builtIn = PROVIDERS[target.providerId as ProviderId];
      if (builtIn) {
        actions.setProviderConfig(target.providerId as ProviderId, {
          apiKey: '',
          baseUrl: '',
          models: builtIn.models,
          name: builtIn.name,
          type: builtIn.type,
          defaultBaseUrl: builtIn.defaultBaseUrl,
          icon: builtIn.icon,
          requiresApiKey: builtIn.requiresApiKey,
          isBuiltIn: true,
          modelsUrl: undefined,
        });
      } else {
        actions.setProviderConfig(target.providerId as ProviderId, { apiKey: '' });
      }
      break;
    }
    case 'image':
      actions.setImageProviderConfig(target.providerId as ImageProviderId, {
        apiKey: '',
        baseUrl: '',
        enabled: false,
        customModels: [],
        replaceBuiltInModels: false,
      });
      break;
    case 'video':
      actions.setVideoProviderConfig(target.providerId as VideoProviderId, {
        apiKey: '',
        baseUrl: '',
        enabled: false,
        customModels: [],
        replaceBuiltInModels: false,
      });
      break;
    case 'tts':
      actions.setTTSProviderConfig(target.providerId as TTSProviderId, {
        apiKey: '',
        baseUrl: '',
        enabled: false,
      });
      break;
    case 'webSearch':
      actions.setWebSearchProviderConfig(target.providerId as WebSearchProviderId, {
        apiKey: '',
        baseUrl: '',
        enabled: false,
      });
      break;
  }
}
