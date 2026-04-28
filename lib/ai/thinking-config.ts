import type {
  ThinkingCapability,
  ThinkingConfig,
  ThinkingEffort,
  ThinkingLevel,
  ThinkingMode,
} from '@/lib/types/provider';

export function getThinkingConfigKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function supportsConfigurableThinking(
  thinking?: ThinkingCapability,
): thinking is ThinkingCapability {
  return !!thinking?.control && thinking.control !== 'none' && !!thinking.requestAdapter;
}

export function clampBudgetForCapability(
  thinking: ThinkingCapability,
  budgetTokens?: number,
): number | undefined {
  const range = thinking.budgetRange;
  if (!range || typeof budgetTokens !== 'number' || Number.isNaN(budgetTokens)) {
    return undefined;
  }
  if (budgetTokens === -1 && range.allowDynamic) return -1;
  return Math.max(range.min, Math.min(range.max, Math.round(budgetTokens)));
}

export function getThinkingMode(
  config?: ThinkingConfig,
): 'disabled' | 'enabled' | 'auto' | undefined {
  if (!config) return undefined;
  if (config.mode && config.mode !== 'default') return config.mode;
  if (config.enabled === false) return 'disabled';
  if (config.enabled === true) return 'enabled';
  return undefined;
}

export function pickThinkingEffort(
  thinking: ThinkingCapability,
  config: ThinkingConfig,
): ThinkingEffort | undefined {
  const allowed = thinking.effortValues;
  if (!allowed?.length) return undefined;
  if (config.effort && allowed.includes(config.effort)) return config.effort;

  const mode = getThinkingMode(config);
  if (mode === 'disabled') {
    return (
      (allowed.includes('none') && 'none') ||
      (allowed.includes('minimal') && 'minimal') ||
      (allowed.includes('low') && 'low') ||
      thinking.defaultEffort
    );
  }
  if (mode === 'enabled') return thinking.defaultEffort;
  return undefined;
}

export function pickThinkingLevel(
  thinking: ThinkingCapability,
  config: ThinkingConfig,
): ThinkingLevel | undefined {
  const allowed = thinking.levelValues;
  if (!allowed?.length) return undefined;
  if (config.level && allowed.includes(config.level)) return config.level;

  const mode = getThinkingMode(config);
  if (mode === 'disabled') {
    return (
      (allowed.includes('minimal') && 'minimal') ||
      (allowed.includes('low') && 'low') ||
      thinking.defaultLevel
    );
  }
  if (mode === 'enabled') return thinking.defaultLevel;
  return undefined;
}

export function pickThinkingBudget(
  thinking: ThinkingCapability,
  config: ThinkingConfig,
): number | undefined {
  const range = thinking.budgetRange;
  if (!range) return undefined;

  const mode = getThinkingMode(config);
  if (mode === 'disabled' && range.disableValue !== undefined) {
    return range.disableValue;
  }

  const rawBudget =
    typeof config.budgetTokens === 'number' ? config.budgetTokens : thinking.defaultBudgetTokens;
  return clampBudgetForCapability(thinking, rawBudget);
}

function defaultModeForCapability(thinking: ThinkingCapability): ThinkingMode {
  return thinking.defaultMode ?? (thinking.defaultEnabled === false ? 'disabled' : 'enabled');
}

function defaultEffortForCapability(thinking: ThinkingCapability): ThinkingEffort | undefined {
  return thinking.defaultEffort ?? thinking.effortValues?.[0];
}

function defaultLevelForCapability(thinking: ThinkingCapability): ThinkingLevel | undefined {
  return thinking.defaultLevel ?? thinking.levelValues?.[0];
}

export function getDefaultThinkingConfig(
  thinking?: ThinkingCapability,
): ThinkingConfig | undefined {
  if (!supportsConfigurableThinking(thinking)) return undefined;

  switch (thinking.control) {
    case 'effort': {
      const effort = defaultEffortForCapability(thinking);
      return effort
        ? { mode: effort === 'none' ? 'disabled' : 'enabled', effort }
        : { mode: defaultModeForCapability(thinking) };
    }
    case 'level': {
      const level = defaultLevelForCapability(thinking);
      return level ? { mode: 'enabled', level } : { mode: defaultModeForCapability(thinking) };
    }
    case 'toggle':
      return { mode: defaultModeForCapability(thinking) };
    case 'toggle-budget':
      return {
        mode: defaultModeForCapability(thinking),
        budgetTokens: thinking.defaultBudgetTokens,
      };
    case 'budget-only':
      return { mode: 'enabled', budgetTokens: thinking.defaultBudgetTokens };
    case 'mode':
      return { mode: defaultModeForCapability(thinking) };
    default:
      return undefined;
  }
}

export function normalizeThinkingConfig(
  thinking: ThinkingCapability | undefined,
  config: ThinkingConfig | undefined,
): ThinkingConfig | undefined {
  if (!supportsConfigurableThinking(thinking)) return undefined;

  const mode = getThinkingMode(config);

  switch (thinking.control) {
    case 'effort': {
      const effort =
        (config ? pickThinkingEffort(thinking, config) : undefined) ??
        defaultEffortForCapability(thinking);
      if (!effort) return undefined;
      return { mode: effort === 'none' ? 'disabled' : 'enabled', effort };
    }
    case 'level': {
      const level =
        (config ? pickThinkingLevel(thinking, config) : undefined) ??
        defaultLevelForCapability(thinking);
      if (!level) return undefined;
      return { mode: 'enabled', level };
    }
    case 'toggle':
      return { mode: mode ?? defaultModeForCapability(thinking) };
    case 'toggle-budget': {
      const normalizedMode = mode ?? defaultModeForCapability(thinking);
      const budget = config ? pickThinkingBudget(thinking, config) : undefined;
      return {
        mode: normalizedMode,
        budgetTokens: budget ?? thinking.defaultBudgetTokens,
      };
    }
    case 'budget-only': {
      const budget = config ? pickThinkingBudget(thinking, config) : undefined;
      return {
        mode: 'enabled',
        budgetTokens: budget ?? thinking.defaultBudgetTokens,
      };
    }
    case 'mode':
      return { mode: mode ?? defaultModeForCapability(thinking) };
    default:
      return undefined;
  }
}

export function getThinkingDisplayValue(
  thinking: ThinkingCapability | undefined,
  config: ThinkingConfig | undefined,
): string | undefined {
  const normalized =
    normalizeThinkingConfig(thinking, config) ?? getDefaultThinkingConfig(thinking);
  if (!supportsConfigurableThinking(thinking) || !normalized) return undefined;

  if (thinking.control === 'effort') return normalized.effort;
  if (thinking.control === 'level') return normalized.level;
  if (thinking.control === 'budget-only') {
    return normalized.budgetTokens === -1 ? 'dynamic' : `${normalized.budgetTokens ?? ''}`;
  }
  if (thinking.control === 'toggle-budget') {
    if (normalized.mode === 'disabled') return 'off';
    if (normalized.budgetTokens === -1 && thinking.budgetRange?.allowDynamic) return 'auto';
    return normalized.budgetTokens && normalized.budgetTokens !== -1
      ? `${normalized.budgetTokens}`
      : 'on';
  }
  if (thinking.control === 'mode') return normalized.mode;
  return normalized.mode === 'disabled' ? 'off' : 'on';
}
