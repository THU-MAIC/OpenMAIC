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
  /** LLM only: explicit /models URL override (optional). */
  modelsUrl?: string;
  /**
   * LLM only: fixed model ids to seed when the endpoint exposes no probable
   * /models list (e.g. Volcengine Agent Plan, an Anthropic-style gateway whose
   * models are named, not listed). Applied directly; probing is skipped.
   */
  defaultModels?: string[];
  /**
   * LLM only: treat `defaultModels` as CANDIDATES to verify rather than a fixed
   * list. On apply, each candidate gets a minimal chat request; only the ones
   * that succeed are kept. Use for plans with a published-but-tier-varying model
   * set and no /models endpoint (e.g. Volcengine Agent Plan) — auto-prunes
   * retired/unavailable models without code changes.
   */
  verifyModels?: boolean;
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
 * - MiniMax is the full-set template: every modality already has a working
 *   adapter in OpenMAIC (LLM/image/video/TTS/web-search).
 * - The rest declare LLM only for now (balance auto-detected where supported);
 *   extend to more modalities by adding entries as adapters land.
 */
export const TOKEN_PLAN_PRESETS: TokenPlanPreset[] = [
  // ── Full-set token plan (template) ────────────────────────────────────────
  {
    id: 'minimax',
    name: 'MiniMax',
    websiteUrl: 'https://platform.minimaxi.com',
    icon: '/logos/minimax.svg',
    category: 'token_plan',
    modalities: {
      llm: {
        providerId: 'minimax',
        baseUrl: 'https://api.minimaxi.com/anthropic/v1',
        apiFormat: 'anthropic',
      },
      image: { providerId: 'minimax-image', baseUrl: 'https://api.minimaxi.com' },
      video: { providerId: 'minimax-video', baseUrl: 'https://api.minimaxi.com' },
      tts: {
        providerId: 'minimax-tts',
        baseUrl: 'https://api.minimaxi.com',
        defaultModelId: 'speech-2.8-hd',
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
    // list (404), so we carry the published model set as CANDIDATES and verify
    // each on apply (verifyModels) — this auto-prunes retired models (the docs
    // flag deepseek-v3.2 / glm-5.1 as 即将下线) and tier-gated ones without code
    // changes. ark-code-latest is an auto-routing alias valid on every tier.
    id: 'volcengine-ark',
    name: '火山方舟 Agent Plan',
    websiteUrl: 'https://console.volcengine.com/ark',
    icon: '/logos/volcengine.svg',
    category: 'token_plan',
    modalities: {
      llm: {
        providerId: 'doubao',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        apiFormat: 'openai',
        verifyModels: true,
        defaultModels: [
          'ark-code-latest',
          'doubao-seed-2.0-pro',
          'doubao-seed-2.0-code',
          'doubao-seed-2.0-lite',
          'doubao-seed-2.0-mini',
          'deepseek-v4-pro',
          'deepseek-v4-flash',
          'minimax-m3',
          'minimax-m2.7',
          'glm-5.2',
          'kimi-k2.7-code',
          'kimi-k2.6',
        ],
      },
      // Image: the plan's seedream model differs from the seedream registry
      // default (5.0-lite vs the pay-as-you-go id), so declare it explicitly.
      // The adapter routes by baseUrl path (/api/plan/v3 → /images/generations).
      image: {
        providerId: 'seedream',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        defaultModels: ['doubao-seedream-5.0-lite'],
      },
      // Video: only Medium+ tiers include video; lower tiers reject these at
      // call time. Declared so an upgraded plan works without a code change.
      video: {
        providerId: 'seedance',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        defaultModels: ['doubao-seedance-2.0', 'doubao-seedance-1.5-pro'],
      },
    },
  },

  // ── Aggregators / gateways (LLM) ──────────────────────────────────────────
  {
    id: 'openrouter',
    name: 'OpenRouter',
    websiteUrl: 'https://openrouter.ai',
    icon: '/logos/openrouter.svg',
    category: 'aggregator',
    modalities: {
      llm: {
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiFormat: 'openai',
      },
    },
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow 硅基流动',
    websiteUrl: 'https://siliconflow.cn',
    icon: '/logos/siliconflow.svg',
    category: 'aggregator',
    modalities: {
      llm: {
        providerId: 'siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiFormat: 'openai',
      },
    },
  },

  // ── Vendor-direct (LLM) ───────────────────────────────────────────────────
  {
    id: 'deepseek',
    name: 'DeepSeek',
    websiteUrl: 'https://platform.deepseek.com',
    icon: '/logos/deepseek.svg',
    category: 'third_party',
    modalities: {
      llm: { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiFormat: 'openai' },
    },
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    websiteUrl: 'https://bigmodel.cn',
    icon: '/logos/glm.svg',
    category: 'third_party',
    modalities: {
      llm: {
        providerId: 'glm',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiFormat: 'openai',
      },
    },
  },
  {
    id: 'qwen',
    name: '通义千问 Qwen',
    websiteUrl: 'https://bailian.console.aliyun.com',
    icon: '/logos/qwen.svg',
    category: 'third_party',
    modalities: {
      llm: {
        providerId: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiFormat: 'openai',
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
