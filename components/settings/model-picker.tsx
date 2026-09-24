'use client';

// 「课程模型配置」的模型选择器：Popover 内支持按名称/ID 搜索，选中的模型行
// 内联思考强度控制（移植自首页工具栏的 InlineThinkingControl，i18n 沿用
// toolbar.* / settings.* 既有 key）。媒体模态（TTS/ASR/图像/视频）只传
// groups，不传 thinking 回调，即为「仅搜索」的纯模型选择。

import { useMemo, useState } from 'react';
import { Bot, Brain, Check, CornerDownRight, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  getDefaultThinkingConfig,
  getThinkingDisplayValue,
  normalizeThinkingConfig,
  supportsConfigurableThinking,
} from '@/lib/ai/thinking-config';
import type {
  ThinkingCapability,
  ThinkingConfig,
  ThinkingEffort,
  ThinkingLevel,
} from '@/lib/types/provider';

export interface PickerModel {
  id: string;
  name: string;
  /** 模型的思考能力描述；无则该行不渲染思考控制 */
  thinking?: ThinkingCapability;
}

export interface ModelPickerGroup {
  id: string;
  name: string;
  models: PickerModel[];
  /** Token Plan 套餐播种的目录：置顶展示并带标识 */
  isTokenPlan?: boolean;
}

function formatThinkingValue(value: string, t: (key: string) => string) {
  if (value === 'none') return t('toolbar.off');
  if (value === 'dynamic' || value === 'on' || value === 'off' || value === 'auto') {
    return t(`toolbar.${value}`);
  }
  return value === 'xhigh' ? 'x-high' : value;
}

function formatCompactThinkingValue(value: string | undefined) {
  if (!value) return '';
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && value.trim() !== '') {
    return numericValue >= 10000 ? `${Math.round(numericValue / 1000)}k` : `${numericValue}`;
  }
  return formatThinkingValue(value, () => value);
}

/** 行内思考强度控制（开/关/自动、档位、effort、budget） */
function InlineThinkingControl({
  capability,
  config,
  onChange,
  t,
}: {
  capability: ThinkingCapability;
  config?: ThinkingConfig;
  onChange: (config: ThinkingConfig | undefined) => void;
  t: (key: string) => string;
}) {
  if (!supportsConfigurableThinking(capability)) return null;

  const effective =
    normalizeThinkingConfig(capability, config) ?? getDefaultThinkingConfig(capability);
  const applyConfig = (next: ThinkingConfig) => {
    onChange(normalizeThinkingConfig(capability, next));
  };

  const applyBudget = (value: number | undefined) => {
    applyConfig({ ...effective, mode: effective?.mode ?? 'enabled', budgetTokens: value });
  };
  const defaultEnabledBudget =
    typeof capability.defaultBudgetTokens === 'number' && capability.defaultBudgetTokens > 0
      ? capability.defaultBudgetTokens
      : (capability.budgetRange?.step ?? capability.budgetRange?.min);
  const applyAutoBudget = () => {
    applyConfig({ ...effective, mode: 'auto', enabled: undefined, budgetTokens: -1 });
  };
  const applyBudgetMode = (mode: 'disabled' | 'enabled' | 'auto') => {
    if (mode === 'auto') {
      applyAutoBudget();
      return;
    }
    applyConfig({
      ...effective,
      mode,
      enabled: mode === 'enabled',
      budgetTokens:
        mode === 'enabled' && effective?.budgetTokens === -1
          ? defaultEnabledBudget
          : effective?.budgetTokens,
    });
  };
  const applySimpleMode = (mode: 'disabled' | 'enabled' | 'auto') => {
    applyConfig({
      ...effective,
      mode,
      enabled: mode === 'enabled' ? true : mode === 'disabled' ? false : undefined,
    });
  };

  // leading-[14px]：SelectValue 带 line-clamp-1（裁切溢出），10px 字配 1 倍行高会切掉字形下半
  const selectTriggerCls =
    'h-6 min-w-[84px] rounded-full border-0 bg-violet-100 px-2 py-0 !text-[10px] font-medium leading-[14px] text-violet-700 shadow-none focus-visible:ring-0 data-[size=sm]:h-6 dark:bg-violet-900/40 dark:text-violet-200 [&_svg]:size-3';
  const selectItemCls = 'py-1 text-xs';
  const hasAutoBudget =
    (capability.control === 'toggle-budget' || capability.control === 'budget-only') &&
    !!capability.budgetRange?.allowDynamic;
  const autoBudgetMode =
    effective?.budgetTokens === -1 && capability.budgetRange?.allowDynamic
      ? 'auto'
      : effective?.mode === 'disabled'
        ? 'disabled'
        : 'enabled';
  const simpleMode =
    capability.control === 'mode' && effective?.mode === 'auto'
      ? 'auto'
      : effective?.mode === 'disabled'
        ? 'disabled'
        : 'enabled';

  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-1"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Brain className="size-3.5 shrink-0 text-violet-500" />
      <div className="flex min-w-0 items-center gap-0.5 rounded-full border border-violet-200/70 bg-white/65 p-0.5 dark:border-violet-800/70 dark:bg-violet-950/25">
        {hasAutoBudget && (
          <Select
            value={autoBudgetMode}
            onValueChange={(mode) => applyBudgetMode(mode as 'disabled' | 'enabled' | 'auto')}
          >
            <SelectTrigger size="sm" className={selectTriggerCls}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[96px]">
              {capability.control === 'toggle-budget' && (
                <SelectItem value="disabled" className={selectItemCls}>
                  {t('toolbar.off')}
                </SelectItem>
              )}
              <SelectItem value="enabled" className={selectItemCls}>
                {t('toolbar.on')}
              </SelectItem>
              <SelectItem value="auto" className={selectItemCls}>
                {t('toolbar.auto')}
              </SelectItem>
            </SelectContent>
          </Select>
        )}

        {(capability.control === 'toggle' ||
          (capability.control === 'toggle-budget' && !hasAutoBudget) ||
          capability.control === 'mode') && (
          <Select
            value={simpleMode}
            onValueChange={(mode) => applySimpleMode(mode as 'disabled' | 'enabled' | 'auto')}
          >
            <SelectTrigger size="sm" className={selectTriggerCls}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[96px]">
              {capability.control === 'mode' && (
                <SelectItem value="auto" className={selectItemCls}>
                  {t('toolbar.auto')}
                </SelectItem>
              )}
              <SelectItem value="disabled" className={selectItemCls}>
                {t('toolbar.off')}
              </SelectItem>
              <SelectItem value="enabled" className={selectItemCls}>
                {t('toolbar.on')}
              </SelectItem>
            </SelectContent>
          </Select>
        )}

        {capability.control === 'level' && !!capability.levelValues?.length && (
          <Select
            value={effective?.level ?? capability.defaultLevel ?? capability.levelValues[0]}
            onValueChange={(level) =>
              applyConfig({ ...effective, mode: 'enabled', level: level as ThinkingLevel })
            }
          >
            <SelectTrigger size="sm" className={selectTriggerCls}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[96px]">
              {capability.levelValues.map((level: ThinkingLevel) => (
                <SelectItem key={level} value={level} className={selectItemCls}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {capability.control === 'effort' && !!capability.effortValues?.length && (
          <Select
            value={effective?.effort ?? capability.defaultEffort ?? capability.effortValues[0]}
            onValueChange={(effort) =>
              applyConfig({
                ...effective,
                mode: effort === 'none' ? 'disabled' : 'enabled',
                effort: effort as ThinkingEffort,
              })
            }
          >
            <SelectTrigger size="sm" className={selectTriggerCls}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[104px]">
              {capability.effortValues.map((effort: ThinkingEffort) => (
                <SelectItem key={effort} value={effort} className={selectItemCls}>
                  {formatThinkingValue(effort, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {(capability.control === 'toggle-budget' || capability.control === 'budget-only') &&
          capability.budgetRange &&
          (!hasAutoBudget || autoBudgetMode === 'enabled') && (
            <label className="ml-0.5 grid h-6 shrink-0 grid-cols-[auto_60px] items-stretch overflow-hidden rounded-full border border-violet-200/70 bg-background dark:border-violet-800/70">
              <span className="grid h-[22px] shrink-0 place-items-center border-r border-violet-200/70 bg-muted/30 px-2 font-sans text-[11px] font-medium leading-[22px] text-muted-foreground dark:border-violet-800/70">
                {t('toolbar.thinkingBudget')}
              </span>
              <input
                type="text"
                inputMode="numeric"
                aria-label={t('toolbar.thinkingBudget')}
                disabled={effective?.mode === 'disabled'}
                value={
                  typeof effective?.budgetTokens === 'number' && effective.budgetTokens !== -1
                    ? effective.budgetTokens
                    : ''
                }
                placeholder={`${capability.budgetRange.min}-${capability.budgetRange.max}`}
                title={`${capability.budgetRange.min}-${capability.budgetRange.max} tokens`}
                onChange={(event) => {
                  const rawValue = event.target.value.trim();
                  if (!/^\d*$/.test(rawValue)) return;
                  const value = rawValue ? Number(rawValue) : undefined;
                  applyBudget(value);
                }}
                className="block h-[22px] w-[60px] border-0 bg-transparent px-1 py-0 text-center font-sans text-[11px] font-medium leading-[22px] tabular-nums outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
          )}
      </div>
    </div>
  );
}

export function ModelPicker({
  groups,
  value,
  onSelect,
  followLabel,
  followNote,
  onFollow,
  placeholder,
  disabled,
  thinkingConfig,
  onThinkingChange,
  size = 'sm',
  className,
  ariaLabel,
  t,
}: {
  groups: ModelPickerGroup[];
  value: { providerId: string; modelId: string } | null;
  onSelect: (providerId: string, modelId: string) => void;
  /** 传入即渲染「跟随」行（value 为 null 时选中它） */
  followLabel?: string;
  followNote?: string;
  onFollow?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** 当前选中模型的思考配置（仅在传 onThinkingChange 时生效） */
  thinkingConfig?: ThinkingConfig;
  onThinkingChange?: (config: ThinkingConfig | undefined) => void;
  size?: 'sm' | 'md';
  className?: string;
  /** 触发器的可及名。首页工具栏传 `Provider / Model`，e2e 与读屏都依赖它。 */
  ariaLabel?: string;
  t: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const searchTerm = searchQuery.trim().toLowerCase();
  const isSearching = searchTerm.length > 0;

  const groupEntries = useMemo(() => {
    const matchesSearch = (model: PickerModel) =>
      !searchTerm ||
      model.name.toLowerCase().includes(searchTerm) ||
      model.id.toLowerCase().includes(searchTerm);
    return groups
      .map((group) => ({ group, matchingModels: group.models.filter(matchesSearch) }))
      .filter((entry) => !isSearching || entry.matchingModels.length > 0);
  }, [groups, isSearching, searchTerm]);

  const selectedEntry = (() => {
    if (!value) return null;
    // Resolve within the exact provider group first — two providers can carry
    // the same model id (custom gateway + official, plan catalogue + manual),
    // and a cross-group match would show the wrong name/thinking badge.
    const ownGroup = groups.find((g) => g.id === value.providerId);
    const ownModel = ownGroup?.models.find((m) => m.id === value.modelId);
    if (ownModel && ownGroup) return { group: ownGroup, model: ownModel };
    // Fallback for callers whose value points elsewhere (media slots without
    // an active provider, legacy ids): first group carrying the id.
    for (const group of groups) {
      const model = group.models.find((m) => m.id === value.modelId);
      if (model) return { group, model };
    }
    return null;
  })();

  const selectedLabel = selectedEntry?.model.name ?? value?.modelId ?? '';
  const thinkingBadge = selectedEntry?.model.thinking
    ? formatCompactThinkingValue(
        getThinkingDisplayValue(selectedEntry.model.thinking, thinkingConfig),
      )
    : '';

  const triggerBase =
    size === 'md'
      ? 'h-8 w-full gap-1.5 rounded-full border-border/60 bg-background px-3'
      : 'h-7 w-full rounded-md border border-border/60 bg-background px-2.5';

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setSearchQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            'inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium transition-colors',
            'hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
            'disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-muted/60',
            triggerBase,
            className,
          )}
        >
          {value ? (
            <>
              <span className="min-w-0 flex-1 truncate text-left font-mono">{selectedLabel}</span>
              {thinkingBadge && (
                <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold leading-none text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">
                  {thinkingBadge}
                </span>
              )}
            </>
          ) : followLabel ? (
            <span className="flex min-w-0 flex-1 items-center gap-1 text-left">
              <CornerDownRight className="size-3 shrink-0 text-primary" />
              <span className="shrink-0 text-muted-foreground">{followLabel}</span>
              {followNote && (
                <span className="truncate font-mono text-foreground/80">{followNote}</span>
              )}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
              {placeholder ?? ''}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        className="w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
        // 弹层 portal 在 Dialog DOM 之外：设置弹窗的 react-remove-scroll 会把
        // portal 内的 wheel 一律 preventDefault（视作“外部”事件），导致列表
        // 无法滚轮滚动。在 React 合成阶段截停传播，事件不再冒泡到 document
        // 级锁监听，原生滚动即可生效。列表自身滚到边界后事件自然停在这里，
        // 不会意外带动弹窗背后的内容。
        onWheelCapture={(e) => e.stopPropagation()}
      >
        <div className="border-b p-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('settings.searchModels')}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        {/* 列表高度跟随 Radix 给出的可用高度自适应收缩（减去搜索区 ~64px）：
            trigger 靠近视口底部时弹层变矮而不是向上翻转溢出视口——否则顶部
            的搜索框会被裁到屏幕外（如第一行站点的检查器）。 */}
        <div className="max-h-[min(320px,calc(var(--radix-popover-content-available-height)-64px))] min-h-0 overflow-y-auto p-1.5">
          {followLabel && onFollow && (
            <button
              onClick={() => {
                onFollow();
                setOpen(false);
              }}
              className={cn(
                'mb-1 flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
                !value
                  ? 'bg-violet-50 text-violet-700 ring-1 ring-violet-200 dark:bg-violet-950/25 dark:text-violet-300 dark:ring-violet-800'
                  : 'hover:bg-muted/60',
              )}
            >
              <CornerDownRight className="size-3.5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium leading-tight">{followLabel}</span>
                {followNote && (
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                    {followNote}
                  </span>
                )}
              </span>
              {!value && (
                <Check className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
              )}
            </button>
          )}

          {groupEntries.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {searchQuery ? t('settings.noModelsFound') : t('settings.noModelsAvailable')}
            </div>
          ) : (
            groupEntries.map(({ group, matchingModels }) => (
              <div key={group.id}>
                {groups.length > 1 && (
                  <p className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
                    {group.name}
                    {group.isTokenPlan && (
                      <span className="rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-semibold leading-tight text-primary">
                        {t('settings.tokenPlan.nav')}
                      </span>
                    )}
                  </p>
                )}
                {matchingModels.map((model) => {
                  const isSelected =
                    !!value && value.providerId === group.id && value.modelId === model.id;
                  const selectModel = () => {
                    onSelect(group.id, model.id);
                    setOpen(false);
                  };
                  return (
                    <div
                      key={`${group.id}:${model.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={selectModel}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        selectModel();
                      }}
                      className={cn(
                        'mb-0.5 flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors',
                        isSelected
                          ? 'bg-violet-50 text-violet-700 ring-1 ring-violet-200 dark:bg-violet-950/25 dark:text-violet-300 dark:ring-violet-800'
                          : 'hover:bg-muted/60',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-xs font-medium">{model.name}</div>
                        {model.id !== model.name && (
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {model.id}
                          </div>
                        )}
                      </div>
                      {isSelected && onThinkingChange && model.thinking && (
                        <InlineThinkingControl
                          capability={model.thinking}
                          config={thinkingConfig}
                          onChange={onThinkingChange}
                          t={t}
                        />
                      )}
                      {isSelected && (
                        <Check className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {groups.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
            <Bot className="size-4" />
            {t('settings.noModelsAvailable')}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
