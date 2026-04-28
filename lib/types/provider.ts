/**
 * AI Provider Type Definitions
 */

/**
 * Built-in provider IDs
 */
export type BuiltInProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'qwen'
  | 'kimi'
  | 'minimax'
  | 'glm'
  | 'siliconflow'
  | 'doubao'
  | 'openrouter'
  | 'grok'
  | 'tencent-hunyuan'
  | 'xiaomi'
  | 'ollama';

/**
 * Provider ID (built-in or custom)
 * For custom providers, use string literals prefixed with "custom-"
 */
export type ProviderId = BuiltInProviderId | `custom-${string}`;

/**
 * Provider API types
 */
export type ProviderType = 'openai' | 'anthropic' | 'google';

export type ThinkingControlType =
  | 'none'
  | 'toggle'
  | 'toggle-budget'
  | 'effort'
  | 'level'
  | 'mode'
  | 'budget-only';

export type ThinkingMode = 'default' | 'disabled' | 'enabled' | 'auto';
export type ThinkingEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export type ThinkingRequestAdapter =
  | 'none'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'qwen'
  | 'deepseek'
  | 'kimi'
  | 'glm'
  | 'siliconflow'
  | 'doubao'
  | 'openrouter'
  | 'hunyuan'
  | 'xiaomi';

/**
 * Describes a model's thinking/reasoning API control capability.
 * Models without thinking support simply omit this field from capabilities.
 */
export interface ThinkingCapability {
  /** Which UI control should be rendered for this model. */
  control?: ThinkingControlType;
  /** Which provider-specific adapter maps the unified config to request params. */
  requestAdapter?: ThinkingRequestAdapter;
  /** Default mode when OpenMAIC does not send an explicit config. */
  defaultMode?: ThinkingMode;
  /** Allowed effort values for effort-based models. */
  effortValues?: ThinkingEffort[];
  /** Default effort for effort-based models. */
  defaultEffort?: ThinkingEffort;
  /** Allowed level values for level-based models. */
  levelValues?: ThinkingLevel[];
  /** Default level for level-based models. */
  defaultLevel?: ThinkingLevel;
  /** Allowed budget range for budget-based models. */
  budgetRange?: {
    min: number;
    max: number;
    step?: number;
    allowDynamic?: boolean;
    disableValue?: number;
  };
  /** Default token budget used when the user enables thinking without a value. */
  defaultBudgetTokens?: number;
  /** Anthropic-specific thinking transport metadata. */
  anthropicThinking?: {
    type: 'adaptive' | 'enabled';
    budgetByEffort?: Partial<Record<ThinkingEffort, number>>;
  };
  /** Can thinking be fully disabled via API? */
  toggleable?: boolean;
  /** Can thinking budget/effort intensity be adjusted? */
  budgetAdjustable?: boolean;
  /** Is thinking enabled by default (when no config is passed)? */
  defaultEnabled?: boolean;
}

/**
 * Unified thinking configuration for LLM calls.
 * The adapter maps this to provider-specific providerOptions.
 */
export interface ThinkingConfig {
  /** Modern mode control. Kept separate from legacy enabled for provider APIs with auto/default. */
  mode?: ThinkingMode;
  /** Discrete reasoning effort used by OpenAI/OpenRouter-style APIs. */
  effort?: ThinkingEffort;
  /** Discrete thinking level used by Gemini 3-style APIs. */
  level?: ThinkingLevel;
  /**
   * Whether thinking should be enabled.
   * - true: enable (use model default or specified budget)
   * - false: disable (adapter uses best-effort for non-toggleable models)
   * - undefined: use model default behavior
   */
  enabled?: boolean;
  /**
   * Budget hint in tokens. Only used when enabled=true or undefined.
   * Adapter maps to closest supported value per provider.
   */
  budgetTokens?: number;
  /** Provider-specific option for APIs that can suppress reasoning text from responses. */
  excludeReasoningOutput?: boolean;
}

/**
 * Model information
 */
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  outputWindow?: number;
  capabilities?: {
    streaming?: boolean;
    tools?: boolean;
    vision?: boolean;
    thinking?: ThinkingCapability;
  };
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  id: ProviderId;
  name: string;
  type: ProviderType;
  defaultBaseUrl?: string;
  /**
   * Known alternate base URLs for this provider (e.g. regional endpoints).
   * Rendered in the settings UI as quick-select chips under the base URL input.
   */
  alternateBaseUrls?: { label: string; url: string }[];
  requiresApiKey: boolean;
  icon?: string;
  models: ModelInfo[];
}

/**
 * Model configuration for API calls
 */
export interface ModelConfig {
  providerId: ProviderId;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  proxy?: string; // Optional: HTTP proxy URL for this provider
  providerType?: ProviderType; // Optional: for custom providers on server-side
}
