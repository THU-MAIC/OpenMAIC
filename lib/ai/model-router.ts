/**
 * Model Routing Layer
 *
 * Routes inference requests to the appropriate provider based on:
 * 1. User BYOK (Bring Your Own Key) configuration
 * 2. Per-agent model preferences
 * 3. Server-side default model
 * 4. Fallback chain
 *
 * This layer is model-agnostic and supports OpenAI, Anthropic, Google,
 * DeepSeek, and any OpenAI-compatible provider.
 */

import type { ModelConfig, ProviderId } from '@/lib/types/provider';
import { createLogger } from '@/lib/logger';

const log = createLogger('ModelRouter');

/**
 * Model routing priority (highest to lowest):
 * 1. Explicit request config (per-API-call override)
 * 2. Agent model preference (agent-specific model)
 * 3. User BYOK settings (user's preferred provider + key)
 * 4. Server default model (DEFAULT_MODEL env var)
 * 5. First available configured provider
 */

export interface ModelRouteRequest {
  /** Explicit provider/model override */
  explicit?: {
    providerId: ProviderId;
    modelId: string;
  };
  /** Agent preference (from agent config) */
  agentPreference?: {
    providerId?: string;
    modelId?: string;
  };
  /** User BYOK config (from user settings) */
  userConfig?: {
    providerId: ProviderId;
    modelId: string;
    apiKey: string;
    baseUrl?: string;
  };
  /** Task type hint for intelligent routing */
  taskType?: 'generation' | 'chat' | 'grading' | 'embedding' | 'moderation';
}

export interface ModelRouteResult {
  config: ModelConfig;
  source: 'explicit' | 'agent-preference' | 'user-byok' | 'server-default' | 'fallback';
}

/**
 * Parse the DEFAULT_MODEL environment variable
 * Format: "provider:model-id" (e.g., "anthropic:claude-3-5-haiku-20241022")
 */
export function parseDefaultModel(): { providerId: ProviderId; modelId: string } | null {
  const defaultModel = process.env.DEFAULT_MODEL;
  if (!defaultModel) return null;

  const colonIndex = defaultModel.indexOf(':');
  if (colonIndex === -1) {
    log.warn(`Invalid DEFAULT_MODEL format "${defaultModel}" — expected "provider:model-id"`);
    return null;
  }

  const providerId = defaultModel.slice(0, colonIndex) as ProviderId;
  const modelId = defaultModel.slice(colonIndex + 1);

  if (!providerId || !modelId) return null;

  return { providerId, modelId };
}

/**
 * Get the API key for a provider from environment variables
 */
export function getProviderApiKey(providerId: string): string | undefined {
  const envKey = `${providerId.toUpperCase()}_API_KEY`;
  return process.env[envKey];
}

/**
 * Get the base URL for a provider from environment variables
 */
export function getProviderBaseUrl(providerId: string): string | undefined {
  const envKey = `${providerId.toUpperCase()}_BASE_URL`;
  return process.env[envKey];
}

/**
 * Route a model request to the best available provider
 */
export function routeModel(request: ModelRouteRequest): ModelRouteResult | null {
  // 1. Explicit override
  if (request.explicit) {
    const apiKey = getProviderApiKey(request.explicit.providerId);
    if (apiKey) {
      log.info(
        `Routing to explicit provider: ${request.explicit.providerId}:${request.explicit.modelId}`,
      );
      return {
        config: {
          providerId: request.explicit.providerId,
          modelId: request.explicit.modelId,
          apiKey,
          baseUrl: getProviderBaseUrl(request.explicit.providerId),
        },
        source: 'explicit',
      };
    }
  }

  // 2. Agent preference
  if (request.agentPreference?.providerId && request.agentPreference?.modelId) {
    const providerId = request.agentPreference.providerId as ProviderId;
    const apiKey = getProviderApiKey(providerId);
    if (apiKey) {
      log.info(`Routing to agent preference: ${providerId}:${request.agentPreference.modelId}`);
      return {
        config: {
          providerId,
          modelId: request.agentPreference.modelId,
          apiKey,
          baseUrl: getProviderBaseUrl(providerId),
        },
        source: 'agent-preference',
      };
    }
  }

  // 3. User BYOK config
  if (request.userConfig) {
    log.info(
      `Routing to user BYOK: ${request.userConfig.providerId}:${request.userConfig.modelId}`,
    );
    return {
      config: {
        providerId: request.userConfig.providerId,
        modelId: request.userConfig.modelId,
        apiKey: request.userConfig.apiKey,
        baseUrl: request.userConfig.baseUrl,
      },
      source: 'user-byok',
    };
  }

  // 4. Server default
  const defaultModel = parseDefaultModel();
  if (defaultModel) {
    const apiKey = getProviderApiKey(defaultModel.providerId);
    if (apiKey) {
      log.info(`Routing to server default: ${defaultModel.providerId}:${defaultModel.modelId}`);
      return {
        config: {
          providerId: defaultModel.providerId,
          modelId: defaultModel.modelId,
          apiKey,
          baseUrl: getProviderBaseUrl(defaultModel.providerId),
        },
        source: 'server-default',
      };
    }
  }

  // 5. Fallback: first available provider
  const providers: ProviderId[] = [
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'qwen',
    'kimi',
    'minimax',
    'glm',
    'siliconflow',
    'doubao',
  ];

  for (const providerId of providers) {
    const apiKey = getProviderApiKey(providerId);
    if (apiKey) {
      log.info(`Routing to fallback provider: ${providerId}`);
      return {
        config: {
          providerId,
          modelId: getDefaultModelForProvider(providerId),
          apiKey,
          baseUrl: getProviderBaseUrl(providerId),
        },
        source: 'fallback',
      };
    }
  }

  log.warn('No available provider found for model routing');
  return null;
}

/**
 * Get the default model ID for a provider
 */
function getDefaultModelForProvider(providerId: ProviderId): string {
  const defaults: Record<string, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-20241022',
    google: 'gemini-2.0-flash',
    deepseek: 'deepseek-chat',
    qwen: 'qwen-plus',
    kimi: 'moonshot-v1-auto',
    minimax: 'MiniMax-Text-01',
    glm: 'glm-4-flash',
    siliconflow: 'deepseek-ai/DeepSeek-V3',
    doubao: 'doubao-1.5-pro-32k',
  };
  const modelId = defaults[providerId];
  if (!modelId) {
    log.warn(`No default model configured for provider "${providerId}"`);
  }
  return modelId ?? 'gpt-4o-mini';
}
