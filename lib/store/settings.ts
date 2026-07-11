/**
 * Settings Store
 * Global settings state synchronized with localStorage
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProviderId } from '@/lib/ai/providers';
import type { ProvidersConfig } from '@/lib/types/settings';
import { PROVIDERS } from '@/lib/ai/providers';
import type { ThinkingConfig } from '@/lib/types/provider';
import { getThinkingConfigKey, supportsConfigurableThinking } from '@/lib/ai/thinking-config';
import type { TTSProviderId, ASRProviderId, BuiltInTTSProviderId } from '@/lib/audio/types';
import type { AgentVoiceOverride } from '@/lib/audio/voice-resolver';
import { isCustomTTSProvider, isCustomASRProvider } from '@/lib/audio/types';
import { ASR_PROVIDERS, DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import { DEFAULT_VOXCPM_BACKEND, VOXCPM_MODEL_ID, VOXCPM_VLLM_MODEL_ID } from '@/lib/audio/voxcpm';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import { createLogger } from '@/lib/logger';
import {
  validateProvider,
  resolveSelectedModel,
  isLLMProviderConfigured,
} from '@/lib/store/settings-validation';

const log = createLogger('Settings');

function pruneThinkingConfigs(
  thinkingConfigs: Record<string, ThinkingConfig> | undefined,
  providersConfig: ProvidersConfig | undefined,
): Record<string, ThinkingConfig> {
  if (!thinkingConfigs || !providersConfig) return {};

  const validKeys = new Set<string>();
  for (const [providerId, providerConfig] of Object.entries(providersConfig)) {
    for (const model of providerConfig.models) {
      if (supportsConfigurableThinking(model.capabilities?.thinking)) {
        validKeys.add(getThinkingConfigKey(providerId, model.id));
      }
    }
  }

  return Object.fromEntries(
    Object.entries(thinkingConfigs).filter(([key]) => validKeys.has(key)),
  ) as Record<string, ThinkingConfig>;
}

/** Available playback speed tiers */
export const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export interface SettingsState {
  // Model selection
  providerId: ProviderId;
  modelId: string;
  thinkingConfigs: Record<string, ThinkingConfig>;

  // Provider configurations (unified JSON storage)
  providersConfig: ProvidersConfig;

  // TTS settings (legacy, kept for backward compatibility)
  ttsModel: string;

  // Audio settings (new unified audio configuration)
  ttsProviderId: TTSProviderId;
  ttsVoice: string;
  ttsSpeed: number;
  asrProviderId: ASRProviderId;
  asrLanguage: string;

  // Audio provider configurations
  ttsProvidersConfig: Record<
    TTSProviderId,
    {
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      modelId?: string;
      customModels?: Array<{ id: string; name: string }>;
      providerOptions?: Record<string, unknown>;
      isServerConfigured?: boolean;
      /** Admin/server-level force-off (server-providers.yml / env). Overrides `enabled`. */
      serverDisabled?: boolean;
      // Custom provider fields
      customName?: string;
      customDefaultBaseUrl?: string;
      customVoices?: Array<{ id: string; name: string }>;
      isBuiltIn?: boolean;
      requiresApiKey?: boolean;
    }
  >;

  asrProvidersConfig: Record<
    ASRProviderId,
    {
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      modelId?: string;
      customModels?: Array<{ id: string; name: string }>;
      providerOptions?: Record<string, unknown>;
      isServerConfigured?: boolean;
      // Custom provider fields
      customName?: string;
      customDefaultBaseUrl?: string;
      isBuiltIn?: boolean;
      requiresApiKey?: boolean;
    }
  >;

  // PDF settings
  pdfProviderId: PDFProviderId;
  pdfProvidersConfig: Record<
    PDFProviderId,
    {
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      requiresApiKey?: boolean;
      isServerConfigured?: boolean;
    }
  >;
  baiduSubSources: BaiduSubSources;

  // Image Generation settings
  imageProviderId: ImageProviderId;
  imageModelId: string;
  imageProvidersConfig: Record<
    ImageProviderId,
    {
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      isServerConfigured?: boolean;
      customModels?: Array<{ id: string; name: string }>;
      replaceBuiltInModels?: boolean;
    }
  >;

  // Video Generation settings
  videoProviderId: VideoProviderId;
  videoModelId: string;
  videoProvidersConfig: Record<
    VideoProviderId,
    {
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      isServerConfigured?: boolean;
      customModels?: Array<{ id: string; name: string }>;
      replaceBuiltInModels?: boolean;
    }
  >;

  // Media generation toggles
  imageGenerationEnabled: boolean;
  videoGenerationEnabled: boolean;
  reviewOutlineEnabled: boolean;

  // Web Search settings
  webSearchProviderId: WebSearchProviderId;
  webSearchProvidersConfig: Record<
    WebSearchProviderId,
    {
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      requiresApiKey?: boolean;
      isServerConfigured?: boolean;
    }
  >;

  // Global TTS/ASR toggles
  ttsEnabled: boolean;
  asrEnabled: boolean;

  // Server-configured opt-in parallel scene-content concurrency (#572).
  // 0 = off (serial generation); populated by fetchServerProviders.
  parallelSceneConcurrency: number;

  // Auto-config lifecycle flag (persisted)
  autoConfigApplied: boolean;

  // Playback controls
  ttsMuted: boolean;
  ttsVolume: number; // 0-1, actual volume level
  autoPlayLecture: boolean;
  playbackSpeed: PlaybackSpeed;

  // Agent settings
  selectedAgentIds: string[];
  agentMode: 'preset' | 'auto';
  autoAgentCount: number;
  /**
   * Per-agent voice picks made in the AgentBar, keyed by agent id. Lives here
   * (persisted) rather than on registry AgentConfig records because default
   * agents are reset from code and generated agents are rebuilt from IndexedDB
   * on every load. Highest-priority input to resolveAgentVoice.
   */
  agentVoiceOverrides: Record<string, AgentVoiceOverride>;
  /**
   * Whether agentMode/selectedAgentIds were explicitly set by the user (in the
   * AgentBar), as opposed to stage-derived defaults written by a classroom
   * load. Only a user-set selection carries across classrooms on restore.
   */
  agentSelectionIsUserSet: boolean;

  // Layout preferences (persisted via localStorage)
  sidebarCollapsed: boolean;
  chatAreaCollapsed: boolean;
  chatAreaWidth: number;
  editRailCollapsed: boolean;
  editRailWidth: number;
  editInsertToolbarCollapsed: boolean;

  // Actions
  setModel: (providerId: ProviderId, modelId: string) => void;
  setThinkingConfig: (
    providerId: ProviderId,
    modelId: string,
    config: ThinkingConfig | undefined,
  ) => void;
  setProviderConfig: (providerId: ProviderId, config: Partial<ProvidersConfig[ProviderId]>) => void;
  setProvidersConfig: (config: ProvidersConfig) => void;
  setTtsModel: (model: string) => void;
  setTTSMuted: (muted: boolean) => void;
  setTTSVolume: (volume: number) => void;
  setAutoPlayLecture: (autoPlay: boolean) => void;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  setSelectedAgentIds: (ids: string[]) => void;
  setAgentMode: (mode: 'preset' | 'auto') => void;
  setAutoAgentCount: (count: number) => void;
  /** Set (or clear, with `undefined`) the persisted voice pick for one agent. */
  setAgentVoiceOverride: (agentId: string, voice: AgentVoiceOverride | undefined) => void;
  setAgentSelectionIsUserSet: (isUserSet: boolean) => void;

  // Layout actions
  setSidebarCollapsed: (collapsed: boolean) => void;
  setChatAreaCollapsed: (collapsed: boolean) => void;
  setChatAreaWidth: (width: number) => void;
  setEditRailCollapsed: (collapsed: boolean) => void;
  setEditInsertToolbarCollapsed: (collapsed: boolean) => void;
  setEditRailWidth: (width: number) => void;

  // Audio actions
  setTTSProvider: (providerId: TTSProviderId) => void;
  setTTSVoice: (voice: string) => void;
  setTTSSpeed: (speed: number) => void;
  setASRProvider: (providerId: ASRProviderId) => void;
  setASRLanguage: (language: string) => void;
  setTTSProviderConfig: (
    providerId: TTSProviderId,
    config: Partial<{
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      modelId: string;
      customModels: Array<{ id: string; name: string }>;
      customVoices: Array<{ id: string; name: string }>;
      providerOptions: Record<string, unknown>;
    }>,
  ) => void;
  setASRProviderConfig: (
    providerId: ASRProviderId,
    config: Partial<{
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      modelId: string;
      customModels: Array<{ id: string; name: string }>;
      providerOptions: Record<string, unknown>;
    }>,
  ) => void;
  setTTSEnabled: (enabled: boolean) => void;
  setASREnabled: (enabled: boolean) => void;

  // Custom audio provider actions
  addCustomTTSProvider: (
    id: TTSProviderId,
    name: string,
    baseUrl: string,
    requiresApiKey: boolean,
    defaultModel?: string,
  ) => void;
  removeCustomTTSProvider: (id: TTSProviderId) => void;
  addCustomASRProvider: (
    id: ASRProviderId,
    name: string,
    baseUrl: string,
    requiresApiKey: boolean,
  ) => void;
  removeCustomASRProvider: (id: ASRProviderId) => void;

  // PDF actions
  setPDFProvider: (providerId: PDFProviderId) => void;
  setPDFProviderConfig: (
    providerId: PDFProviderId,
    config: Partial<{ apiKey: string; baseUrl: string; enabled: boolean }>,
  ) => void;

  // Image Generation actions
  setImageProvider: (providerId: ImageProviderId) => void;
  setImageModelId: (modelId: string) => void;
  setImageProviderConfig: (
    providerId: ImageProviderId,
    config: Partial<{
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      customModels: Array<{ id: string; name: string }>;
      replaceBuiltInModels: boolean;
    }>,
  ) => void;

  // Video Generation actions
  setVideoProvider: (providerId: VideoProviderId) => void;
  setVideoModelId: (modelId: string) => void;
  setVideoProviderConfig: (
    providerId: VideoProviderId,
    config: Partial<{
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
      customModels: Array<{ id: string; name: string }>;
      replaceBuiltInModels: boolean;
    }>,
  ) => void;

  // Media generation toggle actions
  setImageGenerationEnabled: (enabled: boolean) => void;
  setVideoGenerationEnabled: (enabled: boolean) => void;
  setReviewOutlineEnabled: (enabled: boolean) => void;

  // Web Search actions
  setWebSearchProvider: (providerId: WebSearchProviderId) => void;
  setWebSearchProviderConfig: (
    providerId: WebSearchProviderId,
    config: Partial<{ apiKey: string; baseUrl: string; enabled: boolean }>,
  ) => void;
  setBaiduSubSources: (sources: Partial<BaiduSubSources>) => void;

  // Server provider actions
  fetchServerProviders: () => Promise<void>;
}

// Initialize default providers config
const getDefaultProvidersConfig = (): ProvidersConfig => {
  const config: ProvidersConfig = {} as ProvidersConfig;
  Object.keys(PROVIDERS).forEach((pid) => {
    const provider = PROVIDERS[pid as ProviderId];
    config[pid as ProviderId] = {
      apiKey: '',
      baseUrl: '',
      models: provider.models,
      name: provider.name,
      type: provider.type,
      defaultBaseUrl: provider.defaultBaseUrl,
      icon: provider.icon,
      requiresApiKey: provider.requiresApiKey,
      isBuiltIn: true,
    };
  });
  return config;
};

/**
 * Single shared LLM selection resolver (#580). Given a providers config and
 * the current (providerId, modelId), return the resolved selection that
 * upholds the invariant for ANY config mutation — clearing/adding a key,
 * editing models, deleting a provider, import, reset:
 *
 * - keep the current provider if it is still usable;
 * - else fall back to the first usable provider;
 * - else State A (empty selection).
 *
 * Then resolve a concrete model for the chosen provider. Used by both
 * setProviderConfig (single edit) and setProvidersConfig (bulk) so the two
 * paths can never diverge — the per-call-site asymmetry #580 set out to kill.
 */
function resolveLLMSelection(
  config: ProvidersConfig,
  currentProviderId: ProviderId,
  currentModelId: string,
): { providerId: ProviderId; modelId: string } {
  const isUsable = (id: ProviderId) => !!config[id] && isLLMProviderConfigured(config[id]);
  const providerId = isUsable(currentProviderId)
    ? currentProviderId
    : ((Object.keys(config) as ProviderId[]).find(isUsable) ?? ('' as ProviderId));
  const modelId = providerId
    ? resolveSelectedModel(currentModelId, config[providerId]?.models ?? [])
    : '';
  return { providerId, modelId };
}

function resolveMediaModels<T extends { id: string; name: string }>(
  builtInModels: T[],
  config?: { customModels?: T[]; replaceBuiltInModels?: boolean },
): T[] {
  const customModels = config?.customModels ?? [];
  return config?.replaceBuiltInModels && customModels.length > 0
    ? customModels
    : [...builtInModels, ...customModels];
}

function isUsableMediaProvider(
  provider: { requiresApiKey: boolean } | undefined,
  config: { apiKey?: string; enabled?: boolean; isServerConfigured?: boolean } | undefined,
): boolean {
  if (!provider || config?.enabled === false) return false;
  return !provider.requiresApiKey || !!config?.apiKey || !!config?.isServerConfigured;
}

// Initialize default audio config
const getDefaultAudioConfig = () => ({
  ttsProviderId: 'browser-native-tts' as TTSProviderId,
  ttsVoice: 'default',
  ttsSpeed: 1.0,
  asrProviderId: 'browser-native' as ASRProviderId,
  asrLanguage: 'zh',
  ttsProvidersConfig: {
    // Built-in providers default enabled:true — they only ever surface once
    // configured (API key or server-managed), so "enabled" is a user opt-OUT,
    // not the visibility gate. A server-configured provider must not be hidden
    // by a stale default (#665).
    'openai-tts': { apiKey: '', baseUrl: '', enabled: true },
    'azure-tts': { apiKey: '', baseUrl: '', enabled: true },
    'glm-tts': { apiKey: '', baseUrl: '', enabled: true },
    'qwen-tts': { apiKey: '', baseUrl: '', enabled: true },
    'voxcpm-tts': {
      apiKey: '',
      baseUrl: '',
      modelId: VOXCPM_VLLM_MODEL_ID,
      enabled: true,
      providerOptions: { backend: DEFAULT_VOXCPM_BACKEND },
    },
    'doubao-tts': { apiKey: '', baseUrl: '', enabled: true },
    'elevenlabs-tts': { apiKey: '', baseUrl: '', enabled: true },
    'minimax-tts': { apiKey: '', baseUrl: '', modelId: 'speech-2.8-hd', enabled: true },
    'lemonade-tts': {
      apiKey: '',
      baseUrl: '',
      modelId: 'kokoro-v1',
      enabled: true,
    },
    // Browser-native is OFF by default — fully opt-in. Native voice quality is
    // poor; it must never be a silent default (#665).
    'browser-native-tts': { apiKey: '', baseUrl: '', enabled: false },
  } as Record<
    TTSProviderId,
    { apiKey: string; baseUrl: string; modelId?: string; enabled: boolean }
  >,
  asrProvidersConfig: {
    'openai-whisper': { apiKey: '', baseUrl: '', enabled: true },
    'browser-native': { apiKey: '', baseUrl: '', enabled: true },
    'qwen-asr': { apiKey: '', baseUrl: '', enabled: false },
    'azure-asr': { apiKey: '', baseUrl: '', enabled: false },
    'lemonade-asr': { apiKey: '', baseUrl: '', enabled: false },
  } as Record<ASRProviderId, { apiKey: string; baseUrl: string; enabled: boolean }>,
});

// Initialize default PDF config
const getDefaultPDFConfig = () => ({
  pdfProviderId: 'unpdf' as PDFProviderId,
  pdfProvidersConfig: {
    unpdf: { apiKey: '', baseUrl: '', enabled: true },
    mineru: { apiKey: '', baseUrl: '', enabled: false },
    'mineru-cloud': { apiKey: '', baseUrl: '', enabled: false },
  } as Record<PDFProviderId, { apiKey: string; baseUrl: string; enabled: boolean }>,
});

// Initialize default Image config
const getDefaultImageConfig = () => ({
  imageProviderId: 'seedream' as ImageProviderId,
  imageModelId: 'doubao-seedream-5-0-260128',
  imageProvidersConfig: {
    seedream: { apiKey: '', baseUrl: '', enabled: false },
    'openai-image': { apiKey: '', baseUrl: '', enabled: false },
    'qwen-image': { apiKey: '', baseUrl: '', enabled: false },
    'nano-banana': { apiKey: '', baseUrl: '', enabled: false },
    'minimax-image': { apiKey: '', baseUrl: '', enabled: false },
    'grok-image': { apiKey: '', baseUrl: '', enabled: false },
    'comfyui-image': { apiKey: '', baseUrl: '', enabled: false },
    lemonade: { apiKey: '', baseUrl: '', enabled: false },
  } as Record<ImageProviderId, { apiKey: string; baseUrl: string; enabled: boolean }>,
});

// Initialize default Video config
const getDefaultVideoConfig = () => ({
  videoProviderId: 'seedance' as VideoProviderId,
  videoModelId: 'doubao-seedance-2-0-260128',
  videoProvidersConfig: {
    seedance: { apiKey: '', baseUrl: '', enabled: false },
    kling: { apiKey: '', baseUrl: '', enabled: false },
    veo: { apiKey: '', baseUrl: '', enabled: false },
    sora: { apiKey: '', baseUrl: '', enabled: false },
    'minimax-video': { apiKey: '', baseUrl: '', enabled: false },
    'grok-video': { apiKey: '', baseUrl: '', enabled: false },
    happyhorse: { apiKey: '', baseUrl: '', enabled: false },
  } as Record<VideoProviderId, { apiKey: string; baseUrl: string; enabled: boolean }>,
});

// Initialize default Web Search config
const getDefaultWebSearchConfig = () => ({
  webSearchProviderId: 'tavily' as WebSearchProviderId,
  webSearchProvidersConfig: {
    tavily: { apiKey: '', baseUrl: '', enabled: true, requiresApiKey: true },
    bocha: { apiKey: '', baseUrl: '', enabled: true, requiresApiKey: true },
    brave: {
      apiKey: '',
      baseUrl: WEB_SEARCH_PROVIDERS.brave.defaultBaseUrl || '',
      enabled: true,
      requiresApiKey: false,
    },
    baidu: { apiKey: '', baseUrl: '', enabled: true, requiresApiKey: true },
    minimax: {
      apiKey: '',
      baseUrl: WEB_SEARCH_PROVIDERS.minimax.defaultBaseUrl || '',
      enabled: true,
      requiresApiKey: true,
    },
    doubao: {
      apiKey: '',
      baseUrl: WEB_SEARCH_PROVIDERS.doubao.defaultBaseUrl || '',
      enabled: true,
      requiresApiKey: true,
    },
  } as Record<
    WebSearchProviderId,
    { apiKey: string; baseUrl: string; enabled: boolean; requiresApiKey?: boolean }
  >,
  baiduSubSources: {
    webSearch: true,
    baike: true,
    scholar: true,
  } as BaiduSubSources,
});

/**
 * Check whether a provider ID exists in the given provider registry.
 */
function hasProviderId(providerMap: Record<string, unknown>, providerId?: string): boolean {
  return typeof providerId === 'string' && providerId in providerMap;
}

/**
 * Validate all persisted provider IDs against their registries.
 * Reset any stale / removed ID back to its default value.
 * Called during both migrate and merge to cover all rehydration paths.
 */
function ensureValidProviderSelections(state: Partial<SettingsState>): void {
  const defaultAudioConfig = getDefaultAudioConfig();
  const defaultPdfConfig = getDefaultPDFConfig();
  const defaultImageConfig = getDefaultImageConfig();
  const defaultVideoConfig = getDefaultVideoConfig();
  const defaultWebSearchConfig = getDefaultWebSearchConfig();

  if (!hasProviderId(PDF_PROVIDERS, state.pdfProviderId)) {
    state.pdfProviderId = defaultPdfConfig.pdfProviderId;
  }

  if (!hasProviderId(WEB_SEARCH_PROVIDERS, state.webSearchProviderId)) {
    state.webSearchProviderId = defaultWebSearchConfig.webSearchProviderId;
  }
  ensureBaiduSubSources(state);

  if (!hasProviderId(IMAGE_PROVIDERS, state.imageProviderId)) {
    state.imageProviderId = defaultImageConfig.imageProviderId;
  }

  if (!hasProviderId(VIDEO_PROVIDERS, state.videoProviderId)) {
    state.videoProviderId = defaultVideoConfig.videoProviderId;
  }

  if (
    !hasProviderId(TTS_PROVIDERS, state.ttsProviderId) &&
    !(
      state.ttsProviderId &&
      isCustomTTSProvider(state.ttsProviderId) &&
      state.ttsProvidersConfig &&
      state.ttsProviderId in state.ttsProvidersConfig
    )
  ) {
    state.ttsProviderId = defaultAudioConfig.ttsProviderId;
  }

  if (
    !hasProviderId(ASR_PROVIDERS, state.asrProviderId) &&
    !(
      state.asrProviderId &&
      isCustomASRProvider(state.asrProviderId) &&
      state.asrProvidersConfig &&
      state.asrProviderId in state.asrProvidersConfig
    )
  ) {
    state.asrProviderId = defaultAudioConfig.asrProviderId;
  }
}

function ensureBuiltInAudioProviders(state: Partial<SettingsState>): void {
  const defaultAudioConfig = getDefaultAudioConfig();

  if (state.ttsProvidersConfig) {
    for (const providerId of Object.keys(TTS_PROVIDERS) as BuiltInTTSProviderId[]) {
      if (!state.ttsProvidersConfig[providerId]) {
        state.ttsProvidersConfig[providerId] = defaultAudioConfig.ttsProvidersConfig[providerId];
      }
    }
    const voxcpmConfig = state.ttsProvidersConfig['voxcpm-tts'];
    if (voxcpmConfig) {
      if (!voxcpmConfig.modelId || voxcpmConfig.modelId === VOXCPM_MODEL_ID) {
        voxcpmConfig.modelId = VOXCPM_VLLM_MODEL_ID;
      }
      voxcpmConfig.providerOptions = {
        backend: DEFAULT_VOXCPM_BACKEND,
        ...(voxcpmConfig.providerOptions || {}),
      };
    }
  }

  if (state.asrProvidersConfig) {
    for (const providerId of Object.keys(ASR_PROVIDERS) as ASRProviderId[]) {
      if (!state.asrProvidersConfig[providerId]) {
        state.asrProvidersConfig[providerId] = defaultAudioConfig.asrProvidersConfig[providerId];
      }
    }
  }
}

/**
 * Ensure providersConfig includes all built-in providers and their latest models.
 * Called on every rehydrate (not just version migrations) so new providers
 * added in code are always picked up without clearing cache.
 */
function ensureBuiltInProviders(state: Partial<SettingsState>): void {
  if (!state.providersConfig) return;
  const defaultConfig = getDefaultProvidersConfig();
  Object.keys(PROVIDERS).forEach((pid) => {
    const providerId = pid as ProviderId;
    if (!state.providersConfig![providerId]) {
      // New provider: add with defaults
      state.providersConfig![providerId] = defaultConfig[providerId];
    } else {
      // Existing provider: refresh built-in models from the registry and
      // keep user-added models after the built-in list.
      const provider = PROVIDERS[providerId];
      const existing = state.providersConfig![providerId];

      const builtInModelIds = new Set(provider.models.map((m) => m.id));
      const customModels = (existing.models || []).filter((m) => !builtInModelIds.has(m.id));
      const mergedModels = [...provider.models, ...customModels];

      state.providersConfig![providerId] = {
        ...existing,
        models: mergedModels,
        name: existing.name || provider.name,
        type: existing.type || provider.type,
        defaultBaseUrl: existing.defaultBaseUrl || provider.defaultBaseUrl,
        icon: provider.icon || existing.icon,
        requiresApiKey: existing.requiresApiKey ?? provider.requiresApiKey,
        isBuiltIn: existing.isBuiltIn ?? true,
      };
    }
  });
}

/**
 * Custom providers created before #414 stored their actual endpoint in
 * defaultBaseUrl while leaving baseUrl empty. Promote that persisted value
 * during rehydrate so downstream request builders keep using baseUrl only.
 */
export function promoteLegacyCustomProviderBaseUrls(state: Partial<SettingsState>): void {
  if (!state.providersConfig) return;

  Object.values(state.providersConfig).forEach((config) => {
    if (!config.isBuiltIn && !config.baseUrl && config.defaultBaseUrl) {
      config.baseUrl = config.defaultBaseUrl;
    }
  });
}

/**
 * Ensure imageProvidersConfig includes all built-in image providers.
 * Called on every rehydrate so newly added image providers appear automatically.
 */
function ensureBuiltInImageProviders(state: Partial<SettingsState>): void {
  if (!state.imageProvidersConfig) return;
  const defaultConfig = getDefaultImageConfig().imageProvidersConfig;
  Object.keys(IMAGE_PROVIDERS).forEach((pid) => {
    const providerId = pid as ImageProviderId;
    if (!state.imageProvidersConfig![providerId]) {
      state.imageProvidersConfig![providerId] = defaultConfig[providerId];
    }
  });
}

/**
 * Ensure videoProvidersConfig includes all built-in video providers.
 * Called on every rehydrate so newly added video providers appear automatically.
 */
function ensureBuiltInVideoProviders(state: Partial<SettingsState>): void {
  if (!state.videoProvidersConfig) return;
  const defaultConfig = getDefaultVideoConfig().videoProvidersConfig;
  Object.keys(VIDEO_PROVIDERS).forEach((pid) => {
    const providerId = pid as VideoProviderId;
    if (!state.videoProvidersConfig![providerId]) {
      state.videoProvidersConfig![providerId] = defaultConfig[providerId];
    }
  });
}

/**
 * Ensure webSearchProvidersConfig includes all built-in web search providers.
 * Called on every rehydrate so newly added providers appear automatically.
 */
function ensureBuiltInWebSearchProviders(state: Partial<SettingsState>): void {
  if (!state.webSearchProvidersConfig) return;
  const defaultConfig = getDefaultWebSearchConfig().webSearchProvidersConfig;
  Object.keys(WEB_SEARCH_PROVIDERS).forEach((pid) => {
    const providerId = pid as WebSearchProviderId;
    if (!state.webSearchProvidersConfig![providerId]) {
      state.webSearchProvidersConfig![providerId] = defaultConfig[providerId];
    } else {
      state.webSearchProvidersConfig![providerId] = {
        ...state.webSearchProvidersConfig![providerId],
        requiresApiKey: WEB_SEARCH_PROVIDERS[providerId].requiresApiKey,
      };
    }
  });
}

function ensureBaiduSubSources(state: Partial<SettingsState>): void {
  const defaults = getDefaultWebSearchConfig().baiduSubSources;
  const current = state.baiduSubSources;
  state.baiduSubSources = {
    webSearch: current?.webSearch ?? defaults.webSearch,
    baike: current?.baike ?? defaults.baike,
    scholar: current?.scholar ?? defaults.scholar,
  };
}

/**
 * Strip the removed `serverBaseUrl` field from any persisted provider config.
 *
 * Managed providers no longer expose their base URL to the client (#620). Old
 * localStorage may still carry a `serverBaseUrl` on provider entries; this
 * clears it on every rehydrate so a stale server URL can't linger in client
 * state. Called from both migrate and merge to cover all rehydration paths.
 */
function stripLegacyServerBaseUrl(state: Partial<SettingsState>): void {
  const maps = [
    state.providersConfig,
    state.ttsProvidersConfig,
    state.asrProvidersConfig,
    state.pdfProvidersConfig,
    state.imageProvidersConfig,
    state.videoProvidersConfig,
    state.webSearchProvidersConfig,
  ];
  for (const map of maps) {
    if (!map) continue;
    for (const cfg of Object.values(map as Record<string, Record<string, unknown>>)) {
      if (cfg && 'serverBaseUrl' in cfg) delete cfg.serverBaseUrl;
    }
  }
}

// Migrate from old localStorage format
const migrateFromOldStorage = () => {
  if (typeof window === 'undefined') return null;

  // Check if new storage already exists
  const newStorage = localStorage.getItem('settings-storage');
  if (newStorage) return null; // Already migrated or new install

  // Read old localStorage keys
  const oldLlmModel = localStorage.getItem('llmModel');
  const oldProvidersConfig = localStorage.getItem('providersConfig');
  const oldTtsModel = localStorage.getItem('ttsModel');
  const oldSelectedAgents = localStorage.getItem('selectedAgentIds');

  if (!oldLlmModel && !oldProvidersConfig) return null; // No old data

  // Parse model selection
  let providerId: ProviderId = 'openai';
  let modelId = 'gpt-5.4-mini';
  if (oldLlmModel) {
    const [pid, mid] = oldLlmModel.split(':');
    if (pid && mid) {
      providerId = pid as ProviderId;
      modelId = mid;
    }
  }

  // Parse providers config
  let providersConfig = getDefaultProvidersConfig();
  if (oldProvidersConfig) {
    try {
      const parsed = JSON.parse(oldProvidersConfig);
      providersConfig = { ...providersConfig, ...parsed };
    } catch (e) {
      log.error('Failed to parse old providersConfig:', e);
    }
  }

  // Parse other settings
  let ttsModel = 'openai-tts';
  if (oldTtsModel) ttsModel = oldTtsModel;

  let selectedAgentIds = ['default-1', 'default-2', 'default-3'];
  if (oldSelectedAgents) {
    try {
      const parsed = JSON.parse(oldSelectedAgents);
      if (Array.isArray(parsed) && parsed.length > 0) {
        selectedAgentIds = parsed;
      }
    } catch (e) {
      log.error('Failed to parse old selectedAgentIds:', e);
    }
  }

  return {
    providerId,
    modelId,
    thinkingConfigs: {},
    providersConfig,
    ttsModel,
    selectedAgentIds,
  };
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => {
      // Try to migrate from old storage
      const migratedData = migrateFromOldStorage();
      const defaultAudioConfig = getDefaultAudioConfig();
      const defaultPDFConfig = getDefaultPDFConfig();
      const defaultImageConfig = getDefaultImageConfig();
      const defaultVideoConfig = getDefaultVideoConfig();
      const defaultWebSearchConfig = getDefaultWebSearchConfig();

      const initialProvidersConfig = migratedData?.providersConfig || getDefaultProvidersConfig();

      return {
        // Initial state (use migrated data if available)
        providerId: migratedData?.providerId || 'openai',
        modelId: migratedData?.modelId || '',
        thinkingConfigs: pruneThinkingConfigs(
          migratedData?.thinkingConfigs || {},
          initialProvidersConfig,
        ),
        providersConfig: initialProvidersConfig,
        ttsModel: migratedData?.ttsModel || 'openai-tts',
        selectedAgentIds: migratedData?.selectedAgentIds || ['default-1', 'default-2', 'default-3'],
        agentMode: 'auto' as const,
        autoAgentCount: 3,
        agentVoiceOverrides: {},
        agentSelectionIsUserSet: false,

        // Playback controls
        ttsMuted: false,
        ttsVolume: 1,
        autoPlayLecture: false,
        playbackSpeed: 1,

        // Layout preferences
        sidebarCollapsed: true,
        chatAreaCollapsed: true,
        chatAreaWidth: 320,
        editRailCollapsed: false,
        editRailWidth: 220,
        editInsertToolbarCollapsed: false,

        // Audio settings (use defaults)
        ...defaultAudioConfig,

        // PDF settings (use defaults)
        ...defaultPDFConfig,

        // Image settings (use defaults)
        ...defaultImageConfig,

        // Video settings (use defaults)
        ...defaultVideoConfig,

        // Media generation toggles (off by default)
        imageGenerationEnabled: false,
        videoGenerationEnabled: false,
        reviewOutlineEnabled: false,

        // TTS is OFF by default; auto-enabled on first server-sync when a TTS
        // provider is configured (mirrors image/video). Fresh installs with no
        // provider stay off and show an "enable browser-native" CTA (#665).
        ttsEnabled: false,
        asrEnabled: true,

        // Off until the server reports a concurrency via fetchServerProviders.
        parallelSceneConcurrency: 0,

        autoConfigApplied: false,

        // Web Search settings (use defaults)
        ...defaultWebSearchConfig,

        // Actions
        setModel: (providerId, modelId) => set({ providerId, modelId }),

        setThinkingConfig: (providerId, modelId, config) =>
          set((state) => {
            const key = getThinkingConfigKey(providerId, modelId);
            const next = { ...state.thinkingConfigs };
            if (config) {
              next[key] = config;
            } else {
              delete next[key];
            }
            return { thinkingConfigs: next };
          }),

        setProviderConfig: (providerId, config) =>
          set((state) => {
            const providersConfig = {
              ...state.providersConfig,
              [providerId]: {
                ...state.providersConfig[providerId],
                ...config,
              },
            };
            // Re-resolve through the shared resolver (#580): a single config
            // edit can make the active provider usable (adopt + pick a model),
            // make it INVALID — e.g. the user clears its API key — (fall back
            // to another usable provider or State A), or change its model list
            // (re-pick the model). All handled atomically here, never leaving
            // an invalid/stale (provider, model) selected.
            const { providerId: nextProvider, modelId: nextModel } = resolveLLMSelection(
              providersConfig,
              state.providerId,
              state.modelId,
            );
            return {
              providersConfig,
              thinkingConfigs: pruneThinkingConfigs(state.thinkingConfigs, providersConfig),
              ...(nextProvider !== state.providerId && { providerId: nextProvider }),
              ...(nextModel !== state.modelId && { modelId: nextModel }),
            };
          }),

        setProvidersConfig: (config) =>
          set((state) => {
            // Bulk config replace (delete provider/model, import, reset): same
            // shared resolver as setProviderConfig so the two paths can never
            // diverge — never leave the deleted/invalid provider selected.
            const { providerId: nextProvider, modelId: nextModel } = resolveLLMSelection(
              config,
              state.providerId,
              state.modelId,
            );
            return {
              providersConfig: config,
              thinkingConfigs: pruneThinkingConfigs(state.thinkingConfigs, config),
              ...(nextProvider !== state.providerId && { providerId: nextProvider }),
              ...(nextModel !== state.modelId && { modelId: nextModel }),
            };
          }),

        setTtsModel: (model) => set({ ttsModel: model }),

        setTTSMuted: (muted) => set({ ttsMuted: muted }),

        setTTSVolume: (volume) => set({ ttsVolume: Math.max(0, Math.min(1, volume)) }),

        setAutoPlayLecture: (autoPlay) => set({ autoPlayLecture: autoPlay }),

        setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),

        setSelectedAgentIds: (ids) => set({ selectedAgentIds: ids }),

        setAgentMode: (mode) => set({ agentMode: mode }),
        setAutoAgentCount: (count) => set({ autoAgentCount: count }),
        setAgentVoiceOverride: (agentId, voice) =>
          set((state) => {
            const next = { ...state.agentVoiceOverrides };
            if (voice) {
              next[agentId] = voice;
            } else {
              delete next[agentId];
            }
            return { agentVoiceOverrides: next };
          }),
        setAgentSelectionIsUserSet: (isUserSet) => set({ agentSelectionIsUserSet: isUserSet }),

        // Layout actions
        setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
        setChatAreaCollapsed: (collapsed) => set({ chatAreaCollapsed: collapsed }),
        setEditRailCollapsed: (collapsed) => set({ editRailCollapsed: collapsed }),
        setEditRailWidth: (width) => set({ editRailWidth: width }),
        setEditInsertToolbarCollapsed: (collapsed) =>
          set({ editInsertToolbarCollapsed: collapsed }),
        setChatAreaWidth: (width) => set({ chatAreaWidth: width }),

        // Audio actions
        setTTSProvider: (providerId) =>
          set((state) => {
            // If switching provider, set default voice for that provider
            const shouldUpdateVoice = state.ttsProviderId !== providerId;
            const defaultVoice = isCustomTTSProvider(providerId)
              ? state.ttsProvidersConfig[providerId]?.customVoices?.[0]?.id || 'default'
              : DEFAULT_TTS_VOICES[providerId as BuiltInTTSProviderId] || 'default';
            return {
              ttsProviderId: providerId,
              ...(shouldUpdateVoice && { ttsVoice: defaultVoice }),
            };
          }),

        setTTSVoice: (voice) => set({ ttsVoice: voice }),

        setTTSSpeed: (speed) => set({ ttsSpeed: speed }),

        // Reset language when switching providers, since language code formats differ
        // (e.g. browser-native uses BCP-47 "en-US", OpenAI Whisper uses ISO 639-1 "en")
        setASRProvider: (providerId) =>
          set((state) => {
            let supportedLanguages: string[];
            if (isCustomASRProvider(providerId)) {
              supportedLanguages = ['auto'];
            } else {
              supportedLanguages =
                ASR_PROVIDERS[providerId as keyof typeof ASR_PROVIDERS]?.supportedLanguages || [];
            }
            const isLanguageValid = supportedLanguages.includes(state.asrLanguage);
            return {
              asrProviderId: providerId,
              ...(isLanguageValid ? {} : { asrLanguage: supportedLanguages[0] || 'auto' }),
            };
          }),

        setASRLanguage: (language) => set({ asrLanguage: language }),

        setTTSProviderConfig: (providerId, config) =>
          set((state) => {
            const ttsProvidersConfig = {
              ...state.ttsProvidersConfig,
              [providerId]: {
                ...state.ttsProvidersConfig[providerId],
                ...config,
              },
            };
            // Disabling the active provider (e.g. removing a token plan) switches
            // the selection back to the always-available browser TTS so playback
            // doesn't keep pointing at a disabled provider with an empty key.
            if (state.ttsProviderId === providerId && config.enabled === false) {
              return {
                ttsProvidersConfig,
                ttsProviderId: getDefaultAudioConfig().ttsProviderId,
                ttsVoice: 'default',
              };
            }
            return { ttsProvidersConfig };
          }),

        setASRProviderConfig: (providerId, config) =>
          set((state) => ({
            asrProvidersConfig: {
              ...state.asrProvidersConfig,
              [providerId]: {
                ...state.asrProvidersConfig[providerId],
                ...config,
              },
            },
          })),

        // PDF actions
        setPDFProvider: (providerId) => set({ pdfProviderId: providerId }),

        setPDFProviderConfig: (providerId, config) =>
          set((state) => ({
            pdfProvidersConfig: {
              ...state.pdfProvidersConfig,
              [providerId]: {
                ...state.pdfProvidersConfig[providerId],
                ...config,
              },
            },
          })),

        // Image Generation actions
        setImageProvider: (providerId) =>
          set((state) => ({
            imageProviderId: providerId,
            imageModelId: resolveSelectedModel(
              state.imageModelId,
              resolveMediaModels(
                IMAGE_PROVIDERS[providerId]?.models ?? [],
                state.imageProvidersConfig[providerId],
              ),
            ),
          })),
        setImageModelId: (modelId) => set({ imageModelId: modelId }),

        setImageProviderConfig: (providerId, config) =>
          set((state) => {
            const mergedProvider = {
              ...state.imageProvidersConfig[providerId],
              ...config,
            };
            const imageProvidersConfig = {
              ...state.imageProvidersConfig,
              [providerId]: mergedProvider,
            };
            const base = { imageProvidersConfig };
            if (state.imageProviderId === providerId) {
              // Disabling the active provider (e.g. removing a token plan) must
              // switch the selection away to the default, or generation paths
              // keep pointing at a disabled provider with an empty key.
              if (config.enabled === false) {
                const providerIds = Object.keys(IMAGE_PROVIDERS) as ImageProviderId[];
                const usableFallback = providerIds.find(
                  (id) =>
                    id !== providerId &&
                    isUsableMediaProvider(IMAGE_PROVIDERS[id], imageProvidersConfig[id]),
                );
                const fallback =
                  usableFallback ?? providerIds.find((id) => id !== providerId) ?? providerId;
                const fallbackModels = resolveMediaModels(
                  IMAGE_PROVIDERS[fallback]?.models ?? [],
                  imageProvidersConfig[fallback],
                );
                return {
                  ...base,
                  imageProviderId: fallback,
                  imageModelId: resolveSelectedModel(state.imageModelId, fallbackModels),
                  ...(!usableFallback ? { imageGenerationEnabled: false } : {}),
                };
              }
              // Atomic invariant (#580): a config edit on the active image
              // provider (e.g. deleting the selected custom model) must not
              // leave imageModelId pointing at a model that no longer exists.
              const models = resolveMediaModels(
                IMAGE_PROVIDERS[providerId]?.models ?? [],
                mergedProvider,
              );
              const imageModelId = resolveSelectedModel(state.imageModelId, models);
              if (imageModelId) {
                return { ...base, imageModelId };
              }
            }
            return base;
          }),

        // Video Generation actions
        setVideoProvider: (providerId) =>
          set((state) => ({
            videoProviderId: providerId,
            videoModelId: resolveSelectedModel(
              state.videoModelId,
              resolveMediaModels(
                VIDEO_PROVIDERS[providerId]?.models ?? [],
                state.videoProvidersConfig[providerId],
              ),
            ),
          })),
        setVideoModelId: (modelId) => set({ videoModelId: modelId }),

        setVideoProviderConfig: (providerId, config) =>
          set((state) => {
            const mergedProvider = {
              ...state.videoProvidersConfig[providerId],
              ...config,
            };
            const videoProvidersConfig = {
              ...state.videoProvidersConfig,
              [providerId]: mergedProvider,
            };
            const base = { videoProvidersConfig };
            if (state.videoProviderId === providerId) {
              // Symmetric with image: disabling the active provider switches the
              // selection back to the default so nothing keeps pointing at a
              // disabled provider with an empty key.
              if (config.enabled === false) {
                const providerIds = Object.keys(VIDEO_PROVIDERS) as VideoProviderId[];
                const usableFallback = providerIds.find(
                  (id) =>
                    id !== providerId &&
                    isUsableMediaProvider(VIDEO_PROVIDERS[id], videoProvidersConfig[id]),
                );
                const fallback =
                  usableFallback ?? providerIds.find((id) => id !== providerId) ?? providerId;
                const fallbackModels = resolveMediaModels(
                  VIDEO_PROVIDERS[fallback]?.models ?? [],
                  videoProvidersConfig[fallback],
                );
                return {
                  ...base,
                  videoProviderId: fallback,
                  videoModelId: resolveSelectedModel(state.videoModelId, fallbackModels),
                  ...(!usableFallback ? { videoGenerationEnabled: false } : {}),
                };
              }
              // Atomic invariant (#580): symmetric with image — a config edit on
              // the active video provider must not leave videoModelId stale.
              const models = resolveMediaModels(
                VIDEO_PROVIDERS[providerId]?.models ?? [],
                mergedProvider,
              );
              const videoModelId = resolveSelectedModel(state.videoModelId, models);
              if (videoModelId) {
                return { ...base, videoModelId };
              }
            }
            return base;
          }),

        // Media generation toggle actions
        setImageGenerationEnabled: (enabled) => {
          if (enabled) {
            const cfg = get().imageProvidersConfig;
            const hasUsable = Object.values(cfg).some((c) => c.isServerConfigured || c.apiKey);
            if (!hasUsable) return;
          }
          set({ imageGenerationEnabled: enabled });
        },
        setVideoGenerationEnabled: (enabled) => {
          if (enabled) {
            const cfg = get().videoProvidersConfig;
            const hasUsable = Object.values(cfg).some((c) => c.isServerConfigured || c.apiKey);
            if (!hasUsable) return;
          }
          set({ videoGenerationEnabled: enabled });
        },
        setReviewOutlineEnabled: (enabled) => set({ reviewOutlineEnabled: enabled }),
        setTTSEnabled: (enabled) => set({ ttsEnabled: enabled }),
        setASREnabled: (enabled) => set({ asrEnabled: enabled }),

        // Custom audio provider actions
        addCustomTTSProvider: (id, name, baseUrl, requiresApiKey, defaultModel) =>
          set((state) => ({
            ttsProvidersConfig: {
              ...state.ttsProvidersConfig,
              [id]: {
                apiKey: '',
                baseUrl: '',
                enabled: true,
                modelId: defaultModel || '',
                customName: name,
                customDefaultBaseUrl: baseUrl,
                customVoices: [],
                isBuiltIn: false,
                requiresApiKey,
              },
            },
            ttsProviderId: id,
          })),

        removeCustomTTSProvider: (id) =>
          set((state) => {
            if (!isCustomTTSProvider(id)) return state;
            const { [id]: _, ...rest } = state.ttsProvidersConfig;
            return {
              ttsProvidersConfig: rest as typeof state.ttsProvidersConfig,
              ...(state.ttsProviderId === id && {
                ttsProviderId: 'browser-native-tts' as TTSProviderId,
                ttsVoice: 'default',
              }),
            };
          }),

        addCustomASRProvider: (id, name, baseUrl, requiresApiKey) =>
          set((state) => ({
            asrProvidersConfig: {
              ...state.asrProvidersConfig,
              [id]: {
                apiKey: '',
                baseUrl: '',
                enabled: true,
                modelId: '',
                customModels: [],
                customName: name,
                customDefaultBaseUrl: baseUrl,
                isBuiltIn: false,
                requiresApiKey,
              },
            },
            asrProviderId: id,
          })),

        removeCustomASRProvider: (id) =>
          set((state) => {
            if (!isCustomASRProvider(id)) return state;
            const { [id]: _, ...rest } = state.asrProvidersConfig;
            return {
              asrProvidersConfig: rest as typeof state.asrProvidersConfig,
              ...(state.asrProviderId === id && {
                asrProviderId: 'browser-native' as ASRProviderId,
                asrLanguage: 'zh',
              }),
            };
          }),

        // Web Search actions
        setWebSearchProvider: (providerId) => set({ webSearchProviderId: providerId }),
        setWebSearchProviderConfig: (providerId, config) =>
          set((state) => {
            const webSearchProvidersConfig = {
              ...state.webSearchProvidersConfig,
              [providerId]: {
                ...state.webSearchProvidersConfig[providerId],
                ...config,
              },
            };
            // Disabling the active provider switches the selection back to the
            // default so web search doesn't keep pointing at a disabled provider.
            if (state.webSearchProviderId === providerId && config.enabled === false) {
              return {
                webSearchProvidersConfig,
                webSearchProviderId: getDefaultWebSearchConfig().webSearchProviderId,
              };
            }
            return { webSearchProvidersConfig };
          }),
        setBaiduSubSources: (sources) =>
          set((state) => {
            const next = {
              ...state.baiduSubSources,
              ...sources,
            };
            if (!next.webSearch && !next.baike && !next.scholar) {
              return state;
            }
            return { baiduSubSources: next };
          }),

        // Fetch server-configured providers and merge into local state
        fetchServerProviders: async () => {
          try {
            const res = await fetch('/api/server-providers');
            if (!res.ok) return;
            // Managed providers expose only their allowed model list (LLM/image)
            // and presence (the "managed" flag) — never a base URL.
            const data = (await res.json()) as {
              providers: Record<string, { models?: string[] }>;
              // TTS additionally carries an optional `disabled` flag for
              // admin/server-level force-off (#665).
              tts: Record<string, { disabled?: boolean }>;
              asr: Record<string, Record<string, never>>;
              pdf: Record<string, Record<string, never>>;
              image: Record<string, { models?: string[] }>;
              video: Record<string, Record<string, never>>;
              webSearch: Record<string, Record<string, never>>;
              generation?: { parallelSceneConcurrency?: number };
            };

            set((state) => {
              // Merge LLM providers
              const newProvidersConfig = { ...state.providersConfig };
              // First reset all server flags
              for (const pid of Object.keys(newProvidersConfig)) {
                const key = pid as ProviderId;
                if (newProvidersConfig[key]) {
                  newProvidersConfig[key] = {
                    ...newProvidersConfig[key],
                    isServerConfigured: false,
                    serverModels: undefined,
                  };
                }
              }
              // Set flags for server-configured providers
              for (const [pid, info] of Object.entries(data.providers)) {
                const key = pid as ProviderId;
                if (newProvidersConfig[key]) {
                  const currentModels = newProvidersConfig[key].models;
                  // When server specifies allowed models, filter the models list
                  // while preserving custom IDs from env/YAML in server order.
                  const currentModelMap = new Map(currentModels.map((m) => [m.id, m]));
                  const filteredModels = info.models?.length
                    ? info.models.map((id) => currentModelMap.get(id) ?? { id, name: id })
                    : currentModels;
                  newProvidersConfig[key] = {
                    ...newProvidersConfig[key],
                    isServerConfigured: true,
                    serverModels: info.models,
                    models: filteredModels,
                  };
                }
              }

              // Merge TTS providers. Reset both server flags first, then apply:
              // an entry with `disabled` is force-off (server precedence) and is
              // NOT treated as managed/configured; any other entry is managed.
              const newTTSConfig = { ...state.ttsProvidersConfig };
              for (const pid of Object.keys(newTTSConfig)) {
                const key = pid as TTSProviderId;
                if (newTTSConfig[key]) {
                  newTTSConfig[key] = {
                    ...newTTSConfig[key],
                    isServerConfigured: false,
                    serverDisabled: false,
                  };
                }
              }
              for (const [pid, info] of Object.entries(data.tts)) {
                const key = pid as TTSProviderId;
                if (newTTSConfig[key]) {
                  newTTSConfig[key] = {
                    ...newTTSConfig[key],
                    isServerConfigured: !info.disabled,
                    serverDisabled: info.disabled === true,
                  };
                }
              }

              // Merge ASR providers
              const newASRConfig = { ...state.asrProvidersConfig };
              for (const pid of Object.keys(newASRConfig)) {
                const key = pid as ASRProviderId;
                if (newASRConfig[key]) {
                  newASRConfig[key] = {
                    ...newASRConfig[key],
                    isServerConfigured: false,
                  };
                }
              }
              for (const pid of Object.keys(data.asr)) {
                const key = pid as ASRProviderId;
                if (newASRConfig[key]) {
                  newASRConfig[key] = {
                    ...newASRConfig[key],
                    isServerConfigured: true,
                  };
                }
              }

              // Merge PDF providers
              const newPDFConfig = { ...state.pdfProvidersConfig };
              for (const pid of Object.keys(newPDFConfig)) {
                const key = pid as PDFProviderId;
                if (newPDFConfig[key]) {
                  newPDFConfig[key] = {
                    ...newPDFConfig[key],
                    isServerConfigured: false,
                  };
                }
              }
              for (const pid of Object.keys(data.pdf)) {
                const key = pid as PDFProviderId;
                if (newPDFConfig[key]) {
                  newPDFConfig[key] = {
                    ...newPDFConfig[key],
                    isServerConfigured: true,
                  };
                }
              }

              // Merge Image providers
              const newImageConfig = { ...state.imageProvidersConfig };
              for (const pid of Object.keys(newImageConfig)) {
                const key = pid as ImageProviderId;
                if (newImageConfig[key]) {
                  newImageConfig[key] = {
                    ...newImageConfig[key],
                    isServerConfigured: false,
                  };
                }
              }
              for (const pid of Object.keys(data.image)) {
                const key = pid as ImageProviderId;
                if (newImageConfig[key]) {
                  newImageConfig[key] = {
                    ...newImageConfig[key],
                    isServerConfigured: true,
                  };
                }
              }

              // Merge Video providers
              const newVideoConfig = { ...state.videoProvidersConfig };
              for (const pid of Object.keys(newVideoConfig)) {
                const key = pid as VideoProviderId;
                if (newVideoConfig[key]) {
                  newVideoConfig[key] = {
                    ...newVideoConfig[key],
                    isServerConfigured: false,
                  };
                }
              }
              if (data.video) {
                for (const pid of Object.keys(data.video)) {
                  const key = pid as VideoProviderId;
                  if (newVideoConfig[key]) {
                    newVideoConfig[key] = {
                      ...newVideoConfig[key],
                      isServerConfigured: true,
                    };
                  }
                }
              }

              // Merge Web Search config — reset all first, then mark server-configured
              const newWebSearchConfig = { ...state.webSearchProvidersConfig };
              for (const key of Object.keys(newWebSearchConfig) as WebSearchProviderId[]) {
                newWebSearchConfig[key] = {
                  ...newWebSearchConfig[key],
                  isServerConfigured: false,
                };
              }
              if (data.webSearch) {
                for (const pid of Object.keys(data.webSearch)) {
                  const key = pid as WebSearchProviderId;
                  if (newWebSearchConfig[key]) {
                    newWebSearchConfig[key] = {
                      ...newWebSearchConfig[key],
                      isServerConfigured: true,
                    };
                  }
                }
              }

              // === Validate current selections against updated configs ===
              // Build fallback: server-configured first, then client-key-only
              const buildFallback = <T extends string>(
                config: Record<
                  string,
                  { isServerConfigured?: boolean; apiKey?: string; serverDisabled?: boolean }
                >,
              ): T[] => [
                // Server-disabled providers (TTS only) are never fallback targets.
                ...Object.entries(config)
                  .filter(([, c]) => c.isServerConfigured && !c.serverDisabled)
                  .map(([id]) => id as T),
                ...Object.entries(config)
                  .filter(([, c]) => !c.isServerConfigured && !c.serverDisabled && !!c.apiKey)
                  .map(([id]) => id as T),
              ];

              const llmFallback = buildFallback<ProviderId>(newProvidersConfig);
              const ttsFallback = buildFallback<TTSProviderId>(newTTSConfig);
              const asrFallback = buildFallback<ASRProviderId>(newASRConfig);
              const pdfFallback = buildFallback<PDFProviderId>(newPDFConfig);
              const imageFallback = buildFallback<ImageProviderId>(newImageConfig);
              const videoFallback = buildFallback<VideoProviderId>(newVideoConfig);
              const webSearchFallback = buildFallback<WebSearchProviderId>(newWebSearchConfig);

              let validLLMProvider = validateProvider(
                state.providerId,
                newProvidersConfig,
                llmFallback,
              );
              const validTTSProvider = validateProvider(
                state.ttsProviderId,
                newTTSConfig,
                ttsFallback,
                'browser-native-tts' as TTSProviderId,
              );
              const validASRProvider = validateProvider(
                state.asrProviderId,
                newASRConfig,
                asrFallback,
                'browser-native' as ASRProviderId,
              );
              const validPDFProvider = validateProvider(
                state.pdfProviderId,
                newPDFConfig,
                pdfFallback,
                'unpdf' as PDFProviderId,
              );
              let validImageProvider = validateProvider(
                state.imageProviderId,
                newImageConfig,
                imageFallback,
              );
              let validVideoProvider = validateProvider(
                state.videoProviderId,
                newVideoConfig,
                videoFallback,
              );
              const validWebSearchProvider = validateProvider(
                state.webSearchProviderId,
                newWebSearchConfig,
                webSearchFallback,
                'tavily' as WebSearchProviderId,
              );

              // Auto-recover: when the selected provider is empty/unusable but
              // a usable one exists, adopt the first usable fallback. Applied
              // symmetrically to LLM/image/video so that "usable provider ⇒ a
              // concrete model is selected" holds for every modality (#580).
              if (!validLLMProvider && llmFallback.length > 0) {
                validLLMProvider = llmFallback[0];
              }
              if (!validImageProvider && imageFallback.length > 0) {
                validImageProvider = imageFallback[0];
              }
              if (!validVideoProvider && videoFallback.length > 0) {
                validVideoProvider = videoFallback[0];
              }

              // Resolve the model in the same place the provider is resolved.
              // resolveSelectedModel never yields '' when the provider has ≥1
              // model, so a usable provider can never settle with an empty model.
              const llmModels = validLLMProvider
                ? (newProvidersConfig[validLLMProvider as ProviderId]?.models ?? [])
                : [];
              const validLLMModel = validLLMProvider
                ? resolveSelectedModel(state.modelId, llmModels)
                : '';
              const imageModels = validImageProvider
                ? resolveMediaModels(
                    IMAGE_PROVIDERS[validImageProvider as ImageProviderId]?.models ?? [],
                    newImageConfig[validImageProvider as ImageProviderId],
                  )
                : [];
              const validImageModel = validImageProvider
                ? resolveSelectedModel(state.imageModelId, imageModels)
                : '';
              const videoModels = validVideoProvider
                ? resolveMediaModels(
                    VIDEO_PROVIDERS[validVideoProvider as VideoProviderId]?.models ?? [],
                    newVideoConfig[validVideoProvider as VideoProviderId],
                  )
                : [];
              const validVideoModel = validVideoProvider
                ? resolveSelectedModel(state.videoModelId, videoModels)
                : '';

              const validTTSVoice =
                validTTSProvider !== state.ttsProviderId
                  ? DEFAULT_TTS_VOICES[validTTSProvider as BuiltInTTSProviderId] || 'default'
                  : state.ttsVoice;

              // Auto-disable image/video generation when no provider is usable
              const shouldDisableImage = !validImageProvider && state.imageGenerationEnabled;
              const shouldDisableVideo = !validVideoProvider && state.videoGenerationEnabled;

              // === Auto-select / auto-enable (only on first run) ===
              let autoTtsProvider: TTSProviderId | undefined;
              let autoTtsVoice: string | undefined;
              let autoAsrProvider: ASRProviderId | undefined;
              let autoPdfProvider: PDFProviderId | undefined;
              let autoImageProvider: ImageProviderId | undefined;
              let autoImageModel: string | undefined;
              let autoVideoProvider: VideoProviderId | undefined;
              let autoVideoModel: string | undefined;
              let autoImageEnabled: boolean | undefined;
              let autoVideoEnabled: boolean | undefined;
              let autoTtsEnabled: boolean | undefined;

              if (!state.autoConfigApplied) {
                // PDF: unpdf → mineru-cloud or mineru if server has it
                if (state.pdfProviderId === 'unpdf') {
                  if (newPDFConfig['mineru-cloud']?.isServerConfigured) {
                    autoPdfProvider = 'mineru-cloud' as PDFProviderId;
                  } else if (newPDFConfig.mineru?.isServerConfigured) {
                    autoPdfProvider = 'mineru' as PDFProviderId;
                  }
                }

                // TTS: select first server provider if current is not server-configured.
                // Skip server-disabled entries — they are force-off, not selectable.
                const serverTtsIds = Object.entries(data.tts)
                  .filter(([, info]) => !info.disabled)
                  .map(([id]) => id) as TTSProviderId[];
                if (
                  serverTtsIds.length > 0 &&
                  !newTTSConfig[state.ttsProviderId]?.isServerConfigured
                ) {
                  autoTtsProvider = serverTtsIds[0];
                  autoTtsVoice =
                    DEFAULT_TTS_VOICES[autoTtsProvider as BuiltInTTSProviderId] || 'default';
                }
                // Auto-enable TTS on first run when a server provider exists
                // (mirrors image/video). No provider ⇒ stays off + CTA.
                if (serverTtsIds.length > 0 && !state.ttsEnabled) {
                  autoTtsEnabled = true;
                }

                // ASR: select first server provider if current is not server-configured
                const serverAsrIds = Object.keys(data.asr) as ASRProviderId[];
                if (
                  serverAsrIds.length > 0 &&
                  !newASRConfig[state.asrProviderId]?.isServerConfigured
                ) {
                  autoAsrProvider = serverAsrIds[0];
                }

                // Image: first server provider
                const serverImageIds = Object.keys(data.image) as ImageProviderId[];
                if (
                  serverImageIds.length > 0 &&
                  !newImageConfig[state.imageProviderId]?.isServerConfigured
                ) {
                  autoImageProvider = serverImageIds[0];
                  const models = IMAGE_PROVIDERS[autoImageProvider]?.models;
                  if (models?.length) autoImageModel = models[0].id;
                }
                if (serverImageIds.length > 0 && !state.imageGenerationEnabled) {
                  autoImageEnabled = true;
                }

                // Video: first server provider
                const serverVideoIds = Object.keys(data.video || {}) as VideoProviderId[];
                if (
                  serverVideoIds.length > 0 &&
                  !newVideoConfig[state.videoProviderId]?.isServerConfigured
                ) {
                  autoVideoProvider = serverVideoIds[0];
                  const models = VIDEO_PROVIDERS[autoVideoProvider]?.models;
                  if (models?.length) autoVideoModel = models[0].id;
                }
                if (serverVideoIds.length > 0 && !state.videoGenerationEnabled) {
                  autoVideoEnabled = true;
                }
              }

              // (LLM first-load auto-select removed: the symmetric provider
              // recovery + resolveSelectedModel above now resolve LLM provider
              // and model atomically at the source, covering server-configured
              // AND client-API-key providers — see #580.)

              return {
                providersConfig: newProvidersConfig,
                ttsProvidersConfig: newTTSConfig,
                asrProvidersConfig: newASRConfig,
                pdfProvidersConfig: newPDFConfig,
                imageProvidersConfig: newImageConfig,
                videoProvidersConfig: newVideoConfig,
                webSearchProvidersConfig: newWebSearchConfig,
                // Already clamped server-side (getParallelSceneConcurrency); this
                // re-clamp is intentional belt-and-suspenders against a malformed
                // response. The consumer (use-scene-generator) clamps once more.
                parallelSceneConcurrency: Math.max(
                  0,
                  Math.floor(data.generation?.parallelSceneConcurrency ?? 0),
                ),
                autoConfigApplied: true,
                // Validated selections
                ...(validLLMProvider !== state.providerId && {
                  providerId: validLLMProvider as ProviderId,
                }),
                ...(validLLMModel !== state.modelId && { modelId: validLLMModel }),
                ...(validTTSProvider !== state.ttsProviderId && {
                  ttsProviderId: validTTSProvider as TTSProviderId,
                  ttsVoice: validTTSVoice,
                }),
                ...(validASRProvider !== state.asrProviderId && {
                  asrProviderId: validASRProvider as ASRProviderId,
                }),
                ...(validPDFProvider !== state.pdfProviderId && {
                  pdfProviderId: validPDFProvider as PDFProviderId,
                }),
                ...(validWebSearchProvider !== state.webSearchProviderId && {
                  webSearchProviderId: validWebSearchProvider as WebSearchProviderId,
                }),
                ...(validImageProvider !== state.imageProviderId && {
                  imageProviderId: validImageProvider as ImageProviderId,
                }),
                ...(validImageModel !== state.imageModelId && {
                  imageModelId: validImageModel,
                }),
                ...(validVideoProvider !== state.videoProviderId && {
                  videoProviderId: validVideoProvider as VideoProviderId,
                }),
                ...(validVideoModel !== state.videoModelId && {
                  videoModelId: validVideoModel,
                }),
                ...(shouldDisableImage && { imageGenerationEnabled: false }),
                ...(shouldDisableVideo && { videoGenerationEnabled: false }),
                // First-run auto-select overrides validation (autoConfigApplied guard).
                // On first sync, auto-select picks the best provider. On subsequent syncs,
                // auto* variables stay undefined so only validation spreads take effect.
                ...(autoPdfProvider && { pdfProviderId: autoPdfProvider }),
                ...(autoTtsProvider && {
                  ttsProviderId: autoTtsProvider,
                  ttsVoice: autoTtsVoice,
                }),
                ...(autoAsrProvider && { asrProviderId: autoAsrProvider }),
                ...(autoImageProvider && {
                  imageProviderId: autoImageProvider,
                }),
                ...(autoImageModel && { imageModelId: autoImageModel }),
                ...(autoVideoProvider && {
                  videoProviderId: autoVideoProvider,
                }),
                ...(autoVideoModel && { videoModelId: autoVideoModel }),
                ...(autoImageEnabled !== undefined && {
                  imageGenerationEnabled: autoImageEnabled,
                }),
                ...(autoVideoEnabled !== undefined && {
                  videoGenerationEnabled: autoVideoEnabled,
                }),
                ...(autoTtsEnabled !== undefined && { ttsEnabled: autoTtsEnabled }),
              };
            });
          } catch (e) {
            // Silently fail — server providers are optional
            log.warn('Failed to fetch server providers:', e);
          }
        },
      };
    },
    {
      name: 'settings-storage',
      version: 4,
      // Migrate persisted state
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as Partial<SettingsState>;

        // v0 → v1: clear hardcoded default model so user must actively select
        if (version === 0) {
          if (state.providerId === 'openai' && state.modelId === 'gpt-4o-mini') {
            state.modelId = '';
          }
        }

        // Ensure providersConfig has all built-in providers (also in merge below)
        ensureBuiltInProviders(state);
        promoteLegacyCustomProviderBaseUrls(state);

        // Ensure image/video configs have all built-in providers
        ensureBuiltInImageProviders(state);
        ensureBuiltInVideoProviders(state);

        // Migrate from old ttsModel to new ttsProviderId
        if (state.ttsModel && !state.ttsProviderId) {
          // Map old ttsModel values to new ttsProviderId
          if (state.ttsModel === 'openai-tts') {
            state.ttsProviderId = 'openai-tts';
          } else if (state.ttsModel === 'azure-tts') {
            state.ttsProviderId = 'azure-tts';
          } else {
            // Default to OpenAI
            state.ttsProviderId = 'openai-tts';
          }
        }

        // Add default audio config if missing
        if (!state.ttsProvidersConfig || !state.asrProvidersConfig) {
          const defaultAudioConfig = getDefaultAudioConfig();
          Object.assign(state, defaultAudioConfig);
        }
        ensureBuiltInAudioProviders(state);
        ensureBuiltInWebSearchProviders(state);

        // Migrate global ttsModelId to per-provider
        if ((state as Record<string, unknown>).ttsModelId) {
          const pid = state.ttsProviderId;
          if (pid && state.ttsProvidersConfig?.[pid]) {
            state.ttsProvidersConfig[pid].modelId = (state as Record<string, unknown>)
              .ttsModelId as string;
          }
          delete (state as Record<string, unknown>).ttsModelId;
        }
        // Same for asrModelId
        if ((state as Record<string, unknown>).asrModelId) {
          const pid = state.asrProviderId;
          if (pid && state.asrProvidersConfig?.[pid]) {
            state.asrProvidersConfig[pid].modelId = (state as Record<string, unknown>)
              .asrModelId as string;
          }
          delete (state as Record<string, unknown>).asrModelId;
        }
        // Migrate MiniMax's model field to modelId
        for (const [, cfg] of Object.entries(
          (state.ttsProvidersConfig as Record<string, Record<string, unknown>>) || {},
        )) {
          if (cfg.model && !cfg.modelId) {
            cfg.modelId = cfg.model;
            delete cfg.model;
          }
        }

        // Add default PDF config if missing
        if (!state.pdfProvidersConfig) {
          const defaultPDFConfig = getDefaultPDFConfig();
          Object.assign(state, defaultPDFConfig);
        }

        // Add default Image config if missing
        if (!state.imageProvidersConfig) {
          const defaultImageConfig = getDefaultImageConfig();
          Object.assign(state, defaultImageConfig);
        }

        // Add default Video config if missing
        if (!state.videoProvidersConfig) {
          const defaultVideoConfig = getDefaultVideoConfig();
          Object.assign(state, defaultVideoConfig);
        }

        // v1 → v2: Replace deep research with web search
        if (version < 2) {
          delete (state as Record<string, unknown>).deepResearchProviderId;
          delete (state as Record<string, unknown>).deepResearchProvidersConfig;
        }

        // Add default media generation toggles if missing
        if (state.imageGenerationEnabled === undefined) {
          state.imageGenerationEnabled = false;
        }
        if (state.videoGenerationEnabled === undefined) {
          state.videoGenerationEnabled = false;
        }
        if (state.reviewOutlineEnabled === undefined) {
          state.reviewOutlineEnabled = false;
        }

        // Add default audio toggles if missing. TTS defaults OFF (opt-in / CTA);
        // first server-sync auto-enables it when a provider is configured (#665).
        if ((state as Record<string, unknown>).ttsEnabled === undefined) {
          (state as Record<string, unknown>).ttsEnabled = false;
        }
        if ((state as Record<string, unknown>).asrEnabled === undefined) {
          (state as Record<string, unknown>).asrEnabled = true;
        }

        // Existing users already have their config set up — mark auto-config as done
        if ((state as Record<string, unknown>).autoConfigApplied === undefined) {
          (state as Record<string, unknown>).autoConfigApplied = true;
        }

        if ((state as Record<string, unknown>).agentMode === undefined) {
          (state as Record<string, unknown>).agentMode = 'preset';
        }
        if ((state as Record<string, unknown>).autoAgentCount === undefined) {
          (state as Record<string, unknown>).autoAgentCount = 3;
        }

        if ((state as Record<string, unknown>).thinkingConfigs === undefined) {
          (state as Record<string, unknown>).thinkingConfigs = {};
        }

        // Migrate Web Search: old flat fields → new provider-based config
        if (!state.webSearchProvidersConfig) {
          const stateRecord = state as Record<string, unknown>;
          const oldApiKey = (stateRecord.webSearchApiKey as string) || '';
          const oldIsServerConfigured =
            (stateRecord.webSearchIsServerConfigured as boolean) || false;
          state.webSearchProviderId = 'tavily' as WebSearchProviderId;
          state.webSearchProvidersConfig = {
            tavily: {
              apiKey: oldApiKey,
              baseUrl: '',
              enabled: true,
              requiresApiKey: true,
              isServerConfigured: oldIsServerConfigured,
            },
            bocha: {
              apiKey: '',
              baseUrl: '',
              enabled: true,
              requiresApiKey: true,
            },
            brave: {
              apiKey: '',
              baseUrl: WEB_SEARCH_PROVIDERS.brave.defaultBaseUrl || '',
              enabled: true,
              requiresApiKey: false,
            },
            baidu: {
              apiKey: '',
              baseUrl: '',
              enabled: true,
              requiresApiKey: true,
            },
            minimax: {
              apiKey: '',
              baseUrl: WEB_SEARCH_PROVIDERS.minimax.defaultBaseUrl || '',
              enabled: true,
              requiresApiKey: true,
            },
          } as SettingsState['webSearchProvidersConfig'];
          delete stateRecord.webSearchApiKey;
          delete stateRecord.webSearchIsServerConfigured;
        }

        // v2 → v3: managed providers no longer expose a base URL to the client;
        // drop any persisted serverBaseUrl left over from older versions (#620).
        stripLegacyServerBaseUrl(state);

        // v3 → v4: the per-provider `enabled` flag becomes live under the
        // unified enablement model (#665). Before v4 it was never user-editable,
        // so any persisted value is just a stale default — normalize it:
        // browser-native OFF (opt-in), every other built-in ON (it only surfaces
        // once configured, so a server-managed provider must not stay hidden).
        if (version < 4 && state.ttsProvidersConfig) {
          for (const pid of Object.keys(TTS_PROVIDERS) as BuiltInTTSProviderId[]) {
            const cfg = state.ttsProvidersConfig[pid];
            if (cfg) cfg.enabled = pid !== 'browser-native-tts';
          }
        }

        ensureValidProviderSelections(state);
        ensureBuiltInAudioProviders(state);
        ensureBuiltInWebSearchProviders(state);
        state.thinkingConfigs = pruneThinkingConfigs(state.thinkingConfigs, state.providersConfig);

        return state;
      },
      // Custom merge: always sync built-in providers on every rehydrate,
      // so newly added providers/models appear without clearing cache.
      merge: (persistedState, currentState) => {
        const merged = { ...currentState, ...(persistedState as object) };
        ensureBuiltInProviders(merged as Partial<SettingsState>);
        promoteLegacyCustomProviderBaseUrls(merged as Partial<SettingsState>);
        ensureBuiltInAudioProviders(merged as Partial<SettingsState>);
        ensureBuiltInImageProviders(merged as Partial<SettingsState>);
        ensureBuiltInVideoProviders(merged as Partial<SettingsState>);
        ensureBuiltInWebSearchProviders(merged as Partial<SettingsState>);
        ensureValidProviderSelections(merged as Partial<SettingsState>);
        stripLegacyServerBaseUrl(merged as Partial<SettingsState>);
        const typedMerged = merged as Partial<SettingsState>;
        typedMerged.thinkingConfigs = pruneThinkingConfigs(
          typedMerged.thinkingConfigs,
          typedMerged.providersConfig,
        );
        return merged as SettingsState;
      },
    },
  ),
);
