'use client';

import { useState, useMemo } from 'react';
import { Bot, Check, ChevronLeft } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { useUserPrefsStore } from '@/lib/store/user-prefs';
import { MONO_LOGO_PROVIDERS } from '@/lib/ai/providers';
import type { ProviderId } from '@/lib/ai/providers';

export interface ConfiguredProvider {
  id: ProviderId;
  name: string;
  icon?: string;
  isServerConfigured?: boolean;
  models: { id: string; name: string }[];
}

interface ModelSelectorPopoverProps {
  configuredProviders: ConfiguredProvider[];
  currentProviderId: ProviderId;
  currentModelId: string;
  currentProviderConfig: { name: string; icon?: string } | undefined;
  setModel: (providerId: ProviderId, modelId: string) => void;
  t: (key: string) => string;
}

export function ModelSelectorPopover({
  configuredProviders,
  currentProviderId,
  currentModelId,
  currentProviderConfig,
  setModel,
  t,
}: ModelSelectorPopoverProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  // null = provider list, ProviderId = model list for that provider
  const [drillProvider, setDrillProvider] = useState<ProviderId | null>(null);

  const activeProvider = useMemo(
    () => configuredProviders.find((p) => p.id === drillProvider),
    [configuredProviders, drillProvider],
  );

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(open) => {
        setPopoverOpen(open);
        if (open) setDrillProvider(null);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              className={cn(
                'inline-flex items-center justify-center size-7 rounded-full transition-all cursor-pointer select-none',
                'ring-1 ring-border/60 hover:ring-border hover:bg-muted/60',
                currentModelId &&
                  'ring-violet-300 dark:ring-violet-700 bg-violet-50 dark:bg-violet-950/20',
              )}
            >
              {currentProviderConfig?.icon ? (
                <img
                  src={currentProviderConfig.icon}
                  alt={currentProviderConfig.name}
                  className={cn(
                    'size-4 rounded-sm',
                    MONO_LOGO_PROVIDERS.has(currentProviderId) && 'dark:invert',
                  )}
                />
              ) : (
                <Bot className="size-3.5 text-muted-foreground" />
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

      <PopoverContent align="start" className="w-64 p-0">
        {/* Level 1: Provider list */}
        {!drillProvider && (
          <div className="max-h-72 overflow-y-auto">
            <div className="px-3 py-2 border-b">
              <span className="text-xs font-semibold text-muted-foreground">
                {t('toolbar.selectProvider')}
              </span>
            </div>
            {configuredProviders.map((provider) => {
              const isActive = currentProviderId === provider.id;
              return (
                <button
                  key={provider.id}
                  onClick={() => setDrillProvider(provider.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors border-b border-border/30',
                    isActive ? 'bg-violet-50/50 dark:bg-violet-950/10' : 'hover:bg-muted/50',
                  )}
                >
                  {provider.icon ? (
                    <img
                      src={provider.icon}
                      alt={provider.name}
                      className={cn(
                        'size-5 rounded-sm shrink-0',
                        MONO_LOGO_PROVIDERS.has(provider.id) && 'dark:invert',
                      )}
                    />
                  ) : (
                    <Bot className="size-5 text-muted-foreground shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{provider.name}</span>
                    {provider.isServerConfigured && (
                      <span className="text-[9px] px-1 py-0 rounded border text-muted-foreground ml-1.5">
                        {t('settings.serverConfigured')}
                      </span>
                    )}
                  </div>
                  {isActive && currentModelId && (
                    <span className="text-[10px] text-muted-foreground truncate max-w-[80px]">
                      {currentModelId}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Level 2: Model list for selected provider */}
        {drillProvider && activeProvider && (
          <div className="max-h-72 overflow-y-auto">
            <button
              onClick={() => setDrillProvider(null)}
              className="w-full flex items-center gap-2 px-3 py-2 border-b bg-muted/40 hover:bg-muted/60 transition-colors"
            >
              <ChevronLeft className="size-3.5 text-muted-foreground" />
              {activeProvider.icon ? (
                <img
                  src={activeProvider.icon}
                  alt={activeProvider.name}
                  className={cn(
                    'size-4 rounded-sm',
                    MONO_LOGO_PROVIDERS.has(activeProvider.id) && 'dark:invert',
                  )}
                />
              ) : (
                <Bot className="size-4 text-muted-foreground" />
              )}
              <span className="text-xs font-semibold">{activeProvider.name}</span>
              <span className="text-[10px] text-muted-foreground ml-auto">
                {activeProvider.models.length} {t('settings.modelCount')}
              </span>
            </button>
            {activeProvider.models.map((model) => {
              const isSelected = currentProviderId === drillProvider && currentModelId === model.id;
              return (
                <button
                  key={model.id}
                  onClick={() => {
                    setModel(drillProvider, model.id);
                    setPopoverOpen(false);
                  }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 text-left transition-colors border-b border-border/30',
                    isSelected
                      ? 'bg-violet-50 dark:bg-violet-950/20 text-violet-700 dark:text-violet-300'
                      : 'hover:bg-muted/50',
                  )}
                >
                  <span className="flex-1 truncate font-mono text-xs">{model.name}</span>
                  {isSelected && (
                    <Check className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Self-contained wrapper that reads from Zustand stores directly.
 * Drop-in for contexts where you don't want to manage store subscriptions.
 */
export function CompactModelSelector() {
  const { t } = useI18n();
  const currentProviderId = useUserPrefsStore((s) => s.providerId);
  const currentModelId = useUserPrefsStore((s) => s.modelId);
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const setModel = useUserPrefsStore((s) => s.setModel);

  const configuredProviders = useMemo(
    () =>
      providersConfig
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
        : [],
    [providersConfig],
  );

  const currentProviderConfig = providersConfig?.[currentProviderId];

  if (configuredProviders.length === 0) return null;

  return (
    <ModelSelectorPopover
      configuredProviders={configuredProviders}
      currentProviderId={currentProviderId}
      currentModelId={currentModelId}
      currentProviderConfig={currentProviderConfig}
      setModel={setModel}
      t={t}
    />
  );
}
