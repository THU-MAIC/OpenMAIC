'use client';

import { useState, useRef, useMemo } from 'react';
import { Bot, Brain, Check, Paperclip, FileText, X, Globe2, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import type { ProviderId } from '@/lib/ai/providers';
import type {
  ModelInfo,
  ThinkingConfig,
  ThinkingEffort,
  ThinkingLevel,
} from '@/lib/types/provider';
import {
  getDefaultThinkingConfig,
  getThinkingConfigKey,
  getThinkingDisplayValue,
  normalizeThinkingConfig,
  supportsConfigurableThinking,
} from '@/lib/ai/thinking-config';
import type { SettingsSection } from '@/lib/types/settings';
import { MediaPopover } from '@/components/generation/media-popover';

// ─── Constants ───────────────────────────────────────────────
const MAX_PDF_SIZE_MB = 50;
const MAX_PDF_SIZE_BYTES = MAX_PDF_SIZE_MB * 1024 * 1024;

// ─── Types ───────────────────────────────────────────────────
export interface GenerationToolbarProps {
  webSearch: boolean;
  onWebSearchChange: (v: boolean) => void;
  onSettingsOpen: (section?: SettingsSection) => void;
  // PDF
  pdfFile: File | null;
  onPdfFileChange: (file: File | null) => void;
  onPdfError: (error: string | null) => void;
}

// ─── Component ───────────────────────────────────────────────
export function GenerationToolbar({
  webSearch,
  onWebSearchChange,
  onSettingsOpen,
  pdfFile,
  onPdfFileChange,
  onPdfError,
}: GenerationToolbarProps) {
  const { t } = useI18n();
  const currentProviderId = useSettingsStore((s) => s.providerId);
  const currentModelId = useSettingsStore((s) => s.modelId);
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const setModel = useSettingsStore((s) => s.setModel);
  const thinkingConfigs = useSettingsStore((s) => s.thinkingConfigs);
  const setThinkingConfig = useSettingsStore((s) => s.setThinkingConfig);
  const pdfProviderId = useSettingsStore((s) => s.pdfProviderId);
  const pdfProvidersConfig = useSettingsStore((s) => s.pdfProvidersConfig);
  const setPDFProvider = useSettingsStore((s) => s.setPDFProvider);
  const webSearchProviderId = useSettingsStore((s) => s.webSearchProviderId);
  const webSearchProvidersConfig = useSettingsStore((s) => s.webSearchProvidersConfig);
  const setWebSearchProvider = useSettingsStore((s) => s.setWebSearchProvider);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Check if the selected web search provider has a valid config (API key or server-configured)
  const webSearchProvider = WEB_SEARCH_PROVIDERS[webSearchProviderId];
  const webSearchConfig = webSearchProvidersConfig[webSearchProviderId];
  const webSearchAvailable = webSearchProvider
    ? !webSearchProvider.requiresApiKey ||
      !!webSearchConfig?.apiKey ||
      !!webSearchConfig?.isServerConfigured
    : false;

  // Configured LLM providers (only those with valid credentials + models + endpoint)
  const configuredProviders = providersConfig
    ? Object.entries(providersConfig)
        .filter(
          ([, config]) =>
            (!config.requiresApiKey || config.apiKey || config.isServerConfigured) &&
            config.models.length >= 1 &&
            (config.baseUrl || config.defaultBaseUrl || config.serverBaseUrl),
        )
        .map(([id, config]) => ({
          id: id as ProviderId,
          name: config.name,
          icon: config.icon,
          isServerConfigured: config.isServerConfigured,
          models:
            config.isServerConfigured && !config.apiKey && config.serverModels?.length
              ? config.models.filter((m) => new Set(config.serverModels).has(m.id))
              : config.models,
        }))
    : [];

  const currentProviderConfig = providersConfig?.[currentProviderId];
  const currentModel = currentProviderConfig?.models.find((model) => model.id === currentModelId);

  // PDF handler
  const handleFileSelect = (file: File) => {
    if (file.type !== 'application/pdf') return;
    if (file.size > MAX_PDF_SIZE_BYTES) {
      onPdfError(t('upload.fileTooLarge'));
      return;
    }
    onPdfError(null);
    onPdfFileChange(file);
  };

  // ─── Pill button helper ─────────────────────────────
  const pillCls =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all cursor-pointer select-none whitespace-nowrap border';
  const pillMuted = `${pillCls} border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60`;
  const pillActive = `${pillCls} border-violet-200/60 dark:border-violet-700/50 bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300`;

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {/* ── Model selector ── */}
      {configuredProviders.length > 0 ? (
        <ModelSettingsPopover
          configuredProviders={configuredProviders}
          currentProviderId={currentProviderId}
          currentModelId={currentModelId}
          currentProviderConfig={currentProviderConfig}
          currentModel={currentModel}
          setModel={setModel}
          thinkingConfig={thinkingConfigs[getThinkingConfigKey(currentProviderId, currentModelId)]}
          onThinkingChange={(config) =>
            setThinkingConfig(currentProviderId, currentModelId, config)
          }
          t={t}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onSettingsOpen('providers')}
              className={cn(
                pillCls,
                'text-amber-600 dark:text-amber-400 animate-pulse',
                'bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100 dark:hover:bg-amber-950/50',
              )}
            >
              <Bot className="size-3.5" />
              <span>{t('toolbar.configureProvider')}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('toolbar.configureProviderHint')}</TooltipContent>
        </Tooltip>
      )}

      {/* ── Separator ── */}
      <div className="w-px h-4 bg-border/60 mx-1" />

      {/* ── PDF (parser + upload) combined Popover ── */}
      <Popover>
        <PopoverTrigger asChild>
          {pdfFile ? (
            <button className={pillActive}>
              <Paperclip className="size-3.5" />
              <span className="max-w-[100px] truncate">{pdfFile.name}</span>
              <span
                role="button"
                className="size-4 rounded-full inline-flex items-center justify-center hover:bg-violet-200 dark:hover:bg-violet-800 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onPdfFileChange(null);
                }}
              >
                <X className="size-2.5" />
              </span>
            </button>
          ) : (
            <button className={pillMuted}>
              <Paperclip className="size-3.5" />
            </button>
          )}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          {/* Parser selector */}
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <span className="text-xs font-medium text-muted-foreground shrink-0">
              {t('toolbar.pdfParser')}
            </span>
            <Select value={pdfProviderId} onValueChange={(v) => setPDFProvider(v as PDFProviderId)}>
              <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(PDF_PROVIDERS).map((provider) => {
                  const cfg = pdfProvidersConfig[provider.id];
                  const available =
                    !provider.requiresApiKey || !!cfg?.apiKey || !!cfg?.isServerConfigured;
                  return (
                    <SelectItem key={provider.id} value={provider.id} disabled={!available}>
                      <div className={cn('flex items-center gap-1.5', !available && 'opacity-50')}>
                        {provider.icon && (
                          <img src={provider.icon} alt={provider.name} className="w-3.5 h-3.5" />
                        )}
                        {provider.name}
                        {cfg?.isServerConfigured && (
                          <span className="text-[9px] px-1 py-0 rounded border text-muted-foreground">
                            {t('settings.serverConfigured')}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Upload area / file info */}
          <div className="px-3 pb-3">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept=".pdf"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileSelect(f);
                e.target.value = '';
              }}
            />
            {pdfFile ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="size-8 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center shrink-0">
                    <FileText className="size-4 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{pdfFile.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(pdfFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => onPdfFileChange(null)}
                  className="w-full text-xs text-destructive hover:underline text-left"
                >
                  {t('toolbar.removePdf')}
                </button>
              </div>
            ) : (
              <div
                className={cn(
                  'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 transition-colors cursor-pointer',
                  isDragging
                    ? 'border-violet-400 bg-violet-50 dark:bg-violet-950/20'
                    : 'border-muted-foreground/20 hover:border-violet-300',
                )}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) handleFileSelect(f);
                }}
              >
                <Paperclip className="size-5 text-muted-foreground/50 mb-1.5" />
                <p className="text-xs font-medium">{t('toolbar.pdfUpload')}</p>
                <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                  {t('upload.pdfSizeLimit')}
                </p>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* ── Web Search ── */}
      {webSearchAvailable ? (
        <Popover>
          <PopoverTrigger asChild>
            <button className={webSearch ? pillActive : pillMuted}>
              <Globe2 className={cn('size-3.5', webSearch && 'animate-pulse')} />
              {webSearch && (
                <span>{WEB_SEARCH_PROVIDERS[webSearchProviderId]?.name || 'Search'}</span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-3 space-y-3">
            {/* Toggle */}
            <button
              onClick={() => onWebSearchChange(!webSearch)}
              className={cn(
                'w-full flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all',
                webSearch
                  ? 'bg-violet-50 dark:bg-violet-950/20 border-violet-200 dark:border-violet-800'
                  : 'border-border hover:bg-muted/50',
              )}
            >
              <Globe2
                className={cn(
                  'size-4 shrink-0',
                  webSearch ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground',
                )}
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium">
                  {webSearch ? t('toolbar.webSearchOn') : t('toolbar.webSearchOff')}
                </p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {t('toolbar.webSearchDesc')}
                </p>
              </div>
            </button>

            {/* Provider selector */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground shrink-0">
                {t('toolbar.webSearchProvider')}
              </span>
              <Select
                value={webSearchProviderId}
                onValueChange={(v) => setWebSearchProvider(v as WebSearchProviderId)}
              >
                <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(WEB_SEARCH_PROVIDERS).map((provider) => {
                    const cfg = webSearchProvidersConfig[provider.id];
                    const available =
                      !provider.requiresApiKey || !!cfg?.apiKey || !!cfg?.isServerConfigured;
                    return (
                      <SelectItem key={provider.id} value={provider.id} disabled={!available}>
                        <div
                          className={cn('flex items-center gap-1.5', !available && 'opacity-50')}
                        >
                          {provider.name}
                          {cfg?.isServerConfigured && (
                            <span className="text-[9px] px-1 py-0 rounded border text-muted-foreground">
                              {t('settings.serverConfigured')}
                            </span>
                          )}
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button className={cn(pillCls, 'text-muted-foreground/40 cursor-not-allowed')} disabled>
              <Globe2 className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('toolbar.webSearchNoProvider')}</TooltipContent>
        </Tooltip>
      )}

      {/* ── Separator ── */}
      <div className="w-px h-4 bg-border/60 mx-1" />

      {/* ── Media popover ── */}
      <MediaPopover onSettingsOpen={onSettingsOpen} />
    </div>
  );
}

function formatThinkingValue(value?: string, t?: (key: string) => string) {
  if (!value) return '';
  if (value === 'none') return t ? t('toolbar.off') : 'off';
  if (t && (value === 'dynamic' || value === 'on' || value === 'off' || value === 'auto')) {
    return t(`toolbar.${value}`);
  }
  return value === 'xhigh' ? 'x-high' : value;
}

function ThinkingControlPanel({
  model,
  config,
  onChange,
  t,
}: {
  model: ModelInfo;
  config?: ThinkingConfig;
  onChange: (config: ThinkingConfig | undefined) => void;
  t: (key: string) => string;
}) {
  const thinking = model.capabilities?.thinking;
  if (!supportsConfigurableThinking(thinking)) return null;

  const effective = normalizeThinkingConfig(thinking, config) ?? getDefaultThinkingConfig(thinking);
  const applyConfig = (next: ThinkingConfig) => {
    onChange(normalizeThinkingConfig(thinking, next));
  };

  const applyMode = (mode: 'disabled' | 'enabled' | 'auto') => {
    applyConfig({
      ...effective,
      mode,
      enabled: mode === 'enabled' ? true : mode === 'disabled' ? false : undefined,
    });
  };

  const applyBudget = (value: number | undefined) => {
    applyConfig({ ...effective, mode: effective?.mode ?? 'enabled', budgetTokens: value });
  };

  const segmentCls =
    'h-7 rounded-md px-2.5 text-[11px] font-medium transition-colors border whitespace-nowrap';
  const activeSegment =
    'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-900/25 dark:text-violet-300';
  const inactiveSegment =
    'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground';

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md">
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 text-xs font-semibold">
        <Brain className="size-3.5 shrink-0 text-violet-500" />
        <span>{t('toolbar.thinking')}</span>
      </div>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {(thinking.control === 'toggle' || thinking.control === 'toggle-budget') && (
          <div className="inline-flex shrink-0 rounded-md border bg-background p-0.5">
            {(['disabled', 'enabled'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => applyMode(mode)}
                className={cn(
                  'h-6 min-w-12 rounded px-2 text-[11px] font-medium transition-colors',
                  effective?.mode === mode
                    ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/35 dark:text-violet-300'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {mode === 'enabled' ? t('toolbar.on') : t('toolbar.off')}
              </button>
            ))}
          </div>
        )}

        {thinking.control === 'mode' && (
          <div className="flex min-w-[210px] gap-1.5">
            {(['auto', 'enabled', 'disabled'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => applyMode(mode)}
                className={cn(
                  segmentCls,
                  'min-w-16',
                  effective?.mode === mode ? activeSegment : inactiveSegment,
                )}
              >
                {mode === 'auto'
                  ? t('toolbar.auto')
                  : mode === 'enabled'
                    ? t('toolbar.on')
                    : t('toolbar.off')}
              </button>
            ))}
          </div>
        )}

        {thinking.control === 'level' && (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {(thinking.levelValues ?? []).map((level: ThinkingLevel) => (
              <button
                key={level}
                onClick={() => applyConfig({ ...effective, mode: 'enabled', level })}
                className={cn(
                  segmentCls,
                  effective?.level === level ? activeSegment : inactiveSegment,
                )}
              >
                {level}
              </button>
            ))}
          </div>
        )}

        {thinking.control === 'effort' && (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {(thinking.effortValues ?? []).map((effort: ThinkingEffort) => (
              <button
                key={effort}
                onClick={() =>
                  applyConfig({
                    ...effective,
                    mode: effort === 'none' ? 'disabled' : 'enabled',
                    effort,
                  })
                }
                className={cn(
                  segmentCls,
                  effective?.effort === effort ? activeSegment : inactiveSegment,
                )}
              >
                {formatThinkingValue(effort, t)}
              </button>
            ))}
          </div>
        )}

        {(thinking.control === 'toggle-budget' || thinking.control === 'budget-only') &&
          thinking.budgetRange && (
            <label className="flex h-7 shrink-0 items-center overflow-hidden rounded-md border bg-background">
              <span className="border-r bg-muted/35 px-2 text-[11px] font-medium text-muted-foreground">
                {t('toolbar.thinkingBudget')}
              </span>
              <Input
                type="number"
                min={thinking.budgetRange.min}
                max={thinking.budgetRange.max}
                step={thinking.budgetRange.step ?? 1}
                disabled={effective?.mode === 'disabled'}
                value={
                  typeof effective?.budgetTokens === 'number' && effective.budgetTokens !== -1
                    ? effective.budgetTokens
                    : ''
                }
                placeholder={`${thinking.budgetRange.min}-${thinking.budgetRange.max}`}
                title={`${thinking.budgetRange.min}-${thinking.budgetRange.max} tokens`}
                onChange={(event) => {
                  const value = event.target.value ? Number(event.target.value) : undefined;
                  applyBudget(value);
                }}
                className="h-7 w-28 rounded-none border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-0"
              />
              <span className="border-l px-2 text-[10px] text-muted-foreground">tokens</span>
            </label>
          )}

        {thinking.budgetRange?.allowDynamic && effective?.budgetTokens !== -1 && (
          <button
            onClick={() => applyBudget(-1)}
            className={cn(
              segmentCls,
              'w-fit',
              effective?.budgetTokens === -1 ? activeSegment : inactiveSegment,
            )}
          >
            {t('toolbar.dynamic')}
          </button>
        )}
      </div>

      <button
        onClick={() => onChange(undefined)}
        className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
      >
        {t('toolbar.default')}
      </button>
    </div>
  );
}

// ─── ModelSettingsPopover (provider + model + thinking) ─────
interface ConfiguredProvider {
  id: ProviderId;
  name: string;
  icon?: string;
  isServerConfigured?: boolean;
  models: ModelInfo[];
}

function ModelSettingsPopover({
  configuredProviders,
  currentProviderId,
  currentModelId,
  currentProviderConfig,
  currentModel,
  setModel,
  thinkingConfig,
  onThinkingChange,
  t,
}: {
  configuredProviders: ConfiguredProvider[];
  currentProviderId: ProviderId;
  currentModelId: string;
  currentProviderConfig: { name: string; icon?: string } | undefined;
  currentModel?: ModelInfo;
  setModel: (providerId: ProviderId, modelId: string) => void;
  thinkingConfig?: ThinkingConfig;
  onThinkingChange: (config: ThinkingConfig | undefined) => void;
  t: (key: string) => string;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [activeProviderId, setActiveProviderId] = useState<ProviderId>(currentProviderId);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAllModels, setShowAllModels] = useState(false);

  const currentProvider = configuredProviders.find((provider) => provider.id === currentProviderId);
  const searchTerm = searchQuery.trim().toLowerCase();
  const isSearching = searchTerm.length > 0;
  const providerEntries = useMemo(() => {
    const matchesSearch = (model: ModelInfo) =>
      !searchTerm ||
      model.name.toLowerCase().includes(searchTerm) ||
      model.id.toLowerCase().includes(searchTerm);

    return configuredProviders
      .map((provider) => ({
        provider,
        matchingModels: provider.models.filter(matchesSearch),
        recommendedCount: provider.models.filter(
          (model) => (model.lifecycle ?? 'recommended') === 'recommended',
        ).length,
      }))
      .filter((entry) => !isSearching || entry.matchingModels.length > 0);
  }, [configuredProviders, isSearching, searchTerm]);

  const activeProviderVisible = providerEntries.some(
    (entry) => entry.provider.id === activeProviderId,
  );
  const firstVisibleProviderId = providerEntries[0]?.provider.id;
  const resolvedActiveProviderId =
    isSearching && !activeProviderVisible ? firstVisibleProviderId : activeProviderId;
  const activeProviderEntry =
    providerEntries.find((entry) => entry.provider.id === resolvedActiveProviderId) ??
    providerEntries[0];
  const activeProvider = activeProviderEntry?.provider;

  const visibleModelEntries = useMemo(() => {
    if (!activeProviderEntry) return [];
    const { provider, matchingModels } = activeProviderEntry;
    return matchingModels
      .filter((model) => {
        if (isSearching || showAllModels) return true;
        return (
          (model.lifecycle ?? 'recommended') === 'recommended' ||
          (currentProviderId === provider.id && currentModelId === model.id)
        );
      })
      .map((model) => ({ provider, model }));
  }, [activeProviderEntry, currentModelId, currentProviderId, isSearching, showAllModels]);

  const currentThinking = currentModel?.capabilities?.thinking;
  const thinkingDisplay =
    supportsConfigurableThinking(currentThinking) && currentModel
      ? getThinkingDisplayValue(currentThinking, thinkingConfig)
      : undefined;
  const currentProviderName =
    currentProvider?.name ?? currentProviderConfig?.name ?? currentProviderId;
  const currentProviderIcon = currentProvider?.icon ?? currentProviderConfig?.icon;
  const currentModelLabel = currentModel?.name || currentModelId || t('settings.selectModel');
  const hasLegacyModels =
    !isSearching && activeProvider?.models.some((model) => model.lifecycle === 'legacy');

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(open) => {
        setPopoverOpen(open);
        if (open) {
          setActiveProviderId(currentProviderId);
          setSearchQuery('');
          setShowAllModels(false);
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label={`${currentProviderName} / ${currentModelLabel}`}
              className={cn(
                'inline-flex h-8 w-[160px] min-w-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-all sm:w-[176px]',
                'border-violet-200/70 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-800/70 dark:bg-violet-950/30 dark:text-violet-300',
                currentModelId &&
                  'shadow-[0_0_0_1px_rgba(124,58,237,0.12)] dark:shadow-[0_0_0_1px_rgba(167,139,250,0.16)]',
              )}
            >
              {currentProviderIcon ? (
                <img
                  src={currentProviderIcon}
                  alt={currentProviderName}
                  className="size-4 shrink-0 rounded-sm"
                />
              ) : (
                <Bot className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate text-left">{currentModelLabel}</span>
              {thinkingDisplay && (
                <span
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white/75 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200"
                  title={`${t('toolbar.thinking')}: ${formatThinkingValue(thinkingDisplay, t)}`}
                >
                  <Brain className="size-3" />
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {currentModelId
            ? `${currentProviderConfig?.name || currentProviderId} / ${currentModelId}`
            : t('settings.selectModel')}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="w-[640px] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        <div className="border-b bg-muted/20 px-3 py-2.5">
          <div className="flex items-center gap-2">
            {currentProviderIcon ? (
              <img
                src={currentProviderIcon}
                alt={currentProviderName}
                className="size-5 rounded-sm"
              />
            ) : (
              <Bot className="size-5 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold">{currentProviderName}</span>
                {currentProvider?.isServerConfigured && (
                  <span className="rounded border px-1 py-0 text-[9px] text-muted-foreground">
                    {t('settings.serverConfigured')}
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {currentModelLabel}
              </div>
            </div>
          </div>
        </div>

        <div className="grid h-[374px] grid-cols-[128px_minmax(0,1fr)] sm:grid-cols-[160px_minmax(0,1fr)]">
          <div className="min-h-0 border-r bg-muted/20">
            <div className="px-3 py-2 text-[10px] font-semibold uppercase text-muted-foreground">
              {t('toolbar.selectProvider')}
            </div>
            <div className="h-[calc(100%-28px)] overflow-y-auto px-2 pb-2 pt-1">
              {providerEntries.length === 0 ? (
                <div className="px-2 py-4 text-[11px] text-muted-foreground">
                  {t('settings.noModelsFound')}
                </div>
              ) : (
                providerEntries.map(({ provider, matchingModels, recommendedCount }) => {
                  const isActive = activeProvider?.id === provider.id;
                  const isCurrent = currentProviderId === provider.id;
                  return (
                    <button
                      key={provider.id}
                      onClick={() => {
                        setActiveProviderId(provider.id);
                        setShowAllModels(false);
                      }}
                      className={cn(
                        'mb-1 flex h-10 w-full items-center gap-2 rounded-md px-2 text-left transition-colors',
                        isActive
                          ? 'bg-background text-foreground shadow-sm ring-1 ring-border/70'
                          : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                      )}
                    >
                      {provider.icon ? (
                        <img
                          src={provider.icon}
                          alt={provider.name}
                          className="size-4 shrink-0 rounded-sm"
                        />
                      ) : (
                        <Bot className="size-4 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium">{provider.name}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {isSearching ? matchingModels.length : recommendedCount}/
                          {provider.models.length}
                        </div>
                      </div>
                      {isCurrent && <span className="size-1.5 rounded-full bg-violet-500" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div className="border-b p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(event) => {
                      const nextSearch = event.target.value;
                      setSearchQuery(nextSearch);
                      setShowAllModels(false);
                      if (!nextSearch.trim()) setActiveProviderId(currentProviderId);
                    }}
                    placeholder={t('settings.searchModels')}
                    className="h-8 pl-8 text-xs"
                  />
                </div>
                {hasLegacyModels && (
                  <button
                    onClick={() => setShowAllModels((value) => !value)}
                    className="h-8 w-full shrink-0 rounded-md border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground sm:w-auto"
                  >
                    {showAllModels
                      ? t('toolbar.showRecommendedModels')
                      : t('toolbar.showAllModels')}
                  </button>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {visibleModelEntries.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {searchQuery ? t('settings.noModelsFound') : t('settings.noModelsAvailable')}
                </div>
              ) : (
                visibleModelEntries.map(({ provider, model }) => {
                  const isSelected =
                    currentProviderId === provider.id && currentModelId === model.id;
                  const isLegacy = model.lifecycle === 'legacy';
                  const thinking = model.capabilities?.thinking;
                  return (
                    <button
                      key={`${provider.id}:${model.id}`}
                      onClick={() => {
                        setActiveProviderId(provider.id);
                        setModel(provider.id, model.id);
                      }}
                      className={cn(
                        'mb-1 flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
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
                      {supportsConfigurableThinking(thinking) && (
                        <Brain className="size-3.5 shrink-0 text-violet-500" />
                      )}
                      {isLegacy && (
                        <span className="shrink-0 rounded border px-1 py-0 text-[9px] text-muted-foreground">
                          {t('toolbar.legacy')}
                        </span>
                      )}
                      {isSelected && (
                        <Check className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {currentModel && supportsConfigurableThinking(currentModel.capabilities?.thinking) && (
              <div className="border-t bg-muted/20 px-3 py-2">
                <ThinkingControlPanel
                  model={currentModel}
                  config={thinkingConfig}
                  onChange={onThinkingChange}
                  t={t}
                />
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
