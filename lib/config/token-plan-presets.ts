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
  /**
   * LLM/TTS: the plan's recommended default model — for LLM the mainline model
   * (defaults to `defaultModels[0]`), for TTS the model the plan enables.
   */
  defaultModelId?: string;
  /**
   * LLM only: per-stage recommended models, applied as user-level stage routes
   * (e.g. 'scene-content:slide' → the plan's courseware model). Stage keys live
   * in the LLM_STAGES whitelist; ids must also appear in `defaultModels` so the
   * route's model is selectable.
   */
  stageRoutes?: Record<string, string>;
}

export interface TokenPlanPreset {
  /** Stable id (React key, derives custom LLM provider id). */
  id: string;
  /** Display name. */
  name: string;
  /** Optional vendor/docs link. */
  websiteUrl?: string;
  /**
   * Optional plan subscription links (domestic / international). Rendered as a
   * links row in the plan panel; `websiteUrl` stays the generic manage-account
   * link.
   */
  subscribeUrls?: { domestic: string; international: string };
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
 * - TokenDance: LLM/image/video/TTS/web-search through one gateway key.
 * - MiniMax: full-set template — every modality has a working adapter
 *   (LLM/image/video/TTS/web-search).
 * - Volcengine Ark Agent Plan: LLM/image/video/TTS/web-search via the plan key.
 */
export const TOKEN_PLAN_PRESETS: TokenPlanPreset[] = [
  // ── Gateway token plan (one key, vendor wire formats) ─────────────────────
  {
    // TokenDance is a model gateway. Chat and image generation are
    // OpenAI-compatible at /gateway/v1; the same key also authenticates
    // vendor-protocol routes on the same host that keep each vendor's wire
    // format, so the existing adapters are reused with the route prefix as
    // their base URL: Ark (/gateway/ark/v3) for Seedream, MiniMax
    // (/gateway/minimax) for TTS and video, Bocha (/gateway/bocha) for web
    // search. The public catalogue is listed at /gateway/v1/models. Video
    // models are the H3 family, which only speak MiniMax's v2 task API.
    id: 'tokendance',
    name: 'TokenDance',
    websiteUrl: 'https://tokendance.space',
    apiKeyPlaceholder: 'sk-...',
    icon: '/logos/tokendance.svg',
    category: 'token_plan',
    modalities: {
      llm: {
        providerId: 'tokendance',
        baseUrl: 'https://tokendance.space/gateway/v1',
        apiFormat: 'openai',
        // The plan's own model family is its primary course-generation set: base
        // drives the mainline while slide/interactive cover courseware and
        // interactive pages.
        defaultModels: [
          'cogevol-base',
          'cogevol-slide-0828',
          'cogevol-interactive-0828',
          'deepseek-v4.1-flash',
          'deepseek-v4-pro',
          'glm-5.3',
          'kimi-k3',
          'qwen3.8-max',
          'seed-2.1-pro',
          'minimax-m3',
        ],
        defaultModelId: 'cogevol-base',
        stageRoutes: {
          'scene-content:slide': 'cogevol-slide-0828',
          'scene-content:interactive': 'cogevol-interactive-0828',
        },
      },
      image: {
        providerId: 'seedream',
        baseUrl: 'https://tokendance.space/gateway/ark/v3',
        defaultModels: ['seedream-5.0-lite', 'seedream-5.0-pro'],
      },
      video: {
        providerId: 'minimax-video',
        baseUrl: 'https://tokendance.space/gateway/minimax',
        defaultModels: ['minimax-h3', 'minimax-h3-max'],
      },
      tts: {
        providerId: 'minimax-tts',
        baseUrl: 'https://tokendance.space/gateway/minimax',
        defaultModelId: 'minimax-speech-2.8-turbo',
        defaultModels: ['minimax-speech-2.8-turbo', 'minimax-speech-2.8-hd'],
      },
      webSearch: {
        providerId: 'bocha',
        baseUrl: 'https://tokendance.space/gateway/bocha',
      },
    },
  },

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
        defaultModelId: 'speech-2.8-turbo',
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
          'doubao-seed-2.1-turbo',
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
        defaultModelId: 'doubao-seed-2.1-turbo',
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
        defaultModels: [
          'doubao-seedance-2.0-mini',
          'doubao-seedance-2.0',
          'doubao-seedance-1.5-pro',
        ],
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
        defaultModelId: 'seed-tts-2.0',
        defaultModels: ['seed-tts-2.0'],
      },
    },
  },
  // ── Kimi Coding Plan（末位 = 最低优先级）────────────────────────────────
  // LLM-only: the Coding Plan key authenticates against the plan's DEDICATED
  // endpoint (https://www.kimi.com/code/docs/) — api.kimi.com/coding/v1,
  // international api.kimi.ai/coding/v1 — NOT Moonshot's Open Platform
  // (api.moonshot.cn/v1): sending plan keys there fails with
  // "Not found the model kimi-for-coding or Permission denied" (review P0 on
  // #1664). The plan rides the EXISTING `kimi` direct provider (dual identity,
  // same slot as minimax/doubao — the enrollment marker keeps personal keys
  // safe, and connecting the plan intentionally takes over the slot, see
  // #1645); disconnect restores the registry default (Moonshot endpoint) for
  // personal keys. Seeding overrides the mainline to K2.8 (official model id
  // `kimi-for-coding`); every follow-mainline LLM station inherits it. No
  // image/video/TTS/web-search adaptation: those modalities are simply not
  // declared and stay untouched. Priority note: placed LAST in
  // TOKEN_PLAN_PRESETS, so when any other plan is enabled, Kimi yields the
  // mainline/stage slots to it.
  {
    id: 'kimi',
    name: 'Kimi',
    websiteUrl: 'https://www.kimi.com/code?aff=openmaic',
    subscribeUrls: {
      domestic: 'https://www.kimi.com/code?aff=openmaic',
      international: 'https://www.kimi.ai/code?aff=openmaic',
    },
    apiKeyPlaceholder: 'sk-...',
    icon: '/logos/kimi.png',
    category: 'token_plan',
    modalities: {
      llm: {
        providerId: 'kimi',
        baseUrl: 'https://api.kimi.com/coding/v1',
        apiFormat: 'openai',
        defaultModels: ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
        defaultModelId: 'kimi-for-coding',
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

/**
 * Fingerprint of everything a preset seeds (model catalogues, default model,
 * stage routes). Recorded on apply; when the shipped preset data changes, the
 * fingerprint changes and the app re-seeds enabled plans on next load — so
 * users who enabled a plan before a preset update still get the new defaults
 * without re-applying. Credentials are deliberately excluded: only the user's
 * key ever writes those.
 */
export function tokenPlanSeedFingerprint(preset: TokenPlanPreset): string {
  const m = preset.modalities;
  return JSON.stringify({
    llm: [m.llm?.defaultModelId, m.llm?.defaultModels, m.llm?.stageRoutes],
    image: m.image?.defaultModels,
    video: m.video?.defaultModels,
    tts: [m.tts?.defaultModelId, m.tts?.defaultModels],
  });
}
