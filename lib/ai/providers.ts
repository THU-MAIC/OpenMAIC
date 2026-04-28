/**
 * Unified AI Provider Configuration
 *
 * Supports multiple AI providers through Vercel AI SDK:
 * - OpenAI (native)
 * - Anthropic Claude (native)
 * - Google Gemini (native)
 * - MiniMax (Anthropic-compatible, recommended by official)
 * - OpenAI-compatible providers (DeepSeek, Qwen, Kimi, GLM, SiliconFlow, Doubao, Tencent, Xiaomi, etc.)
 *
 * Sources:
 * - https://platform.openai.com/docs/models
 * - https://platform.claude.com/docs/en/about-claude/models/overview
 * - https://ai.google.dev/gemini-api/docs/models
 * - https://api-docs.deepseek.com/quick_start/pricing
 * - https://platform.moonshot.cn/docs/pricing/chat
 * - https://platform.minimaxi.com/docs/guides/text-generation
 * - https://platform.minimaxi.com/docs/api-reference/text-anthropic-api
 * - https://docs.bigmodel.cn/cn/guide/start/model-overview
 * - https://help.aliyun.com/zh/model-studio/models (Qwen/DashScope)
 * - https://siliconflow.cn/models
 * - https://siliconflow.cn/pricing
 * - https://www.volcengine.com/docs/82379/1330310
 */

import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import type {
  ProviderId,
  ProviderConfig,
  ModelInfo,
  ModelConfig,
  ThinkingConfig,
} from '@/lib/types/provider';
import { applyModelMetadata, getCatalogThinkingCapability } from './model-metadata';
import { getThinkingMode, pickThinkingBudget } from './thinking-config';
import { createLogger } from '@/lib/logger';
// NOTE: Do NOT import thinking-context.ts here — it uses node:async_hooks
// which is server-only, and this file is also used on the client via
// settings.ts. The thinking context is read from globalThis instead
// (set by thinking-context.ts at module load time on the server).

const log = createLogger('AIProviders');

// Re-export types for backward compatibility
export type { ProviderId, ProviderConfig, ModelInfo, ModelConfig };

/** Provider IDs whose logos are monochrome-dark and need `dark:invert` in dark mode */
export const MONO_LOGO_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'openrouter', 'ollama']);

/**
 * Provider registry
 */
export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    icon: '/logos/openai.svg',
    models: [
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        contextWindow: 1050000,
        outputWindow: 128000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: false,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'gpt-5.4-pro',
        name: 'GPT-5.4 Pro',
        contextWindow: 1050000,
        outputWindow: 128000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        contextWindow: 1050000,
        outputWindow: 128000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'gpt-5.4-mini',
        name: 'GPT-5.4 Mini',
        contextWindow: 400000,
        outputWindow: 128000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'gpt-5.4-nano',
        name: 'GPT-5.4 Nano',
        contextWindow: 400000,
        outputWindow: 128000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
    ],
  },

  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    type: 'anthropic',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    icon: '/logos/claude.svg',
    models: [
      {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        contextWindow: 1000000,
        outputWindow: 128000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        contextWindow: 200000,
        outputWindow: 128000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        contextWindow: 200000,
        outputWindow: 128000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        contextWindow: 200000,
        outputWindow: 64000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        contextWindow: 200000,
        outputWindow: 64000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
    ],
  },

  google: {
    id: 'google',
    name: 'Gemini',
    type: 'google',
    requiresApiKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    icon: '/logos/gemini.svg',
    models: [
      {
        id: 'gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro Preview',
        contextWindow: 1048576,
        outputWindow: 65536,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: false,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash Preview',
        contextWindow: 1048576,
        outputWindow: 65536,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: false,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        contextWindow: 1048576,
        outputWindow: 65536,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash Lite',
        contextWindow: 1048576,
        outputWindow: 65536,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        contextWindow: 1048576,
        outputWindow: 65536,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: false,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
    ],
  },

  glm: {
    id: 'glm',
    name: 'GLM',
    type: 'openai',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    alternateBaseUrls: [
      { label: 'settings.baseUrlRegion.china', url: 'https://open.bigmodel.cn/api/paas/v4' },
      { label: 'settings.baseUrlRegion.international', url: 'https://api.z.ai/api/paas/v4' },
    ],
    requiresApiKey: true,
    icon: '/logos/glm.svg',
    models: [
      // GLM-5.1 Series - Latest flagship model
      {
        id: 'glm-5.1',
        name: 'GLM-5.1',
        contextWindow: 200000,
        outputWindow: 128000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'glm-5v-turbo',
        name: 'GLM-5V-Turbo',
        contextWindow: 200000,
        outputWindow: 128000,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      // GLM-5 Series
      {
        id: 'glm-5',
        name: 'GLM-5',
        contextWindow: 200000,
        outputWindow: 128000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      // GLM-4.7 Series
      {
        id: 'glm-4.7',
        name: 'GLM-4.7',
        contextWindow: 200000,
        outputWindow: 128000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'glm-4.7-flashx',
        name: 'GLM-4.7-FlashX',
        contextWindow: 200000,
        outputWindow: 128000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'glm-4.7-flash',
        name: 'GLM-4.7-Flash',
        contextWindow: 200000,
        outputWindow: 128000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      // GLM-4.6 Series - Advanced coding & reasoning
      {
        id: 'glm-4.6',
        name: 'GLM-4.6',
        contextWindow: 200000,
        outputWindow: 128000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'glm-4.6v',
        name: 'GLM-4.6V',
        contextWindow: 128000,
        outputWindow: 32000,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'glm-4.6v-flash',
        name: 'GLM-4.6V-Flash',
        contextWindow: 128000,
        outputWindow: 32000,
        capabilities: { streaming: true, tools: true, vision: true },
      },
    ],
  },

  qwen: {
    id: 'qwen',
    name: 'Qwen',
    type: 'openai',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresApiKey: true,
    icon: '/logos/qwen.svg',
    models: [
      {
        id: 'qwen3.6-max-preview',
        name: 'Qwen3.6 Max Preview',
        contextWindow: 256000,
        outputWindow: 64000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'qwen3.6-plus',
        name: 'Qwen3.6 Plus',
        contextWindow: 1000000,
        outputWindow: 64000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'qwen3.6-plus-2026-04-02',
        name: 'Qwen3.6 Plus (2026-04-02)',
        contextWindow: 1000000,
        outputWindow: 64000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'qwen3.6-flash',
        name: 'Qwen3.6 Flash',
        contextWindow: 1000000,
        outputWindow: 64000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'qwen3.6-flash-2026-04-16',
        name: 'Qwen3.6 Flash (2026-04-16)',
        contextWindow: 1000000,
        outputWindow: 64000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'qwen3.6-35b-a3b',
        name: 'Qwen3.6 35B A3B',
        contextWindow: 262144,
        outputWindow: 64000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'qwen3.5-flash',
        name: 'Qwen3.5 Flash',
        contextWindow: 1000000,
        outputWindow: 65536,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'qwen3.5-plus',
        name: 'Qwen3.5 Plus',
        contextWindow: 1000000,
        outputWindow: 65536,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'qwen3-max',
        name: 'Qwen3 Max',
        contextWindow: 262144,
        outputWindow: 65536,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'qwen3-vl-plus',
        name: 'Qwen3 VL Plus',
        contextWindow: 262144,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: true },
      },
    ],
  },

  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    requiresApiKey: true,
    icon: '/logos/deepseek.svg',
    models: [
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 1048576,
        outputWindow: 393216,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        contextWindow: 1048576,
        outputWindow: 393216,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: true,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
    ],
  },

  kimi: {
    id: 'kimi',
    name: 'Kimi',
    type: 'openai',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    alternateBaseUrls: [
      { label: 'settings.baseUrlRegion.china', url: 'https://api.moonshot.cn/v1' },
      { label: 'settings.baseUrlRegion.international', url: 'https://api.moonshot.ai/v1' },
    ],
    requiresApiKey: true,
    icon: '/logos/kimi.png',
    models: [
      {
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        contextWindow: 256000,
        outputWindow: 8192,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: false,
            defaultEnabled: true,
          },
        },
      },
      // K2.5 Series (2026) - 1T MoE, 32B active parameters
      {
        id: 'kimi-k2.5',
        name: 'Kimi K2.5',
        contextWindow: 256000,
        outputWindow: 8192,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: false,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'kimi-k2-thinking',
        name: 'Kimi K2 Thinking',
        contextWindow: 256000,
        outputWindow: 8192,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: true,
            budgetAdjustable: false,
            defaultEnabled: true,
          },
        },
      },
    ],
  },

  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    type: 'anthropic',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic/v1',
    alternateBaseUrls: [
      { label: 'settings.baseUrlRegion.china', url: 'https://api.minimaxi.com/anthropic/v1' },
      { label: 'settings.baseUrlRegion.international', url: 'https://api.minimax.io/anthropic/v1' },
    ],
    requiresApiKey: true,
    icon: '/logos/minimax.svg',
    models: [
      {
        id: 'MiniMax-M2.7',
        name: 'MiniMax M2.7',
        contextWindow: 204800,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
    ],
  },

  siliconflow: {
    id: 'siliconflow',
    name: '硅基流动',
    type: 'openai',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    requiresApiKey: true,
    icon: '/logos/siliconflow.svg',
    models: [
      // DeepSeek Series
      {
        id: 'deepseek-ai/DeepSeek-V3.2',
        name: 'DeepSeek-V3.2',
        contextWindow: 128000,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'deepseek-ai/DeepSeek-R1',
        name: 'DeepSeek-R1',
        contextWindow: 128000,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        name: 'DeepSeek-R1-Distill-Qwen-7B',
        contextWindow: 128000,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      // Qwen Series
      {
        id: 'Qwen/Qwen3-VL-32B-Instruct',
        name: 'Qwen3-VL-32B-Instruct',
        contextWindow: 256000,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      // Kimi Series
      {
        id: 'Pro/moonshotai/Kimi-K2.5',
        name: 'Kimi-K2.5',
        contextWindow: 256000,
        outputWindow: 96000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      // GLM Series
      {
        id: 'THUDM/GLM-4.1V-9B-Thinking',
        name: 'GLM-4.1V-9B-Thinking',
        contextWindow: 64000,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'THUDM/GLM-Z1-Rumination-32B-0414',
        name: 'GLM-Z1-Rumination-32B',
        contextWindow: 32000,
        outputWindow: 16384,
        capabilities: { streaming: true, tools: true, vision: false },
      },
    ],
  },

  doubao: {
    id: 'doubao',
    name: '豆包',
    type: 'openai',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    requiresApiKey: true,
    icon: '/logos/doubao.svg',
    models: [
      {
        id: 'doubao-seed-2-0-pro-260215',
        name: 'Doubao Seed 2.0 Pro',
        contextWindow: 128000,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'doubao-seed-2-0-lite-260215',
        name: 'Doubao Seed 2.0 Lite',
        contextWindow: 128000,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'doubao-seed-2-0-mini-260215',
        name: 'Doubao Seed 2.0 Mini',
        contextWindow: 128000,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'doubao-seed-1-8-251228',
        name: 'Doubao Seed 1.8',
        contextWindow: 128000,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: true },
      },
    ],
  },

  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    icon: '/logos/openrouter.svg',
    models: [
      {
        id: 'deepseek/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 1048576,
        outputWindow: 131072,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        contextWindow: 1048576,
        outputWindow: 131072,
        capabilities: { streaming: true, tools: true, vision: false },
      },
    ],
  },

  grok: {
    id: 'grok',
    name: 'Grok',
    type: 'openai',
    defaultBaseUrl: 'https://api.x.ai/v1',
    requiresApiKey: true,
    icon: '/logos/grok.svg',
    models: [
      {
        id: 'grok-4.20-reasoning',
        name: 'Grok 4.20 Reasoning',
        contextWindow: 2000000,
        outputWindow: 131072,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: false,
            budgetAdjustable: false,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'grok-4.20',
        name: 'Grok 4.20',
        contextWindow: 2000000,
        outputWindow: 131072,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'grok-4.20-multi-agent',
        name: 'Grok 4.20 Multi-Agent',
        contextWindow: 2000000,
        outputWindow: 131072,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: false,
            budgetAdjustable: false,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'grok-4-1-fast-reasoning',
        name: 'Grok 4.1 Fast Reasoning',
        contextWindow: 2000000,
        outputWindow: 131072,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: false,
            budgetAdjustable: false,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'grok-4-1-fast-non-reasoning',
        name: 'Grok 4.1 Fast',
        contextWindow: 2000000,
        outputWindow: 131072,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'grok-code-fast-1',
        name: 'Grok Code Fast',
        contextWindow: 256000,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: false },
      },
    ],
  },

  'tencent-hunyuan': {
    id: 'tencent-hunyuan',
    name: 'Tencent Hunyuan',
    type: 'openai',
    defaultBaseUrl: 'https://tokenhub.tencentmaas.com/v1',
    alternateBaseUrls: [
      { label: 'settings.baseUrlRegion.china', url: 'https://tokenhub.tencentmaas.com/v1' },
      {
        label: 'settings.baseUrlRegion.international',
        url: 'https://tokenhub-intl.tencentmaas.com/v1',
      },
    ],
    requiresApiKey: true,
    icon: '/logos/hunyuan.svg',
    models: [
      {
        id: 'hy3-preview',
        name: 'Tencent Hy3 Preview',
        contextWindow: 256000,
        outputWindow: 64000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
    ],
  },

  xiaomi: {
    id: 'xiaomi',
    name: 'Xiaomi MiMo',
    type: 'openai',
    defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    requiresApiKey: true,
    icon: '/logos/xiaomi.svg',
    models: [
      {
        id: 'mimo-v2.5-pro',
        name: 'MiMo V2.5 Pro',
        contextWindow: 1048576,
        outputWindow: 131072,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: true,
            budgetAdjustable: false,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'mimo-v2.5',
        name: 'MiMo V2.5',
        contextWindow: 1048576,
        outputWindow: 131072,
        capabilities: {
          streaming: true,
          tools: true,
          vision: true,
          thinking: {
            toggleable: true,
            budgetAdjustable: false,
            defaultEnabled: true,
          },
        },
      },
    ],
  },

  ollama: {
    id: 'ollama',
    name: 'Ollama',
    type: 'openai',
    defaultBaseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    icon: '/logos/ollama.svg',
    models: [
      {
        id: 'llama3.3',
        name: 'Llama 3.3 70B',
        contextWindow: 131072,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'gemma3',
        name: 'Gemma 3 12B',
        contextWindow: 131072,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'deepseek-r1',
        name: 'DeepSeek R1',
        contextWindow: 131072,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: false, vision: false },
      },
    ],
  },
};

applyModelMetadata(PROVIDERS);

/**
 * Get provider config (from built-in or unified config in localStorage)
 */
function getProviderConfig(providerId: ProviderId): ProviderConfig | null {
  // Check built-in providers first
  if (PROVIDERS[providerId]) {
    return PROVIDERS[providerId];
  }

  // Check unified providersConfig in localStorage (browser only)
  if (typeof window !== 'undefined') {
    try {
      const storedConfig = localStorage.getItem('providersConfig');
      if (storedConfig) {
        const config = JSON.parse(storedConfig);
        const providerSettings = config[providerId];
        if (providerSettings) {
          return {
            id: providerId,
            name: providerSettings.name,
            type: providerSettings.type,
            defaultBaseUrl: providerSettings.defaultBaseUrl,
            icon: providerSettings.icon,
            requiresApiKey: providerSettings.requiresApiKey,
            models: providerSettings.models,
          };
        }
      }
    } catch (e) {
      log.error('Failed to load provider config:', e);
    }
  }

  return null;
}

/**
 * Model instance with its configuration info
 */
export interface ModelWithInfo {
  model: LanguageModel;
  modelInfo: ModelInfo | null;
}

function getCompatThinkingBodyParams(
  providerId: ProviderId,
  modelId: string,
  config: ThinkingConfig,
): Record<string, unknown> | undefined {
  const capability = getCatalogThinkingCapability(providerId, modelId);
  if (!capability || capability.control === 'none') return undefined;

  const mode = getThinkingMode(config);
  const budget = pickThinkingBudget(capability, config);

  switch (capability.requestAdapter) {
    case 'kimi':
    case 'glm':
    case 'xiaomi':
      if (mode === 'disabled') return { thinking: { type: 'disabled' } };
      if (mode === 'enabled') return { thinking: { type: 'enabled' } };
      return undefined;

    case 'deepseek': {
      if (mode === 'disabled' || config.effort === 'none') {
        return { thinking: { type: 'disabled' } };
      }

      const effort = config.effort === 'max' || config.effort === 'xhigh' ? 'max' : 'high';
      return {
        thinking: { type: 'enabled' },
        reasoning_effort: effort,
      };
    }

    case 'qwen': {
      if (mode === 'disabled') return { enable_thinking: false };
      const body: Record<string, unknown> = {};
      if (mode === 'enabled') body.enable_thinking = true;
      if (budget !== undefined) body.thinking_budget = budget;
      return Object.keys(body).length > 0 ? body : undefined;
    }

    case 'siliconflow': {
      const body: Record<string, unknown> = {};
      if (capability.control === 'toggle-budget') {
        if (mode === 'disabled') body.enable_thinking = false;
        if (mode === 'enabled') body.enable_thinking = true;
      }
      if (budget !== undefined) body.thinking_budget = budget;
      return Object.keys(body).length > 0 ? body : undefined;
    }

    case 'doubao': {
      if (capability.control === 'effort') {
        const effort =
          mode === 'disabled'
            ? 'minimal'
            : config.effort && capability.effortValues?.includes(config.effort)
              ? config.effort
              : mode === 'enabled'
                ? capability.defaultEffort
                : undefined;
        return effort ? { reasoning_effort: effort } : undefined;
      }
      if (mode === 'auto') return { thinking: { type: 'auto' } };
      if (mode === 'disabled') return { thinking: { type: 'disabled' } };
      if (mode === 'enabled') return { thinking: { type: 'enabled' } };
      return undefined;
    }

    case 'openrouter': {
      const reasoning: Record<string, unknown> = {};
      if (mode === 'disabled') reasoning.enabled = false;
      if (mode === 'enabled') reasoning.enabled = true;
      if (config.effort) reasoning.effort = config.effort;
      if (budget !== undefined) reasoning.max_tokens = budget;
      if (typeof config.excludeReasoningOutput === 'boolean') {
        reasoning.exclude = config.excludeReasoningOutput;
      }
      return Object.keys(reasoning).length > 0 ? { reasoning } : undefined;
    }

    case 'hunyuan': {
      let reasoningEffort: 'no_think' | 'low' | 'high' | undefined;
      if (mode === 'disabled' || config.effort === 'none') {
        reasoningEffort = 'no_think';
      } else if (config.effort === 'high' || config.effort === 'max' || config.effort === 'xhigh') {
        reasoningEffort = 'high';
      } else if (
        config.effort === 'low' ||
        config.effort === 'medium' ||
        config.effort === 'minimal'
      ) {
        reasoningEffort = 'low';
      } else if (mode === 'enabled') {
        reasoningEffort = capability.defaultEffort === 'high' ? 'high' : 'low';
      }
      return reasoningEffort
        ? { chat_template_kwargs: { reasoning_effort: reasoningEffort } }
        : undefined;
    }

    default:
      return undefined;
  }
}

function normalizeMiniMaxAnthropicBaseUrl(
  providerId: ProviderId,
  baseUrl?: string,
): string | undefined {
  if (providerId !== 'minimax' || !baseUrl) {
    return baseUrl;
  }

  const trimmed = baseUrl.replace(/\/$/, '');
  if (trimmed.endsWith('/anthropic/v1')) {
    return trimmed;
  }
  if (trimmed.endsWith('/anthropic')) {
    return `${trimmed}/v1`;
  }
  return `${trimmed}/anthropic/v1`;
}

function shouldUseOpenAIResponsesApi(providerId: ProviderId, modelId: string): boolean {
  if (providerId !== 'openai') return false;

  return (
    /^gpt-5\.\d+-pro(?:-|$)/.test(modelId) ||
    /^gpt-5\.5(?:-|$)/.test(modelId) ||
    /^gpt-5\.[3-9]-codex(?:-|$)/.test(modelId)
  );
}

/** Returns true if the provider requires an API key (defaults to true for unknown providers). */
export function isProviderKeyRequired(providerId: string): boolean {
  return getProviderConfig(providerId as ProviderId)?.requiresApiKey ?? true;
}

/**
 * Get a configured language model instance with its info
 * Accepts individual parameters for flexibility and security
 */
export function getModel(config: ModelConfig): ModelWithInfo {
  // providerType can come from client for custom providers; fall back to registry.
  let providerType = config.providerType;
  const provider = getProviderConfig(config.providerId);
  const requiresApiKey = provider?.requiresApiKey ?? true;

  if (!providerType) {
    if (provider) {
      providerType = provider.type;
    } else {
      throw new Error(`Unknown provider: ${config.providerId}. Please provide providerType.`);
    }
  }

  // Validate API key if required
  if (requiresApiKey && !config.apiKey) {
    throw new Error(`API key required for provider: ${config.providerId}`);
  }

  // Use provided API key, or empty string for providers that don't require one
  const effectiveApiKey = config.apiKey || '';

  // Resolve base URL: explicit > provider default > SDK default
  const effectiveBaseUrl = normalizeMiniMaxAnthropicBaseUrl(
    config.providerId,
    config.baseUrl || provider?.defaultBaseUrl || undefined,
  );

  let model: LanguageModel;

  switch (providerType) {
    case 'openai': {
      const openaiOptions: Parameters<typeof createOpenAI>[0] = {
        apiKey: effectiveApiKey,
        baseURL: effectiveBaseUrl,
      };

      // For OpenAI-compatible providers (not native OpenAI), add a fetch
      // wrapper that injects vendor-specific thinking params into the HTTP
      // body. The thinking config is read from AsyncLocalStorage, set by
      // callLLM / streamLLM at call time.
      if (config.providerId !== 'openai') {
        const providerId = config.providerId;
        openaiOptions.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
          // Read thinking config from globalThis (set by thinking-context.ts)
          const thinkingCtx = (globalThis as Record<string, unknown>).__thinkingContext as
            | { getStore?: () => unknown }
            | undefined;
          const thinking = thinkingCtx?.getStore?.() as ThinkingConfig | undefined;
          if (thinking && init?.body && typeof init.body === 'string') {
            const extra = getCompatThinkingBodyParams(providerId, config.modelId, thinking);
            if (extra) {
              try {
                const body = JSON.parse(init.body);
                Object.assign(body, extra);
                init = { ...init, body: JSON.stringify(body) };
              } catch {
                /* leave body as-is */
              }
            }
          }
          return globalThis.fetch(url, init);
        };
      }

      const openai = createOpenAI(openaiOptions);
      model = shouldUseOpenAIResponsesApi(config.providerId, config.modelId)
        ? openai.responses(config.modelId)
        : openai.chat(config.modelId);
      break;
    }

    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: effectiveApiKey,
        baseURL: effectiveBaseUrl,
      });
      model = anthropic.chat(config.modelId);
      break;
    }

    case 'google': {
      const googleOptions: Parameters<typeof createGoogleGenerativeAI>[0] = {
        apiKey: effectiveApiKey,
        baseURL: effectiveBaseUrl,
      };
      if (config.proxy) {
        const proxy = config.proxy;
        let agent: unknown;
        googleOptions.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const { ProxyAgent, fetch: undiciFetch } = (await import(
            /* webpackIgnore: true */ 'undici'
          )) as {
            ProxyAgent: new (proxyUrl: string) => unknown;
            fetch: (
              input: string | URL | Request,
              init?: Record<string, unknown>,
            ) => Promise<unknown>;
          };
          agent ??= new ProxyAgent(proxy);
          const response = await undiciFetch(input, {
            ...(init as Record<string, unknown>),
            dispatcher: agent,
          });
          return response as Response;
        }) as typeof fetch;
      }
      const google = createGoogleGenerativeAI(googleOptions);
      model = google.chat(config.modelId);
      break;
    }

    default:
      throw new Error(`Unsupported provider type: ${providerType}`);
  }

  // Look up model info from the provider registry
  const modelInfo = provider?.models.find((m) => m.id === config.modelId) || null;

  return { model, modelInfo };
}

/**
 * Parse model string in format "providerId:modelId" or just "modelId" (defaults to OpenAI)
 */
export function parseModelString(modelString: string): {
  providerId: ProviderId;
  modelId: string;
} {
  // Split only on the first colon to handle model IDs that contain colons
  const colonIndex = modelString.indexOf(':');

  if (colonIndex > 0) {
    return {
      providerId: modelString.slice(0, colonIndex) as ProviderId,
      modelId: modelString.slice(colonIndex + 1),
    };
  }

  // Default to OpenAI for backward compatibility
  return {
    providerId: 'openai',
    modelId: modelString,
  };
}

/**
 * Get all available models grouped by provider
 */
export function getAllModels(): {
  provider: ProviderConfig;
  models: ModelInfo[];
}[] {
  return Object.values(PROVIDERS).map((provider) => ({
    provider,
    models: provider.models,
  }));
}

/**
 * Get provider by ID
 */
export function getProvider(providerId: ProviderId): ProviderConfig | undefined {
  return PROVIDERS[providerId];
}

/**
 * Get model info
 */
export function getModelInfo(providerId: ProviderId, modelId: string): ModelInfo | undefined {
  const provider = PROVIDERS[providerId];
  return provider?.models.find((m) => m.id === modelId);
}
