/**
 * Token Plan / provider presets.
 *
 * Follows cc-switch's `ProviderPreset` model: a user who knows their vendor picks
 * a preset (which auto-fills baseURL, protocol, and the optional model-list URL);
 * otherwise they use the Custom tab. This is intentionally data-driven — adding a
 * vendor/token-plan is one entry here, no code changes (see plan's extensibility
 * principle). Probing the model list and computing usage stays vendor-agnostic.
 */

import type { ProviderType } from '@/lib/types/provider';

/** Loose grouping for the preset picker UI. */
export type PresetCategory = 'official' | 'aggregator' | 'token_plan' | 'third_party';

export interface TokenPlanPreset {
  /** Stable id (used as React key and to derive the custom provider id). */
  id: string;
  /** Display name. */
  name: string;
  /** Optional vendor/docs link. */
  websiteUrl?: string;
  /** Default API base URL filled into the form. */
  baseUrl: string;
  /** API protocol — maps to the app's providerType. */
  apiFormat: ProviderType;
  /** Optional explicit /models URL override (when the vendor's path is non-standard). */
  modelsUrl?: string;
  /** Whether an API key is required (almost always true). */
  requiresApiKey: boolean;
  /** Icon path under /public (optional). */
  icon?: string;
  category: PresetCategory;
}

/**
 * Built-in presets. baseURL/protocol/modelsUrl reflect each vendor's
 * OpenAI/Anthropic-compatible endpoint. Balance support is detected at query
 * time (lib/usage/balance-providers.ts), so no balance config is needed here.
 */
export const TOKEN_PLAN_PRESETS: TokenPlanPreset[] = [
  // ── Aggregators / gateways ────────────────────────────────────────────────
  {
    id: 'openrouter',
    name: 'OpenRouter',
    websiteUrl: 'https://openrouter.ai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiFormat: 'openai',
    requiresApiKey: true,
    icon: '/logos/openrouter.svg',
    category: 'aggregator',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow 硅基流动',
    websiteUrl: 'https://siliconflow.cn',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiFormat: 'openai',
    requiresApiKey: true,
    icon: '/logos/siliconflow.svg',
    category: 'aggregator',
  },

  // ── Token plans (prepaid quota) ───────────────────────────────────────────
  {
    id: 'huawei-token-plan',
    name: '华为云 MaaS (Token Plan)',
    websiteUrl: 'https://support.huaweicloud.com/Token-plan-maas/',
    baseUrl: 'https://api.modelarts-maas.com/plan/v2',
    apiFormat: 'openai',
    requiresApiKey: true,
    category: 'token_plan',
  },
  {
    id: 'minimax-anthropic',
    name: 'MiniMax (Claude 协议)',
    websiteUrl: 'https://platform.minimaxi.com',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    apiFormat: 'anthropic',
    requiresApiKey: true,
    icon: '/logos/minimax.svg',
    category: 'token_plan',
  },
  {
    id: 'xiaomi-token-plan',
    name: '小米 MiMo (Token Plan)',
    websiteUrl: 'https://xiaomimimo.com',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    apiFormat: 'openai',
    requiresApiKey: true,
    icon: '/logos/xiaomi.svg',
    category: 'token_plan',
  },

  // ── Vendor-direct (OpenAI-compatible) ─────────────────────────────────────
  {
    id: 'deepseek',
    name: 'DeepSeek',
    websiteUrl: 'https://platform.deepseek.com',
    baseUrl: 'https://api.deepseek.com',
    apiFormat: 'openai',
    requiresApiKey: true,
    icon: '/logos/deepseek.svg',
    category: 'third_party',
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    websiteUrl: 'https://bigmodel.cn',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiFormat: 'openai',
    requiresApiKey: true,
    icon: '/logos/glm.svg',
    category: 'third_party',
  },
  {
    id: 'qwen',
    name: '通义千问 Qwen',
    websiteUrl: 'https://bailian.console.aliyun.com',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiFormat: 'openai',
    requiresApiKey: true,
    icon: '/logos/qwen.svg',
    category: 'third_party',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    websiteUrl: 'https://cloud.tencent.com/product/hunyuan',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    apiFormat: 'openai',
    requiresApiKey: true,
    icon: '/logos/hunyuan.svg',
    category: 'third_party',
  },
  {
    id: 'doubao',
    name: '豆包 / 火山方舟',
    websiteUrl: 'https://www.volcengine.com/product/ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiFormat: 'openai',
    requiresApiKey: true,
    icon: '/logos/doubao.svg',
    category: 'third_party',
  },
];

/** Preset category display order + label keys. */
export const PRESET_CATEGORY_ORDER: PresetCategory[] = [
  'token_plan',
  'aggregator',
  'third_party',
  'official',
];
