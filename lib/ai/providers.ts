/**
 * Unified AI Provider Configuration
 *
 * Supports multiple AI providers through Vercel AI SDK:
 * - OpenAI (native)
 * - Anthropic Claude (native)
 * - Google Gemini (native)
 * - MiniMax (Anthropic-compatible, recommended by official)
 * - OpenAI-compatible providers (DeepSeek, Kimi, GLM, SiliconFlow, Doubao, etc.)
 *
 * Sources:
 * - https://platform.openai.com/docs/models
 * - https://platform.claude.com/docs/en/about-claude/models/overview
 * - https://ai.google.dev/gemini-api/docs/models
 * - https://api-docs.deepseek.com/quick_start/pricing
 * - https://platform.moonshot.cn/docs/pricing/chat
 * - https://platform.minimaxi.com/docs/guides/text-generation
 * - https://platform.minimax.io/docs/api-reference/text-anthropic-api
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
import { createLogger } from '@/lib/logger';
// NOTE: Do NOT import thinking-context.ts here — it uses node:async_hooks
// which is server-only, and this file is also used on the client via
// settings.ts. The thinking context is read from globalThis instead
// (set by thinking-context.ts at module load time on the server).

const log = createLogger('AIProviders');

// Re-export types for backward compatibility
export type { ProviderId, ProviderConfig, ModelInfo, ModelConfig };

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
        id: 'gpt-5.2',
        name: 'GPT-5.2',
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
        id: 'gpt-5.1',
        name: 'GPT-5.1',
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
        id: 'gpt-5',
        name: 'GPT-5',
        contextWindow: 400000,
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
        id: 'gpt-5-mini',
        name: 'GPT-5-mini',
        contextWindow: 128000,
        outputWindow: 4096,
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
        id: 'gpt-5-nano',
        name: 'GPT-5-nano',
        contextWindow: 128000,
        outputWindow: 4096,
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
        id: 'gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o-mini',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4-turbo',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'o4-mini',
        name: 'o4-mini',
        contextWindow: 200000,
        outputWindow: 100000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: false,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'o3',
        name: 'o3',
        contextWindow: 200000,
        outputWindow: 100000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: false,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'o3-mini',
        name: 'o3-mini',
        contextWindow: 200000,
        outputWindow: 100000,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: false,
            budgetAdjustable: true,
            defaultEnabled: true,
          },
        },
      },
      {
        id: 'o1',
        name: 'o1',
        contextWindow: 200000,
        outputWindow: 100000,
        capabilities: {
          streaming: true,
          tools: false,
          vision: false,
          thinking: {
            toggleable: false,
            budgetAdjustable: true,
            defaultEnabled: true,
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
        id: 'gemini-3-pro-preview',
        name: 'Gemini 3 Pro Preview',
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
    requiresApiKey: true,
    icon: '/logos/glm.svg',
    models: [
      // GLM-5 Series - Latest flagship model
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
      // GLM-4.5 Series - Cost-effective models
      {
        id: 'glm-4.5-air',
        name: 'GLM-4.5-Air',
        contextWindow: 128000,
        outputWindow: 96000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'glm-4.5-airx',
        name: 'GLM-4.5-AirX',
        contextWindow: 128000,
        outputWindow: 96000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'glm-4.5-flash',
        name: 'GLM-4.5-Flash',
        contextWindow: 128000,
        outputWindow: 96000,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'glm-4-long',
        name: 'GLM-4-Long',
        contextWindow: 1000000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: false },
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
        id: 'deepseek-chat',
        name: 'DeepSeek-Chat',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
          thinking: {
            toggleable: true,
            budgetAdjustable: false,
            defaultEnabled: false,
          },
        },
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek-Reasoner',
        contextWindow: 128000,
        outputWindow: 32000,
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

  kimi: {
    id: 'kimi',
    name: 'Kimi',
    type: 'openai',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    requiresApiKey: true,
    icon: '/logos/kimi.png',
    models: [
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
        id: 'kimi-k2-0905-preview',
        name: 'Kimi K2 0905 Preview',
        contextWindow: 256000,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
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
      {
        id: 'kimi-k2-turbo-preview',
        name: 'Kimi K2 Turbo Preview',
        contextWindow: 256000,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'moonshot-v1-128k',
        name: 'Moonshot V1 128K',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'moonshot-v1-32k',
        name: 'Moonshot V1 32K',
        contextWindow: 32000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'moonshot-v1-8k',
        name: 'Moonshot V1 8K',
        contextWindow: 8000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: false },
      },
    ],
  },

  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    type: 'anthropic',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic/v1',
    requiresApiKey: true,
    icon: '/logos/minimax.svg',
    models: [
      {
        id: 'MiniMax-M2.5',
        name: 'MiniMax M2.5',
        contextWindow: 204800,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'MiniMax-M2.1',
        name: 'MiniMax M2.1',
        contextWindow: 204800,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'MiniMax-M2.1-lightning',
        name: 'MiniMax M2.1 Lightning',
        contextWindow: 204800,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'MiniMax-M2',
        name: 'MiniMax M2',
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
        id: 'deepseek-ai/DeepSeek-V3',
        name: 'DeepSeek-V3',
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
        id: 'Qwen/Qwen2.5-72B-Instruct',
        name: 'Qwen2.5-72B-Instruct',
        contextWindow: 128000,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'Qwen/Qwen2.5-Coder-7B-Instruct',
        name: 'Qwen2.5-Coder-7B-Instruct',
        contextWindow: 128000,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'Qwen/Qwen2.5-7B-Instruct',
        name: 'Qwen2.5-7B-Instruct',
        contextWindow: 128000,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'Qwen/Qwen3-VL-32B-Instruct',
        name: 'Qwen3-VL-32B-Instruct',
        contextWindow: 256000,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      // MiniMax Series
      {
        id: 'MiniMaxAI/MiniMax-M2',
        name: 'MiniMax-M2',
        contextWindow: 204800,
        outputWindow: 131072,
        capabilities: { streaming: true, tools: true, vision: false },
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
        id: 'THUDM/GLM-Z1-Rumination-32B-0414',
        name: 'GLM-Z1-Rumination-32B',
        contextWindow: 32000,
        outputWindow: 16384,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'THUDM/GLM-4.1V-9B-Thinking',
        name: 'GLM-4.1V-9B-Thinking',
        contextWindow: 64000,
        outputWindow: 8192,
        capabilities: { streaming: true, tools: true, vision: true },
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

  grok: {
    id: 'grok',
    name: 'Grok',
    type: 'openai',
    defaultBaseUrl: 'https://api.x.ai/v1',
    requiresApiKey: true,
    icon: '/logos/grok.svg',
    models: [
      {
        id: 'grok-4.20-beta-0309-reasoning',
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
        id: 'grok-4.20-beta-0309-non-reasoning',
        name: 'Grok 4.20',
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
      {
        id: 'grok-4-fast-reasoning',
        name: 'Grok 4 Fast Reasoning',
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
        id: 'grok-4-fast-non-reasoning',
        name: 'Grok 4 Fast',
        contextWindow: 2000000,
        outputWindow: 131072,
        capabilities: { streaming: true, tools: true, vision: true },
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
        id: 'grok-4-0709',
        name: 'Grok 4',
        contextWindow: 256000,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'grok-3',
        name: 'Grok 3',
        contextWindow: 131072,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'grok-3-mini',
        name: 'Grok 3 Mini',
        contextWindow: 131072,
        outputWindow: 32768,
        capabilities: { streaming: true, tools: true, vision: false },
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
      // Common models pre-configured for selection
      {
        id: 'llama3.1',
        name: 'Llama 3.1',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'llama3.2',
        name: 'Llama 3.2',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'llama3.2-vision',
        name: 'Llama 3.2 Vision',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: true },
      },
      {
        id: 'gemma3',
        name: 'Gemma 3',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'qwen3',
        name: 'Qwen 3',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: { streaming: true, tools: true, vision: false },
      },
      {
        id: 'deepseek-r1',
        name: 'DeepSeek R1',
        contextWindow: 128000,
        outputWindow: 4096,
        capabilities: {
          streaming: true,
          tools: false,
          vision: false,
          thinking: {
            toggleable: false,
            budgetAdjustable: false,
            defaultEnabled: true,
          },
        },
      },
    ],
  },

  'llama-cpp': {
    id: 'llama-cpp',
    name: 'LLaMA.cpp',
    type: 'openai',
    defaultBaseUrl: 'http://localhost:8080/v1',
    requiresApiKey: false,
    icon: '/logos/llama-cpp.svg',
    models: [
      // LLaMA.cpp doesn't ship with pre-loaded models
      // Users can run any model they have loaded
      {
        id: 'default',
        name: 'Default Model',
        contextWindow: 8192,
        outputWindow: 2048,
        capabilities: { streaming: true, tools: false, vision: false },
      },
    ],
  },
};

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

/**
 * Return vendor-specific body params to inject for OpenAI-compatible providers.
 * Called from the custom fetch wrapper inside getModel().
 */
function getCompatThinkingBodyParams(
  providerId: ProviderId,
  config: ThinkingConfig,
): Record<string, unknown> | undefined {
  if (config.enabled === false) {
    switch (providerId) {
      // Kimi / DeepSeek / GLM use { thinking: { type: "disabled" } }
      case 'kimi':
      case 'deepseek':
      case 'glm':
        return { thinking: { type: 'disabled' } };
      // Qwen / SiliconFlow use { enable_thinking: false }
      case 'qwen':
      case 'siliconflow':
        return { enable_thinking: false };
      default:
        return undefined;
    }
  }
  if (config.enabled === true) {
    switch (providerId) {
      case 'kimi':
      case 'deepseek':
      case 'glm':
        return { thinking: { type: 'enabled' } };
      case 'qwen':
      case 'siliconflow':
        return { enable_thinking: true };
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * Get a configured language model instance with its info
 * Accepts individual parameters for flexibility and security
 */
export function getModel(config: ModelConfig): ModelWithInfo {
  // Get provider type and requiresApiKey, with fallback to registry
  let providerType = config.providerType;
  let requiresApiKey = config.requiresApiKey ?? true;

  if (!providerType) {
    const provider = getProviderConfig(config.providerId);
    if (provider) {
      providerType = provider.type;
      requiresApiKey = provider.requiresApiKey;
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
  const provider = getProviderConfig(config.providerId);
  const effectiveBaseUrl = config.baseUrl || provider?.defaultBaseUrl || undefined;

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
            const extra = getCompatThinkingBodyParams(providerId, thinking);
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
      model = openai.chat(config.modelId);
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
        // Dynamic require to avoid bundling undici on the client side
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ProxyAgent, fetch: undiciFetch } = require('undici');
        const agent = new ProxyAgent(config.proxy);
        googleOptions.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
          undiciFetch(input as string, {
            ...(init as Record<string, unknown>),
            dispatcher: agent,
          }).then((r: unknown) => r as Response)) as typeof fetch;
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
