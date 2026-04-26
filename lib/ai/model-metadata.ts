import type {
  ProviderConfig,
  ProviderId,
  ThinkingCapability,
  ThinkingEffort,
  ThinkingLevel,
  ThinkingRequestAdapter,
} from '@/lib/types/provider';

export function getModelMetadataKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function effortCapability(
  requestAdapter: ThinkingRequestAdapter,
  effortValues: ThinkingEffort[],
  defaultEffort: ThinkingEffort,
): ThinkingCapability {
  return {
    control: 'effort',
    requestAdapter,
    effortValues,
    defaultEffort,
    defaultMode: effortValues.includes('none') ? 'disabled' : 'enabled',
    toggleable: effortValues.includes('none'),
    budgetAdjustable: true,
    defaultEnabled: !effortValues.includes('none'),
  };
}

function levelCapability(
  levelValues: ThinkingLevel[],
  defaultLevel: ThinkingLevel,
): ThinkingCapability {
  return {
    control: 'level',
    requestAdapter: 'google',
    levelValues,
    defaultLevel,
    defaultMode: 'enabled',
    toggleable: false,
    budgetAdjustable: true,
    defaultEnabled: true,
  };
}

function toggleCapability(
  requestAdapter: ThinkingRequestAdapter,
  defaultEnabled = true,
): ThinkingCapability {
  return {
    control: 'toggle',
    requestAdapter,
    defaultMode: defaultEnabled ? 'enabled' : 'disabled',
    toggleable: true,
    budgetAdjustable: false,
    defaultEnabled,
  };
}

function toggleBudgetCapability(
  requestAdapter: ThinkingRequestAdapter,
  range: { min: number; max: number; step?: number; allowDynamic?: boolean; disableValue?: number },
  defaultEnabled = false,
  defaultBudgetTokens?: number,
): ThinkingCapability {
  return {
    control: 'toggle-budget',
    requestAdapter,
    budgetRange: range,
    defaultBudgetTokens,
    defaultMode: defaultEnabled ? 'enabled' : 'disabled',
    toggleable: true,
    budgetAdjustable: true,
    defaultEnabled,
  };
}

function budgetOnlyCapability(
  requestAdapter: ThinkingRequestAdapter,
  range: { min: number; max: number; step?: number; allowDynamic?: boolean },
  defaultBudgetTokens?: number,
): ThinkingCapability {
  return {
    control: 'budget-only',
    requestAdapter,
    budgetRange: range,
    defaultBudgetTokens,
    defaultMode: 'enabled',
    toggleable: false,
    budgetAdjustable: true,
    defaultEnabled: true,
  };
}

const fixedThinkingCapability: ThinkingCapability = {
  control: 'none',
  requestAdapter: 'none',
  defaultMode: 'enabled',
  toggleable: false,
  budgetAdjustable: false,
  defaultEnabled: true,
};

const anthropicManualBudgetByEffort: Partial<Record<ThinkingEffort, number>> = {
  low: 4096,
  medium: 10240,
  high: 32768,
  max: 64000,
};

const anthropicManualEffort: ThinkingCapability = {
  control: 'effort',
  requestAdapter: 'anthropic',
  effortValues: ['none', 'low', 'medium', 'high', 'max'],
  defaultEffort: 'medium',
  defaultMode: 'enabled',
  toggleable: true,
  budgetAdjustable: true,
  defaultEnabled: true,
  anthropicThinking: {
    type: 'enabled',
    budgetByEffort: anthropicManualBudgetByEffort,
  },
};

const anthropicAdaptiveEffort: ThinkingCapability = {
  ...anthropicManualEffort,
  anthropicThinking: { type: 'adaptive' },
};

const anthropicOpus47Effort: ThinkingCapability = {
  ...anthropicAdaptiveEffort,
  effortValues: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
};

const deepseekEffort: ThinkingCapability = {
  control: 'effort',
  requestAdapter: 'deepseek',
  effortValues: ['none', 'high', 'max'],
  defaultEffort: 'high',
  defaultMode: 'enabled',
  toggleable: true,
  budgetAdjustable: true,
  defaultEnabled: true,
};

const hunyuanHy3Effort: ThinkingCapability = {
  control: 'effort',
  requestAdapter: 'hunyuan',
  effortValues: ['none', 'low', 'high'],
  defaultEffort: 'none',
  defaultMode: 'disabled',
  toggleable: true,
  budgetAdjustable: true,
  defaultEnabled: false,
};

const qwenBudgetEnabled = toggleBudgetCapability(
  'qwen',
  { min: 0, max: 81920, step: 1024, disableValue: 0 },
  true,
);

const qwenBudgetDisabled = toggleBudgetCapability(
  'qwen',
  { min: 0, max: 81920, step: 1024, disableValue: 0 },
  false,
);

const siliconflowBudget = budgetOnlyCapability(
  'siliconflow',
  { min: 128, max: 32768, step: 1024 },
  4096,
);

const siliconflowToggleBudget = toggleBudgetCapability(
  'siliconflow',
  { min: 128, max: 32768, step: 1024, disableValue: 0 },
  true,
  4096,
);

const doubaoMode: ThinkingCapability = {
  control: 'mode',
  requestAdapter: 'doubao',
  defaultMode: 'auto',
  toggleable: true,
  budgetAdjustable: false,
  defaultEnabled: true,
};

const doubaoSeed20Effort: ThinkingCapability = {
  control: 'effort',
  requestAdapter: 'doubao',
  effortValues: ['minimal', 'low', 'medium', 'high'],
  defaultEffort: 'medium',
  defaultMode: 'enabled',
  toggleable: true,
  budgetAdjustable: true,
  defaultEnabled: true,
};

const THINKING_CAPABILITIES: Record<string, ThinkingCapability> = {
  [getModelMetadataKey('openai', 'gpt-5.5')]: effortCapability(
    'openai',
    ['low', 'medium', 'high', 'xhigh'],
    'medium',
  ),
  [getModelMetadataKey('openai', 'gpt-5.4-pro')]: effortCapability(
    'openai',
    ['medium', 'high', 'xhigh'],
    'medium',
  ),
  [getModelMetadataKey('openai', 'gpt-5.4')]: effortCapability(
    'openai',
    ['none', 'low', 'medium', 'high', 'xhigh'],
    'none',
  ),
  [getModelMetadataKey('openai', 'gpt-5.4-mini')]: effortCapability(
    'openai',
    ['none', 'low', 'medium', 'high', 'xhigh'],
    'none',
  ),
  [getModelMetadataKey('openai', 'gpt-5.4-nano')]: effortCapability(
    'openai',
    ['none', 'low', 'medium', 'high', 'xhigh'],
    'none',
  ),

  [getModelMetadataKey('anthropic', 'claude-opus-4-7')]: anthropicOpus47Effort,
  [getModelMetadataKey('anthropic', 'claude-opus-4-6')]: anthropicAdaptiveEffort,
  [getModelMetadataKey('anthropic', 'claude-sonnet-4-6')]: anthropicAdaptiveEffort,
  [getModelMetadataKey('anthropic', 'claude-sonnet-4-5')]: anthropicManualEffort,
  [getModelMetadataKey('anthropic', 'claude-haiku-4-5')]: anthropicManualEffort,

  [getModelMetadataKey('google', 'gemini-3.1-pro-preview')]: levelCapability(
    ['minimal', 'low', 'medium', 'high'],
    'high',
  ),
  [getModelMetadataKey('google', 'gemini-3-flash-preview')]: levelCapability(
    ['minimal', 'low', 'medium', 'high'],
    'high',
  ),
  [getModelMetadataKey('google', 'gemini-2.5-flash')]: toggleBudgetCapability(
    'google',
    { min: 0, max: 24576, step: 1024, allowDynamic: true, disableValue: 0 },
    true,
    -1,
  ),
  [getModelMetadataKey('google', 'gemini-2.5-flash-lite')]: toggleBudgetCapability(
    'google',
    { min: 0, max: 24576, step: 1024, allowDynamic: true, disableValue: 0 },
    false,
    0,
  ),
  [getModelMetadataKey('google', 'gemini-2.5-pro')]: budgetOnlyCapability(
    'google',
    { min: 128, max: 32768, step: 1024, allowDynamic: true },
    -1,
  ),

  [getModelMetadataKey('glm', 'glm-5.1')]: toggleCapability('glm'),
  [getModelMetadataKey('glm', 'glm-5v-turbo')]: toggleCapability('glm'),
  [getModelMetadataKey('glm', 'glm-5')]: toggleCapability('glm'),
  [getModelMetadataKey('glm', 'glm-4.7')]: toggleCapability('glm'),
  [getModelMetadataKey('glm', 'glm-4.7-flashx')]: toggleCapability('glm'),
  [getModelMetadataKey('glm', 'glm-4.7-flash')]: toggleCapability('glm'),
  [getModelMetadataKey('glm', 'glm-4.6')]: toggleCapability('glm'),
  [getModelMetadataKey('glm', 'glm-4.6v')]: toggleCapability('glm'),
  [getModelMetadataKey('glm', 'glm-4.6v-flash')]: toggleCapability('glm'),

  [getModelMetadataKey('qwen', 'qwen3.6-max-preview')]: qwenBudgetDisabled,
  [getModelMetadataKey('qwen', 'qwen3.6-plus')]: qwenBudgetEnabled,
  [getModelMetadataKey('qwen', 'qwen3.6-plus-2026-04-02')]: qwenBudgetEnabled,
  [getModelMetadataKey('qwen', 'qwen3.6-flash')]: qwenBudgetEnabled,
  [getModelMetadataKey('qwen', 'qwen3.6-flash-2026-04-16')]: qwenBudgetEnabled,
  [getModelMetadataKey('qwen', 'qwen3.6-35b-a3b')]: qwenBudgetEnabled,
  [getModelMetadataKey('qwen', 'qwen3.5-flash')]: qwenBudgetEnabled,
  [getModelMetadataKey('qwen', 'qwen3.5-plus')]: qwenBudgetEnabled,
  [getModelMetadataKey('qwen', 'qwen3-max')]: qwenBudgetDisabled,
  [getModelMetadataKey('qwen', 'qwen3-vl-plus')]: qwenBudgetDisabled,

  [getModelMetadataKey('deepseek', 'deepseek-v4-pro')]: deepseekEffort,
  [getModelMetadataKey('deepseek', 'deepseek-v4-flash')]: deepseekEffort,

  [getModelMetadataKey('kimi', 'kimi-k2.6')]: toggleCapability('kimi'),
  [getModelMetadataKey('kimi', 'kimi-k2.5')]: toggleCapability('kimi'),
  [getModelMetadataKey('kimi', 'kimi-k2-thinking')]: toggleCapability('kimi'),

  [getModelMetadataKey('siliconflow', 'deepseek-ai/DeepSeek-R1')]: siliconflowBudget,
  [getModelMetadataKey('siliconflow', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B')]:
    siliconflowBudget,
  [getModelMetadataKey('siliconflow', 'Qwen/Qwen3-VL-32B-Instruct')]: siliconflowToggleBudget,
  [getModelMetadataKey('siliconflow', 'THUDM/GLM-4.1V-9B-Thinking')]: siliconflowBudget,
  [getModelMetadataKey('siliconflow', 'THUDM/GLM-Z1-Rumination-32B-0414')]: siliconflowBudget,

  [getModelMetadataKey('doubao', 'doubao-seed-2-0-pro-260215')]: doubaoSeed20Effort,
  [getModelMetadataKey('doubao', 'doubao-seed-2-0-lite-260215')]: doubaoSeed20Effort,
  [getModelMetadataKey('doubao', 'doubao-seed-2-0-mini-260215')]: doubaoSeed20Effort,
  [getModelMetadataKey('doubao', 'doubao-seed-1-8-251228')]: doubaoMode,

  [getModelMetadataKey('openrouter', 'deepseek/deepseek-v4-pro')]: effortCapability(
    'openrouter',
    ['low', 'medium', 'high'],
    'medium',
  ),
  [getModelMetadataKey('openrouter', 'deepseek/deepseek-v4-flash')]: effortCapability(
    'openrouter',
    ['low', 'medium', 'high'],
    'medium',
  ),

  [getModelMetadataKey('grok', 'grok-4.20-reasoning')]: fixedThinkingCapability,
  [getModelMetadataKey('grok', 'grok-4.20-multi-agent')]: fixedThinkingCapability,
  [getModelMetadataKey('grok', 'grok-4-1-fast-reasoning')]: fixedThinkingCapability,

  [getModelMetadataKey('minimax', 'MiniMax-M2.7')]: fixedThinkingCapability,

  [getModelMetadataKey('tencent-hunyuan', 'hy3-preview')]: hunyuanHy3Effort,

  [getModelMetadataKey('xiaomi', 'mimo-v2.5-pro')]: toggleCapability('xiaomi'),
  [getModelMetadataKey('xiaomi', 'mimo-v2.5')]: toggleCapability('xiaomi'),
};

export function getCatalogThinkingCapability(
  providerId: string,
  modelId: string,
): ThinkingCapability | undefined {
  return THINKING_CAPABILITIES[getModelMetadataKey(providerId, modelId)];
}

export function applyModelMetadata(providers: Record<ProviderId, ProviderConfig>): void {
  for (const provider of Object.values(providers)) {
    for (const model of provider.models) {
      const thinking = getCatalogThinkingCapability(provider.id, model.id);
      if (thinking) {
        model.capabilities = {
          ...model.capabilities,
          thinking,
        };
      }
    }
  }
}
