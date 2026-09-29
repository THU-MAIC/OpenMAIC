/**
 * One-way import of the model settings earlier builds kept in the browser
 * (RFC #1701, tracked in #1725, P2).
 *
 * TEMPORARY, like the rest of this directory: see ./README.md.
 *
 * Earlier builds kept providers, API keys, base URLs, the chosen model and the
 * per-capability selections in the persisted settings store. The store's
 * migration to version 5 hands its old state to
 * {@link buildModelSettingsProposal} and saves the result under
 * {@link MODEL_SETTINGS_IMPORT_KEY} before it drops those fields; after that,
 * {@link runModelSettingsImport} posts the proposal to
 * `POST /api/model-config/import`, which merges it into the workspace item by
 * item and never replaces an existing setting. The key is removed once the
 * server has taken it, so keys do not stay in the browser.
 *
 * Deliberately not imported: per-stage routes (`llmStageRoutes`), which do not
 * map one to one onto slots; custom TTS/ASR providers and vendors that
 * authenticate with a key pair (AliDocMind), which a workspace provider cannot
 * express; thinking settings.
 */
import { ASR_PROVIDERS, TTS_PROVIDERS } from '@/lib/audio/constants';
import type { SlotCapability } from '@/lib/config/model-slots';
import { presetIdFor, tokenPlanPresetId } from '@/lib/config/preset-ids';
import { TOKEN_PLAN_PRESETS, type TokenPlanModality } from '@/lib/config/token-plan-presets';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';

/** The localStorage key of a proposal waiting to be imported. */
export const MODEL_SETTINGS_IMPORT_KEY = 'maic:legacy-import:model-settings';

/** The endpoint that merges a proposal into the workspace. */
export const MODEL_SETTINGS_IMPORT_ENDPOINT = '/api/model-config/import';

/** The prefix of every console line this import writes (shared with the course import). */
export const LOG_PREFIX = '[legacy-browser-import]';

export interface ProposedProvider {
  preset: string;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
}

/** The body of `POST /api/model-config/import`. */
export interface ModelSettingsProposal {
  providers?: Record<string, ProposedProvider>;
  /** `provider:model`, a provider alone, or null for a capability the user turned off. */
  slots?: Record<string, string | null>;
}

interface LegacyChatProvider {
  apiKey?: string;
  baseUrl?: string;
  defaultBaseUrl?: string;
  type?: string;
  isBuiltIn?: boolean;
  isServerConfigured?: boolean;
  enabled?: boolean;
  models?: Array<{ id?: string }>;
}

interface LegacyServiceProvider {
  apiKey?: string;
  baseUrl?: string;
  enabled?: boolean;
  isServerConfigured?: boolean;
  modelId?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
}

type ServiceMap = Record<string, LegacyServiceProvider | undefined>;

/** The part of the version 4 settings store this import reads. */
export interface LegacyModelSettingsState {
  providerId?: string;
  modelId?: string;
  providersConfig?: Record<string, LegacyChatProvider | undefined>;
  tokenPlanEnrollments?: Record<string, string>;
  ttsProviderId?: string;
  ttsEnabled?: boolean;
  ttsProvidersConfig?: ServiceMap;
  asrProviderId?: string;
  asrEnabled?: boolean;
  asrProvidersConfig?: ServiceMap;
  imageProviderId?: string;
  imageModelId?: string;
  imageGenerationEnabled?: boolean;
  imageProvidersConfig?: ServiceMap;
  videoProviderId?: string;
  videoModelId?: string;
  videoGenerationEnabled?: boolean;
  videoProvidersConfig?: ServiceMap;
  webSearchProviderId?: string;
  webSearchEnabled?: boolean;
  webSearchProvidersConfig?: ServiceMap;
  pdfProviderId?: string;
  pdfProvidersConfig?: ServiceMap;
}

type ServiceCapability = Exclude<SlotCapability, 'chat'>;

/** The built-in registries of the capabilities other than chat. */
const SERVICE_REGISTRIES: Record<
  ServiceCapability,
  Record<string, { defaultBaseUrl?: string; requiresApiKey?: boolean }>
> = {
  tts: TTS_PROVIDERS,
  asr: ASR_PROVIDERS,
  image: IMAGE_PROVIDERS,
  video: VIDEO_PROVIDERS,
  webSearch: WEB_SEARCH_PROVIDERS,
  document: PDF_PROVIDERS,
};

/** Services that run in the browser itself: selecting one is a choice, with nothing to key. */
const BROWSER_SERVICES: Partial<Record<ServiceCapability, string>> = {
  tts: 'browser-native-tts',
  asr: 'browser-native',
};

const TOKEN_PLAN_CAPABILITY: Record<TokenPlanModality, SlotCapability> = {
  llm: 'chat',
  image: 'image',
  video: 'video',
  tts: 'tts',
  webSearch: 'webSearch',
};

/** Capabilities a slot names without a model: the provider's own default. */
const PROVIDER_ONLY: ReadonlySet<ServiceCapability> = new Set(['webSearch', 'document']);

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sameUrl(a: string, b: string | undefined): boolean {
  return !!b && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/** A provider id the import schema accepts, derived from a legacy id. */
export function safeProviderId(raw: string): string {
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return PROVIDER_ID.test(id) ? id : 'provider';
}

/**
 * A settings state of any earlier version in the shape of version 4: the
 * steps the store's migration used to apply before the builder reads it
 * (the ladder the version 5 migration replaced). Returns a copy.
 */
export function normalizeLegacyModelSettings(
  persisted: Record<string, unknown>,
  version: number,
): LegacyModelSettingsState {
  const state: Record<string, unknown> = { ...persisted };
  const record = (value: unknown): Record<string, Record<string, unknown>> | undefined =>
    value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([id, config]) => [
            id,
            config && typeof config === 'object' ? { ...(config as Record<string, unknown>) } : {},
          ]),
        )
      : undefined;
  const tts = record(state.ttsProvidersConfig);
  const asr = record(state.asrProvidersConfig);
  if (tts) state.ttsProvidersConfig = tts;
  if (asr) state.asrProvidersConfig = asr;

  // v0: the hardcoded default model was never the user's choice.
  if (version === 0 && state.providerId === 'openai' && state.modelId === 'gpt-4o-mini') {
    state.modelId = '';
  }
  // The single TTS model setting became a provider selection.
  if (typeof state.ttsModel === 'string' && !state.ttsProviderId) {
    state.ttsProviderId = state.ttsModel === 'azure-tts' ? 'azure-tts' : 'openai-tts';
  }
  // Global TTS/ASR model ids became per-provider ones.
  for (const [field, map, selected] of [
    ['ttsModelId', tts, state.ttsProviderId],
    ['asrModelId', asr, state.asrProviderId],
  ] as const) {
    const modelId = state[field];
    if (typeof modelId === 'string' && modelId && typeof selected === 'string' && map?.[selected]) {
      map[selected].modelId ??= modelId;
    }
    delete state[field];
  }
  // A TTS provider's `model` became `modelId`.
  for (const config of Object.values(tts ?? {})) {
    if (typeof config.model === 'string' && !config.modelId) config.modelId = config.model;
    delete config.model;
  }
  // The flat web search key became Tavily's provider entry.
  if (!state.webSearchProvidersConfig) {
    const apiKey = typeof state.webSearchApiKey === 'string' ? state.webSearchApiKey : '';
    const isServerConfigured = state.webSearchIsServerConfigured === true;
    if (apiKey || isServerConfigured) {
      state.webSearchProviderId = 'tavily';
      state.webSearchProvidersConfig = {
        tavily: { apiKey, baseUrl: '', enabled: true, isServerConfigured },
      };
    }
  }
  delete state.webSearchApiKey;
  delete state.webSearchIsServerConfigured;
  return state as LegacyModelSettingsState;
}

/**
 * The proposal for a version 4 settings state: the providers it holds keys or
 * endpoints for, and the slots its selections name. Undefined when there is
 * nothing to import (no key, no custom endpoint, no model choice).
 */
export function buildModelSettingsProposal(
  state: LegacyModelSettingsState | null | undefined,
): ModelSettingsProposal | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const providers: Record<string, ProposedProvider> = {};
  const slots: Record<string, string | null> = {};

  const claim = (raw: string, provider: ProposedProvider): string => {
    const base = safeProviderId(raw);
    let id = base;
    for (let n = 2; Object.hasOwn(providers, id); n++) {
      id = `${base.slice(0, 60)}-${n}`;
    }
    providers[id] = provider;
    return id;
  };

  const chat = state.providersConfig ?? {};
  /** Legacy chat provider id → the id it is proposed under. */
  const chatIds = new Map<string, string>();
  /** `capability:registryId` of services a token plan's key covers → the plan's id. */
  const planServices = new Map<string, string>();

  // Token plans first: an enrolled plan's key is the key of its chat provider
  // and of the services the plan filled, which all become the one plan provider.
  for (const plan of TOKEN_PLAN_PRESETS) {
    const llm = plan.modalities.llm;
    if (!llm || state.tokenPlanEnrollments?.[plan.id] !== llm.providerId) continue;
    const key = text(chat[llm.providerId]?.apiKey);
    if (!key) continue;
    const id = claim(tokenPlanPresetId(plan.id), {
      preset: tokenPlanPresetId(plan.id),
      apiKey: key,
    });
    chatIds.set(llm.providerId, id);
    for (const [modality, target] of Object.entries(plan.modalities)) {
      if (modality === 'llm' || !target) continue;
      const capability = TOKEN_PLAN_CAPABILITY[modality as TokenPlanModality] as ServiceCapability;
      const service = serviceMap(state, capability)?.[target.providerId];
      if (text(service?.apiKey) === key) planServices.set(`${capability}:${target.providerId}`, id);
    }
  }

  for (const [legacyId, config] of Object.entries(chat)) {
    if (!config || chatIds.has(legacyId) || config.isServerConfigured) continue;
    const apiKey = text(config.apiKey);
    const baseUrl =
      text(config.baseUrl) || (config.isBuiltIn === false ? text(config.defaultBaseUrl) : '');
    const custom = config.isBuiltIn === false || legacyId.startsWith('custom-');
    const models = (config.models ?? [])
      .map((model) => text(model?.id))
      .filter((modelId) => modelId.length > 0);
    if (custom) {
      // A custom provider is its endpoint: without one there is nothing to call.
      if (!baseUrl) continue;
      const preset =
        config.type === 'openai' || !config.type
          ? 'openai-compatible'
          : config.type === 'anthropic' || config.type === 'google'
            ? config.type
            : undefined;
      if (!preset) continue;
      chatIds.set(
        legacyId,
        claim(legacyId, {
          preset,
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          ...(models.length ? { models: [...new Set(models)] } : {}),
        }),
      );
      continue;
    }
    const customEndpoint = baseUrl && !sameUrl(baseUrl, text(config.defaultBaseUrl) || undefined);
    if (!apiKey && !customEndpoint) continue;
    const preset = presetIdFor('chat', legacyId);
    chatIds.set(
      legacyId,
      claim(preset, {
        preset,
        ...(apiKey ? { apiKey } : {}),
        ...(customEndpoint ? { baseUrl } : {}),
      }),
    );
  }

  // The chosen model: a provider proposed here, or one the server configured,
  // which the server names by its preset id.
  const providerId = text(state.providerId);
  const modelId = text(state.modelId);
  const selected = providerId ? chat[providerId] : undefined;
  if (providerId && modelId && selected && selected.enabled !== false) {
    const id =
      chatIds.get(providerId) ??
      (selected.isServerConfigured ? presetIdFor('chat', providerId) : undefined);
    if (id) slots.llm = `${id}:${modelId}`;
  }

  // Only speech input carries an explicit off over: with its slot unassigned
  // the browser's own recognition would take over, which the user turned off.
  // The other switches were per-browser toggles that availability following
  // the slots replaces on purpose; a lasting workspace `null` made of them
  // would override the deployment's defaults from then on.

  const services: Array<{
    capability: ServiceCapability;
    selected?: string;
    on: boolean;
    /** The user turned the capability off: the slot is proposed as off (null). Speech input only. */
    explicitlyOff: boolean;
    model?: string;
  }> = [
    {
      capability: 'tts',
      selected: state.ttsProviderId,
      on: state.ttsEnabled === true,
      explicitlyOff: false,
      model: state.ttsProvidersConfig?.[text(state.ttsProviderId)]?.modelId,
    },
    {
      capability: 'asr',
      selected: state.asrProviderId,
      on: state.asrEnabled !== false,
      // Speech input defaulted to on: off was always the user's choice.
      explicitlyOff: state.asrEnabled === false,
      model: state.asrProvidersConfig?.[text(state.asrProviderId)]?.modelId,
    },
    {
      capability: 'image',
      selected: state.imageProviderId,
      on: state.imageGenerationEnabled === true,
      explicitlyOff: false,
      model: state.imageModelId,
    },
    {
      capability: 'video',
      selected: state.videoProviderId,
      on: state.videoGenerationEnabled === true,
      explicitlyOff: false,
      model: state.videoModelId,
    },
    {
      capability: 'webSearch',
      selected: state.webSearchProviderId,
      on: state.webSearchEnabled === true,
      explicitlyOff: false,
    },
    // Document extraction had no switch: the selected extractor was used.
    { capability: 'document', selected: state.pdfProviderId, on: true, explicitlyOff: false },
  ];

  for (const { capability, selected: selectedId, on, explicitlyOff, model } of services) {
    const registry = SERVICE_REGISTRIES[capability];
    /** Registry id → proposed id, for this capability. */
    const ids = new Map<string, string>();
    /** Registry id → the id of the server's provider, for this capability. */
    const serverIds = new Map<string, string>();
    for (const [registryId, config] of Object.entries(serviceMap(state, capability) ?? {})) {
      const plan = planServices.get(`${capability}:${registryId}`);
      if (plan) {
        ids.set(registryId, plan);
        continue;
      }
      // Custom TTS/ASR providers and unknown ids have no preset.
      if (!config || !Object.hasOwn(registry, registryId)) continue;
      // A server-configured provider is the server's: named by its preset id
      // (as the server names translated legacy providers), never imported.
      if (config.isServerConfigured) {
        serverIds.set(registryId, presetIdFor(capability, registryId));
        continue;
      }
      const apiKey = text(config.apiKey);
      const baseUrl = text(config.baseUrl);
      const customEndpoint = baseUrl && !sameUrl(baseUrl, registry[registryId]?.defaultBaseUrl);
      // A key pair (AliDocMind) cannot be expressed as one key.
      if (!apiKey && !customEndpoint) continue;
      const preset = presetIdFor(capability, registryId);
      ids.set(
        registryId,
        claim(preset, {
          preset,
          ...(apiKey ? { apiKey } : {}),
          ...(customEndpoint ? { baseUrl } : {}),
        }),
      );
    }

    if (explicitlyOff) {
      slots[capability] = null;
      continue;
    }
    const chosen = text(selectedId);
    if (!on || !chosen) continue;
    let id = ids.get(chosen) ?? serverIds.get(chosen);
    if (!id && BROWSER_SERVICES[capability] === chosen) {
      const preset = presetIdFor(capability, chosen);
      id = claim(preset, { preset });
    }
    if (!id) continue;
    const modelChoice = PROVIDER_ONLY.has(capability) ? '' : text(model);
    slots[capability] = modelChoice ? `${id}:${modelChoice}` : id;
  }

  const hasProviders = Object.keys(providers).length > 0;
  const hasSlots = Object.keys(slots).length > 0;
  if (!hasProviders && !hasSlots) return undefined;
  return {
    ...(hasProviders ? { providers } : {}),
    ...(hasSlots ? { slots } : {}),
  };
}

function serviceMap(
  state: LegacyModelSettingsState,
  capability: ServiceCapability,
): ServiceMap | undefined {
  switch (capability) {
    case 'tts':
      return state.ttsProvidersConfig;
    case 'asr':
      return state.asrProvidersConfig;
    case 'image':
      return state.imageProvidersConfig;
    case 'video':
      return state.videoProvidersConfig;
    case 'webSearch':
      return state.webSearchProvidersConfig;
    case 'document':
      return state.pdfProvidersConfig;
  }
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A fixed description of a failure: never its message, which may quote the stored text. */
export function errorCategory(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : 'unknown error';
}

/**
 * Keep a proposal for the import (`./model-settings-import.ts`). A proposal
 * already waiting is merged under the new one, so a second migration (another
 * tab) does not lose the first. Answers whether the proposal is durably kept
 * (true when there is nothing to keep): callers must not drop the settings it
 * came from otherwise. An unreadable proposal already waiting is not
 * overwritten (the import drops it, and a later attempt then succeeds).
 */
export function saveModelSettingsProposal(
  proposal: ModelSettingsProposal | undefined,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!proposal) return true;
  if (!storage) return false;
  try {
    const waiting = readProposal(storage);
    const providers = { ...waiting?.providers, ...proposal.providers };
    const slots = { ...waiting?.slots, ...proposal.slots };
    const merged: ModelSettingsProposal = {
      ...(Object.keys(providers).length ? { providers } : {}),
      ...(Object.keys(slots).length ? { slots } : {}),
    };
    storage.setItem(MODEL_SETTINGS_IMPORT_KEY, JSON.stringify(merged));
    return true;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Could not keep the model settings for import (${errorCategory(error)}); they stay in the settings store`,
    );
    return false;
  }
}

/** The waiting proposal. Throws on unreadable text: callers log only its category. */
export function readProposal(storage: StorageLike): ModelSettingsProposal | undefined {
  const raw = storage.getItem(MODEL_SETTINGS_IMPORT_KEY);
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as ModelSettingsProposal) : undefined;
}
