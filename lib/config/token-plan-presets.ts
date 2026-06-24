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
    // Volcengine Ark Coding Plan. The plan's `ark-`-prefixed keys authenticate
    // only against the /api/coding/v3 gateway (OpenAI-compatible); the general
    // /api/v3 endpoint rejects them as "API key format is incorrect".
    id: 'volcengine-ark',
    name: '火山方舟 Volcengine Ark',
    websiteUrl: 'https://console.volcengine.com/ark',
    icon: '/logos/volcengine.svg',
    category: 'token_plan',
    modalities: {
      llm: {
        providerId: 'doubao',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        apiFormat: 'openai',
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
