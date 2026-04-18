'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  RotateCcw,
  Plus,
  Zap,
  Settings2,
  Trash2,
  Sparkles,
  Wrench,
  FileText,
  Send,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProviderConfig } from '@/lib/ai/providers';
import type { ProvidersConfig } from '@/lib/types/settings';
import { createVerifyModelRequest, formatContextWindow } from './utils';
import { cn } from '@/lib/utils';

interface ProviderConfigPanelProps {
  provider: ProviderConfig;
  initialApiKey: string;
  initialBaseUrl: string;
  initialRequiresApiKey: boolean;
  providersConfig: ProvidersConfig;
  onConfigChange: (apiKey: string, baseUrl: string, requiresApiKey: boolean) => void;
  onSave: () => void; // Auto-save on blur
  onEditModel: (index: number) => void;
  onDeleteModel: (index: number) => void;
  onAddModel: () => void;
  onResetToDefault?: () => void; // Reset provider to default configuration
  isBuiltIn: boolean; // To determine if reset button should be shown
}

export function ProviderConfigPanel({
  provider,
  initialApiKey,
  initialBaseUrl,
  initialRequiresApiKey,
  providersConfig,
  onConfigChange,
  onSave,
  onEditModel,
  onDeleteModel,
  onAddModel,
  onResetToDefault,
  isBuiltIn,
}: ProviderConfigPanelProps) {
  const { t } = useI18n();

  // Local state for this provider
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [requiresApiKey, setRequiresApiKey] = useState(initialRequiresApiKey);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [showResetDialog, setShowResetDialog] = useState(false);

  // Update local state when provider changes or initial values change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync local state from props on provider change
    setApiKey(initialApiKey);

    setBaseUrl(initialBaseUrl);

    setRequiresApiKey(initialRequiresApiKey);

    setTestStatus('idle');

    setTestMessage('');
  }, [provider.id, initialApiKey, initialBaseUrl, initialRequiresApiKey]);

  // Notify parent of changes
  const handleApiKeyChange = (key: string) => {
    setApiKey(key);
    onConfigChange(key, baseUrl, requiresApiKey);
  };

  const handleBaseUrlChange = (url: string) => {
    setBaseUrl(url);
    onConfigChange(apiKey, url, requiresApiKey);
  };

  const handleRequiresApiKeyChange = (requires: boolean) => {
    setRequiresApiKey(requires);
    onConfigChange(apiKey, baseUrl, requires);
  };

  const handleTestApi = useCallback(async () => {
    setTestStatus('testing');
    setTestMessage('');

    const availableModels = providersConfig[provider.id]?.models || [];

    if (availableModels.length === 0) {
      setTestStatus('error');
      setTestMessage(t('settings.noModelsAvailable') || 'No models available for testing');
      return;
    }

    const testModelId = availableModels[0].id;

    try {
      const response = await fetch('/api/verify-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          createVerifyModelRequest({
            providerId: provider.id,
            modelId: testModelId,
            apiKey,
            baseUrl,
            providerType: provider.type,
            requiresApiKey,
          }),
        ),
      });

      const data = await response.json();

      if (data.success) {
        setTestStatus('success');
        setTestMessage(t('settings.connectionSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(data.error || t('settings.connectionFailed'));
      }
    } catch (_error) {
      setTestStatus('error');
      setTestMessage(t('settings.connectionFailed'));
    }
  }, [apiKey, baseUrl, provider.id, provider.type, requiresApiKey, providersConfig, t]);

  const models = providersConfig[provider.id]?.models || [];
  const isServerConfigured = providersConfig[provider.id]?.isServerConfigured;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* API Key */}
      <div className="space-y-2">
        <Label>{t('settings.apiSecret')}</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              name={`llm-api-key-${provider.id}`}
              type={showApiKey ? 'text' : 'password'}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={isServerConfigured ? t('settings.optionalOverride') : 'sk-...'}
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              onBlur={onSave}
              disabled={!requiresApiKey && !isServerConfigured}
              className="h-8 pr-8"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              disabled={!requiresApiKey}
            >
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestApi}
            disabled={
              testStatus === 'testing' || (requiresApiKey && !apiKey && !isServerConfigured)
            }
            className="gap-1.5"
          >
            {testStatus === 'testing' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <Zap className="h-3.5 w-3.5" />
                {t('settings.testConnection')}
              </>
            )}
          </Button>
        </div>
        {testMessage && (
          <div
            className={cn(
              'rounded-lg p-3 text-sm overflow-hidden',
              testStatus === 'success' && 'bg-green-50 text-green-700 border border-green-200',
              testStatus === 'error' && 'bg-red-50 text-red-700 border border-red-200',
            )}
          >
            <div className="flex items-start gap-2 min-w-0">
              {testStatus === 'success' && <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />}
              {testStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
              <p className="flex-1 min-w-0 break-all">{testMessage}</p>
            </div>
          </div>
        )}
        <div className="flex items-center space-x-2">
          <Checkbox
            id={`requires-api-key-${provider.id}`}
            checked={requiresApiKey}
            onCheckedChange={(checked) => {
              handleRequiresApiKeyChange(checked as boolean);
              onSave();
            }}
          />
          <label
            htmlFor={`requires-api-key-${provider.id}`}
            className="text-sm cursor-pointer text-muted-foreground"
          >
            {t('settings.requiresApiKey')}
          </label>
        </div>
      </div>

      {/* API Host */}
      <div className="space-y-2">
        <Label>{t('settings.apiHost')}</Label>
        <Input
          name={`llm-base-url-${provider.id}`}
          type="url"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={provider.defaultBaseUrl || 'https://api.example.com/v1'}
          value={baseUrl}
          onChange={(e) => handleBaseUrlChange(e.target.value)}
          onBlur={onSave}
          className="h-8"
        />
        {provider.alternateBaseUrls && provider.alternateBaseUrls.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {provider.alternateBaseUrls.map((alt) => {
              const active = (baseUrl || provider.defaultBaseUrl) === alt.url;
              return (
                <button
                  key={alt.url}
                  type="button"
                  onClick={() => {
                    handleBaseUrlChange(alt.url);
                    onSave();
                  }}
                  className={cn(
                    'px-2 py-0.5 text-xs rounded-md border transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground border-border hover:bg-muted',
                  )}
                >
                  {t(alt.label)}
                </button>
              );
            })}
          </div>
        )}
        {(() => {
          const effectiveBaseUrl = baseUrl || provider.defaultBaseUrl || '';
          if (!effectiveBaseUrl) return null;

          // Generate endpoint path based on provider type
          let endpointPath = '';
          switch (provider.type) {
            case 'openai':
              endpointPath = '/chat/completions';
              break;
            case 'anthropic':
              endpointPath = '/messages';
              break;
            case 'google':
              endpointPath = '/models/[model]';
              break;
            default:
              endpointPath = '';
          }

          const fullUrl = effectiveBaseUrl + endpointPath;

          return (
            <p className="text-xs text-muted-foreground break-all">
              {t('settings.requestUrl')}: {fullUrl}
            </p>
          );
        })()}
      </div>

      {/* Models - No selection state, just list for management */}
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Label className="text-base">{t('settings.models')}</Label>
          <div className="flex items-center gap-2 flex-wrap">
            {isBuiltIn && onResetToDefault && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowResetDialog(true)}
                className="gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('settings.reset')}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onAddModel} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              {t('settings.addNewModel')}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.modelsManagementDescription')}</p>

        <div className="space-y-1.5">
          {models.map((model, index) => {
            return (
              <div
                key={model.id}
                className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-card"
              >
                <div className="flex-1">
                  <div className="font-mono text-sm font-medium mb-1.5">{model.name}</div>
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
                </div>

                {/* Edit/Delete Buttons */}
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2"
                    onClick={() => onEditModel(index)}
                    title={t('settings.editModel')}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => onDeleteModel(index)}
                    title={t('settings.deleteModel')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Reset Confirmation Dialog */}
      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.resetToDefault')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.resetConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowResetDialog(false);
                onResetToDefault?.();
              }}
            >
              {t('settings.confirmReset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
