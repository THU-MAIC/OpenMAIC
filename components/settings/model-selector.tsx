'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Check,
  Search,
  Sparkles,
  Wrench,
  Zap,
  Box,
  Loader2,
  CheckCircle,
  XCircle,
  FileText,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProviderId } from '@/lib/ai/providers';
import type { ProvidersConfig } from '@/lib/types/settings';
import { formatContextWindow } from './utils';

interface ModelSelectorProps {
  providerId: ProviderId;
  modelId: string;
  onModelChange: (providerId: ProviderId, modelId: string) => void;
  providersConfig: ProvidersConfig;
}

export function ModelSelector({
  providerId,
  modelId,
  onModelChange,
  providersConfig,
}: ModelSelectorProps) {
  const { t } = useI18n();
  const [activeProvider, setActiveProvider] = useState<ProviderId>(providerId);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const selectedModelRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Helper function to get translated provider name
  const getProviderDisplayName = (pid: ProviderId, name: string) => {
    const translationKey = `settings.providerNames.${pid}`;
    const translated = t(translationKey);
    // If translation exists (not equal to key), use it; otherwise fallback to name
    return translated !== translationKey ? translated : name;
  };

  // Helper function for model count with proper plural form
  const getModelCountText = (count: number) => {
    const key = count === 1 ? 'settings.modelSingular' : 'settings.modelCount';
    return `${count} ${t(key)}`;
  };

  const getFilteredModelCountText = (filtered: number, total: number) => {
    const key = total === 1 ? 'settings.modelSingular' : 'settings.modelCount';
    return `${filtered}/${total} ${t(key)}`;
  };

  // Get all providers that are ready to use:
  // - (Doesn't require API key OR has API key configured OR server has key)
  // - Has at least one model
  // - Has baseUrl or defaultBaseUrl configured
  const configuredProviders = Object.entries(providersConfig)
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
    }));

  const handleSelect = (pid: ProviderId, mid: string) => {
    onModelChange(pid, mid);
  };

  // Filter models across all providers by search query and server model restrictions
  const getFilteredModelsForProvider = (pid: ProviderId) => {
    const config = providersConfig[pid];
    let models = config?.models || [];
    // When using server config without own key, restrict to server-allowed models
    if (config?.isServerConfigured && !config.apiKey && config.serverModels?.length) {
      const allowed = new Set(config.serverModels);
      models = models.filter((m) => allowed.has(m.id));
    }
    if (!searchQuery) return models;
    return models.filter(
      (model) =>
        model.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        model.id.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  };

  // Sync activeProvider with providerId prop changes
  useEffect(() => {
    setActiveProvider(providerId);
  }, [providerId]);

  // Fallback: if activeProvider is not in configured providers, use the first configured one
  const effectiveProvider = configuredProviders.some((p) => p.id === activeProvider)
    ? activeProvider
    : (configuredProviders[0]?.id ?? activeProvider);

  const filteredModels = getFilteredModelsForProvider(effectiveProvider);

  // Auto scroll to selected model when opening
  useEffect(() => {
    if (selectedModelRef.current) {
      selectedModelRef.current.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }, [effectiveProvider]);

  // Auto focus search input when expanded
  useEffect(() => {
    if (searchExpanded && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchExpanded]);

  // Test model function
  const handleTestModel = useCallback(
    async (pid: ProviderId, mid: string) => {
      const providerConfig = providersConfig[pid];
      if (!providerConfig) return;

      const apiKey = providerConfig.apiKey;
      // Only send user-entered baseUrl; let server resolve fallback
      const baseUrl = providerConfig.baseUrl;

      if (providerConfig.requiresApiKey && !apiKey && !providerConfig.isServerConfigured) {
        setTestStatus('error');
        setTestMessage(t('settings.apiKeyRequired'));
        setTestingModelId(mid);
        return;
      }

      setTestStatus('testing');
      setTestMessage('');
      setTestingModelId(mid);

      try {
        const response = await fetch('/api/verify-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey,
            baseUrl,
            model: `${pid}:${mid}`,
            providerType: providerConfig.type,
            requiresApiKey: providerConfig.requiresApiKey,
          }),
        });

        const data = await response.json();

        if (data.success) {
          setTestStatus('success');
          setTestMessage(t('settings.connectionSuccess'));
        } else {
          setTestStatus('error');
          setTestMessage(data.error || t('settings.connectionFailed'));
        }
      } catch {
        setTestStatus('error');
        setTestMessage(t('settings.connectionFailed'));
      }
    },
    [providersConfig, t],
  );

  if (configuredProviders.length === 0) {
    return (
      <div className="p-4 border-2 border-dashed rounded-lg text-center text-sm text-muted-foreground">
        {t('settings.configureProvidersFirst')}
      </div>
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden flex flex-col h-[420px] relative">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: Provider List */}
        <div className="w-48 border-r bg-muted/30 overflow-y-auto shrink-0">
          {configuredProviders.map((provider) => {
            const filteredCount = getFilteredModelsForProvider(provider.id).length;
            const totalCount = providersConfig[provider.id]?.models?.length || 0;
            const isActive = effectiveProvider === provider.id;

            return (
              <button
                key={provider.id}
                onClick={() => setActiveProvider(provider.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors border-b',
                  isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/50',
                )}
              >
                {provider.icon ? (
                  <img
                    src={provider.icon}
                    alt={getProviderDisplayName(provider.id, provider.name)}
                    className="w-5 h-5 shrink-0"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <Box className="w-5 h-5 shrink-0 text-muted-foreground" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate flex items-center gap-1">
                    {getProviderDisplayName(provider.id, provider.name)}
                    {provider.isServerConfigured && (
                      <span
                        className={cn(
                          'text-[10px] px-1 py-0 h-4 leading-4 rounded shrink-0 inline-block',
                          isActive
                            ? 'bg-white/20 text-primary-foreground'
                            : 'bg-muted text-muted-foreground',
                        )}
                      >
                        {t('settings.serverConfigured')}
                      </span>
                    )}
                  </div>
                  <div className={cn('text-xs', isActive ? 'opacity-90' : 'text-muted-foreground')}>
                    {searchQuery && filteredCount !== totalCount
                      ? getFilteredModelCountText(filteredCount, totalCount)
                      : getModelCountText(totalCount)}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Right: Model List */}
        <div className="flex-1 flex flex-col relative">
          {/* Floating Search Button - Bottom Right */}
          <div className="absolute bottom-4 right-4 z-10">
            {searchExpanded ? (
              <div className="relative w-64 animate-in fade-in slide-in-from-bottom-2 duration-200">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  placeholder={t('settings.searchModels')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onBlur={() => {
                    if (!searchQuery) {
                      setSearchExpanded(false);
                    }
                  }}
                  className="pl-9 h-9 pr-3 shadow-lg border-primary/20 bg-card dark:bg-card"
                />
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-10 w-10 rounded-full p-0 shadow-md hover:shadow-lg transition-shadow bg-card hover:bg-card dark:bg-card dark:hover:bg-card"
                onClick={() => setSearchExpanded(true)}
              >
                <Search className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Model Items */}
          <div className="flex-1 overflow-y-auto">
            {filteredModels.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {searchQuery ? t('settings.noModelsFound') : t('settings.noModelsAvailable')}
              </div>
            ) : (
              filteredModels.map((model) => {
                const isSelected = providerId === effectiveProvider && modelId === model.id;
                const isTesting = testingModelId === model.id;
                const showTestResult = isTesting && testMessage;

                return (
                  <div
                    key={model.id}
                    className={cn(
                      'border-b transition-colors',
                      isSelected ? 'bg-primary/5' : 'hover:bg-muted/50',
                    )}
                  >
                    <div className="flex items-center gap-2 px-3 py-2.5">
                      <button
                        ref={isSelected ? selectedModelRef : null}
                        onClick={() => handleSelect(effectiveProvider, model.id)}
                        className="flex-1 flex items-center gap-2 text-left"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-sm font-medium mb-1.5 truncate">
                            {model.name}
                          </div>
                          {(model.capabilities || model.contextWindow || model.outputWindow) && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              {/* Capabilities */}
                              <div className="flex items-center gap-1">
                                {model.capabilities?.vision && (
                                  <div title={t('settings.capabilities.vision')}>
                                    <Sparkles className="h-3 w-3" />
                                  </div>
                                )}
                                {model.capabilities?.tools && (
                                  <div title={t('settings.capabilities.tools')}>
                                    <Wrench className="h-3 w-3" />
                                  </div>
                                )}
                                {model.capabilities?.streaming && (
                                  <div title={t('settings.capabilities.streaming')}>
                                    <Zap className="h-3 w-3" />
                                  </div>
                                )}
                              </div>
                              {/* Context Window */}
                              {model.contextWindow && (
                                <span className="flex items-center gap-0.5">
                                  <FileText className="h-3 w-3" />
                                  <span className="text-[10px]">
                                    {formatContextWindow(model.contextWindow)}
                                  </span>
                                </span>
                              )}
                              {/* Output Window */}
                              {model.outputWindow && (
                                <span className="flex items-center gap-0.5">
                                  <Send className="h-3 w-3" />
                                  <span className="text-[10px]">
                                    {formatContextWindow(model.outputWindow)}
                                  </span>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
                      </button>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTestModel(effectiveProvider, model.id);
                        }}
                        disabled={testStatus === 'testing' && isTesting}
                        className={cn(
                          'h-7 px-2 shrink-0',
                          isTesting && testStatus === 'success' && 'text-green-600',
                          isTesting && testStatus === 'error' && 'text-red-600',
                        )}
                      >
                        {testStatus === 'testing' && isTesting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : testStatus === 'success' && isTesting ? (
                          <CheckCircle className="h-3.5 w-3.5" />
                        ) : testStatus === 'error' && isTesting ? (
                          <XCircle className="h-3.5 w-3.5" />
                        ) : (
                          <Zap className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>

                    {showTestResult && (
                      <div
                        className={cn(
                          'mx-3 mb-2 rounded-lg p-2 text-xs overflow-hidden',
                          testStatus === 'success' &&
                            'bg-green-50 text-green-700 border border-green-200',
                          testStatus === 'error' && 'bg-red-50 text-red-700 border border-red-200',
                        )}
                      >
                        <div className="flex items-start gap-2 min-w-0">
                          {testStatus === 'success' && (
                            <CheckCircle className="h-3 w-3 mt-0.5 shrink-0" />
                          )}
                          {testStatus === 'error' && (
                            <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
                          )}
                          <p className="flex-1 min-w-0 break-all">{testMessage}</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
