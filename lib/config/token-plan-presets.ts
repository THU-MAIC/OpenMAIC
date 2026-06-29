/**
 * Token Plan presets — multi-modal.
 *
 * A token plan (e.g. MiniMax) is often a single key that spans LLM + image +
 * video + TTS + web-search. A preset declares, per modality, the target provider
 * id + base URL in that modality's registry. "One-click apply" fills the key into
 * every declared modality and lights it up; modalities not declared here are
 * simply "not adapted yet" (at our best — add an entry later to extend).
 *
 * Data-driven by design: adding a vendor/token-plan, or extending one to a new
 * modality, is one entry here — no code changes (plan's extensibility principle).
 */

import type { ProviderType } from '@/lib/types/provider';

/** Loose grouping for the preset list UI. */
export type PresetCategory = 'official' | 'aggregator' | 'token_plan' | 'third_party';

/** The modalities a token plan can be applied to. ASR is omitted = not adapted. */
export type TokenPlanModality = 'llm' | 'image' | 'video' | 'tts' | 'webSearch';

/** Where a token plan maps in one modality's provider registry. */
export interface TokenPlanModalityTarget {
  /** Provider id in that modality's registry (e.g. 'minimax-image'). */
  providerId: string;
  /** Base URL to fill for this modality. */
  baseUrl: string;
  /** LLM only: API protocol → app providerType. */
  apiFormat?: ProviderType;
  /**
   * LLM only: explicit /models URL override (optional). */
  modelsUrl?: string;
  /**
   * Model ids the plan offers in this modality, listed best-first. These are
   * seeded directly into the provider config as the plan's curated catalogue —
   * NOT probed. Tier-gated ids (a lower plan tier may not include the top model)
   * stay in the list and simply error at generation time if the tier excludes
   * them; we never silently drop a model the user paid for.
   */
  defaultModels?: string[];
  /** TTS only: default model id to enable. */
  defaultModelId?: string;
}

export interface TokenPlanPreset {
  /** Stable id (React key, derives custom LLM provider id). */
  id: string;
  /** Display name. */
  name: string;
  /** Optional vendor/docs link. */
  websiteUrl?: string;
  /** Example key prefix shown in the settings input placeholder. */
  apiKeyPlaceholder?: string;
  /** Icon path under /public (optional). */
  icon?: string;
  category: PresetCategory;
  /** Per-modality apply targets. Only declared modalities get lit up. */
  modalities: Partial<Record<TokenPlanModality, TokenPlanModalityTarget>>;
}

/** Human-facing order of modalities in the apply result. */
export const MODALITY_ORDER: TokenPlanModality[] = ['llm', 'image', 'video', 'tts', 'webSearch'];

/**
 * Built-in token plans.
 *
 * Scoped to TRUE token plans — a single key that spans multiple modalities.
 * Single-modality LLM providers (aggregators like OpenRouter, vendor-direct like
 * DeepSeek/GLM/Qwen) are deliberately NOT here: they're ordinary API providers
 * already covered by the add-provider flow, and listing them under "Token Plan"
 * muddied the "one key, every modality" promise.
 *
 * - MiniMax: full-set template — every modality has a working adapter
 *   (LLM/image/video/TTS/web-search).
 * - Volcengine Ark Agent Plan: LLM/image/video/TTS/web-search via the plan key.
 */
export const TOKEN_PLAN_PRESETS: TokenPlanPreset[] = [
  // ── Full-set token plan (template) ────────────────────────────────────────
  {
    id: 'minimax',
    name: 'MiniMax',
    websiteUrl: 'https://platform.minimaxi.com',
    apiKeyPlaceholder: 'sk-...',
    icon: '/logos/minimax.svg',
    category: 'token_plan',
    modalities: {
      llm: {
        providerId: 'minimax',
        baseUrl: 'https://api.minimaxi.com/anthropic/v1',
        apiFormat: 'anthropic',
        defaultModels: [
          'MiniMax-M3',
          'MiniMax-M2.7',
          'MiniMax-M2.7-highspeed',
          'MiniMax-M2.5',
          'MiniMax-M2.5-highspeed',
          'MiniMax-M2.1',
          'MiniMax-M2.1-highspeed',
          'MiniMax-M2',
        ],
      },
      image: {
        providerId: 'minimax-image',
        baseUrl: 'https://api.minimaxi.com',
        defaultModels: ['image-01', 'image-01-live'],
      },
      video: {
        providerId: 'minimax-video',
        baseUrl: 'https://api.minimaxi.com',
        defaultModels: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02', 'T2V-01-Director', 'T2V-01'],
      },
      tts: {
        providerId: 'minimax-tts',
        baseUrl: 'https://api.minimaxi.com',
        defaultModelId: 'speech-2.8-hd',
        defaultModels: [
          'speech-2.8-hd',
          'speech-2.8-turbo',
          'speech-2.6-hd',
          'speech-2.6-turbo',
          'speech-02-hd',
          'speech-02-turbo',
        ],
      },
      webSearch: { providerId: 'minimax', baseUrl: 'https://api.minimaxi.com' },
    },
  },

  // ── Vendor token plans (LLM; one key, often spans many models) ────────────
  {
    // Volcengine Ark Agent Plan. The ark--prefixed plan key authenticates only
    // against the dedicated /api/plan endpoint (OpenAI-compatible at
    // /api/plan/v3); the general /api/v3 and Coding Plan /api/coding endpoints
    // reject it ("API key format is incorrect"). The plan exposes no /models
    // list (404), so we carry the published model set as the curated catalogue.
    // ark-code-latest is an auto-routing alias valid on every tier; lower tiers
    // may not include every model below — those simply error at generation, no
    // silent pruning.
    id: 'volcengine-ark',
    name: '火山方舟 Agent Plan',
    websiteUrl: 'https://console.volcengine.com/ark',
    apiKeyPlaceholder: 'ark-...',
    icon: '/logos/volcengine.svg',
    category: 'token_plan',
    modalities: {
      llm: {
        providerId: 'doubao',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        apiFormat: 'openai',
        defaultModels: [
          'ark-code-latest',
          'doubao-seed-2.0-pro',
          'doubao-seed-2.0-code',
          'doubao-seed-2.0-lite',
          'doubao-seed-2.0-mini',
          'deepseek-v4-pro',
          'deepseek-v4-flash',
          'deepseek-v3.2',
          'minimax-m3',
          'minimax-m2.7',
          'glm-5.2',
          'glm-5.1',
          'kimi-k2.7-code',
          'kimi-k2.6',
        ],
      },
      // Image: Agent Plan documentation and user-facing guides consistently
      // expose Seedream 5.0 Lite via the dotted plan alias, not the pay-as-you-go
      // dated catalog id. The adapter routes by baseUrl path (/api/plan/v3 →
      // /images/generations).
      image: {
        providerId: 'seedream',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        defaultModels: ['doubao-seedream-5.0-lite'],
      },
      // Video: list the highest Agent Plan offering first. Lower tiers can
      // reject 2.0 with UnsupportedModel while still allowing 1.5-pro; we keep
      // both in the catalogue and let generation-time errors reflect the user's
      // actual plan tier.
      video: {
        providerId: 'seedance',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        defaultModels: ['doubao-seedance-2.0', 'doubao-seedance-1.5-pro'],
      },
      // Web search: 豆包搜索 (Custom 版). Unlike the LLM/image/video modalities,
      // this lives on its OWN host (open.feedcoopapi.com, not the ark plan
      // endpoint) and authenticates with the same Agent Plan key as a Bearer
      // token (verified). 500 free calls/month per Volcengine account.
      webSearch: {
        providerId: 'doubao',
        baseUrl: 'https://open.feedcoopapi.com',
      },
      // TTS: Doubao Seed-TTS 2.0. Yet another host (openspeech.bytedance.com)
      // with its own auth — the Agent Plan single key goes in `X-Api-Key` on the
      // /api/plan/tts endpoint (verified: the normal /api/v3/tts endpoint 401s a
      // plan key, and the plan endpoint rejects Bearer). The doubao-tts adapter
      // detects the single-key (no colon) shape and switches to X-Api-Key auth.
      tts: {
        providerId: 'doubao-tts',
        baseUrl: 'https://openspeech.bytedance.com/api/v3/plan/tts',
      },
    },
  },
];

/** Preset category display order. */
export const PRESET_CATEGORY_ORDER: PresetCategory[] = [
  'token_plan',
  'aggregator',
  'third_party',
  'official',
];
