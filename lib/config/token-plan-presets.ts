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
      // Image: the Agent Plan publishes the Seedream 4.0–5.0 family on the /plan
      // endpoint (docs: Seedream 4.0-5.0 教程; the curl example uses the dotted
      // alias `doubao-seedream-5.0-lite`, NOT the pay-as-you-go catalog id). List
      // them best-first so the verified `customModels[0]` is the strongest the
      // plan tier allows: a high tier keeps `5.0`, a lite tier prunes down to
      // `5.0-lite`. The adapter routes by baseUrl path (/api/plan/v3 →
      // /images/generations).
      image: {
        providerId: 'seedream',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        verifyModels: true,
        defaultModels: [
          'doubao-seedream-5.0',
          'doubao-seedream-5.0-lite',
          'doubao-seedream-4.5',
          'doubao-seedream-4.0',
        ],
      },
      // Video: the Agent Plan publishes the Seedance 2.0 + 1.5 family (docs: the
      // curl example uses `doubao-seedance-2.0`). Tier-gated — a lower tier
      // rejects 2.0 with `UnsupportedModel` ("does not support the agent plan
      // feature") while still allowing 1.5-pro. verifyModels probes each on apply
      // (best-first), so a high tier keeps 2.0 and a lower tier prunes to 1.5-pro
      // — no false "available" that fails on first use, and an upgraded plan
      // lights up 2.0 with no code change.
      video: {
        providerId: 'seedance',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        verifyModels: true,
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
