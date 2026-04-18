'use client';

import { useState, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import {
  Eye,
  EyeOff,
  Trash2,
  Settings2,
  Plus,
  Zap,
  Loader2,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { ToolEditDialog } from './tool-edit-dialog';
import { WebSearchModelDialog } from './web-search-model-dialog';

interface WebSearchSettingsProps {
  selectedProviderId: WebSearchProviderId;
}

export function WebSearchSettings({ selectedProviderId }: WebSearchSettingsProps) {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);
  const [isToolDialogOpen, setIsToolDialogOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<{ type: string; name: string } | null>(null);
  const [editingToolIndex, setEditingToolIndex] = useState<number | null>(null);
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<{ id: string; name: string } | null>(null);
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const webSearchProvidersConfig = useSettingsStore((state) => state.webSearchProvidersConfig);
  const setWebSearchProviderConfig = useSettingsStore((state) => state.setWebSearchProviderConfig);

  const provider = WEB_SEARCH_PROVIDERS[selectedProviderId];
  const isServerConfigured = !!webSearchProvidersConfig[selectedProviderId]?.isServerConfigured;

  const isModelValid = useCallback(
    async (providerId: string, modelId?: string): Promise<{ status: boolean; error?: string }> => {
      const config = webSearchProvidersConfig[selectedProviderId];
      const apiKey = config?.apiKey || '';
      const baseUrl =
        config?.baseUrl || WEB_SEARCH_PROVIDERS[selectedProviderId]?.defaultBaseUrl || '';

      switch (providerId) {
        case 'tavily': {
          const response = await fetch('/api/web-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: 'test connection',
              baseUrl,
              apiKey,
              providerId: providerId,
              providerConfig: { baseUrl: baseUrl || undefined },
            }),
          });
          const data = await response.json();
          return Promise.resolve({ status: data.success || response.ok, error: data.error });
        }
        case 'claude': {
          // Use verify-model endpoint with the selected (or default) model
          const model = modelId || config?.modelId || 'claude-haiku-4-5';
          const response = await fetch('/api/web-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: 'test connection',
              apiKey,
              providerType: 'anthropic',
              providerId: providerId,
              requiresApiKey: !isServerConfigured,
              providerConfig: {
                baseUrl,
                modelId: model,
                tools: [],
              },
            }),
          });
          const data = await response.json();
          return Promise.resolve({ status: data.success, error: data.error });
        }
        default: {
          return Promise.reject({ status: false });
        }
      }
    },
    [webSearchProvidersConfig, isServerConfigured, selectedProviderId],
  );

  const handleTestConnection = useCallback(async () => {
    try {
      setTestStatus('testing');
      setTestMessage('');
      const { status, error } = await isModelValid(selectedProviderId);
      if (status) {
        setTestStatus('success');
        setTestMessage(t('settings.connectionSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(error || t('settings.connectionFailed'));
      }
    } catch {
      setTestStatus('error');
      setTestMessage(t('settings.connectionFailed'));
    }
  }, [selectedProviderId, isModelValid, t]);

  // Guard against undefined provider
  if (!provider) {
    return null;
  }

  const tools = webSearchProvidersConfig[selectedProviderId]?.tools || [];
  const models = webSearchProvidersConfig[selectedProviderId]?.models || [];

  const handleAddTool = () => {
    setEditingTool({ type: '', name: '' });
    setEditingToolIndex(null);
    setIsToolDialogOpen(true);
  };

  const handleEditTool = (tool: { type: string; name: string }, index: number) => {
    setEditingTool({ ...tool });
    setEditingToolIndex(index);
    setIsToolDialogOpen(true);
  };

  const handleSaveTool = () => {
    if (!editingTool) return;

    const newTools = [...tools];
    if (editingToolIndex !== null) {
      newTools[editingToolIndex] = { type: editingTool.type.trim(), name: editingTool.name.trim() };
    } else {
      newTools.push({ type: editingTool.type.trim(), name: editingTool.name.trim() });
    }
    setWebSearchProviderConfig(selectedProviderId, { tools: newTools });
    setIsToolDialogOpen(false);
    setEditingTool(null);
    setEditingToolIndex(null);
  };

  const handleDeleteTool = (index: number) => {
    const newTools = tools.filter((_, i) => i !== index);
    setWebSearchProviderConfig(selectedProviderId, { tools: newTools });
  };

  const handleAddModel = () => {
    setEditingModel({ id: '', name: '' });
    setEditingModelIndex(null);
    setIsModelDialogOpen(true);
  };

  const handleEditModel = (model: { id: string; name: string }, index: number) => {
    setEditingModel({ ...model });
    setEditingModelIndex(index);
    setIsModelDialogOpen(true);
  };

  const handleSaveModel = () => {
    if (!editingModel) return;

    const trimmedId = editingModel.id.trim();
    const trimmedName = editingModel.name.trim();
    const isDuplicate = models.some((m, i) => m.id === trimmedId && i !== editingModelIndex);
    if (isDuplicate) {
      toast.error(t('settings.webSearchModelIdDuplicate'));
      return;
    }

    const newModels = [...models];
    if (editingModelIndex !== null) {
      newModels[editingModelIndex] = { id: trimmedId, name: trimmedName };
    } else {
      newModels.push({ id: trimmedId, name: trimmedName });
    }
    setWebSearchProviderConfig(selectedProviderId, { models: newModels });
    setIsModelDialogOpen(false);
    setEditingModel(null);
    setEditingModelIndex(null);
  };

  const handleDeleteModel = (index: number) => {
    const newModels = models.filter((_, i) => i !== index);
    setWebSearchProviderConfig(selectedProviderId, { models: newModels });
  };

  const getApiKeyLabel = (selectedProviderId: string) => {
    switch (selectedProviderId) {
      case 'claude': {
        return t('settings.webSearchClaudeApiKey');
      }
      case 'tavily': {
        return t('settings.webSearchTavilyApiKey');
      }
      default:
        return t('settings.webSearchApiKey');
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {(provider.requiresApiKey || isServerConfigured) && (
        <>
          {/* API Key */}
          <div className="space-y-2">
            <Label className="text-sm">{getApiKeyLabel(selectedProviderId)}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  name={`web-search-api-key-${selectedProviderId}`}
                  type={showApiKey ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={
                    isServerConfigured ? t('settings.optionalOverride') : t('settings.enterApiKey')
                  }
                  value={webSearchProvidersConfig[selectedProviderId]?.apiKey || ''}
                  onChange={(e) =>
                    setWebSearchProviderConfig(selectedProviderId, {
                      apiKey: e.target.value,
                    })
                  }
                  className="font-mono text-sm pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestConnection}
                disabled={
                  testStatus === 'testing' ||
                  (provider.requiresApiKey &&
                    !webSearchProvidersConfig[selectedProviderId]?.apiKey &&
                    !isServerConfigured)
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
                  testStatus === 'success' &&
                    'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800',
                  testStatus === 'error' &&
                    'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800',
                )}
              >
                <div className="flex items-start gap-2 min-w-0">
                  {testStatus === 'success' && <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />}
                  {testStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                  <p className="flex-1 min-w-0 break-all">{testMessage}</p>
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('settings.webSearchApiKeyHint')}</p>
          </div>

          {/* Base URL */}
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.webSearchBaseUrl')}</Label>
            <Input
              name={`web-search-base-url-${selectedProviderId}`}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={provider.defaultBaseUrl || 'https://api.example.com'}
              value={
                webSearchProvidersConfig[selectedProviderId]?.baseUrl ===
                (WEB_SEARCH_PROVIDERS[selectedProviderId]?.defaultBaseUrl ?? '')
                  ? ''
                  : webSearchProvidersConfig[selectedProviderId]?.baseUrl || ''
              }
              onChange={(e) =>
                setWebSearchProviderConfig(selectedProviderId, {
                  baseUrl: e.target.value,
                })
              }
              className="text-sm"
            />
            {(() => {
              const effectiveBaseUrl =
                webSearchProvidersConfig[selectedProviderId]?.baseUrl ||
                provider.defaultBaseUrl ||
                '';
              if (!effectiveBaseUrl) return null;
              const endpointPath = WEB_SEARCH_PROVIDERS[selectedProviderId]?.path || '';
              return (
                <p className="text-xs text-muted-foreground break-all">
                  {t('settings.requestUrl')}: {effectiveBaseUrl}
                  {endpointPath}
                </p>
              );
            })()}
          </div>

          {selectedProviderId === 'claude' && (
            <div className="space-y-6 pt-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">
                    {t('settings.webSearchModelsConfiguration')}
                  </Label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleAddModel}
                    className="h-7 gap-1"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>{t('settings.webSearchNewModel')}</span>
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {models.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">
                      {t('settings.webSearchNoModels')} {t('settings.webSearchNoModelsHint')}
                    </p>
                  ) : (
                    models.map((model, index) => (
                      <div
                        key={model.id}
                        className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-card"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-sm font-medium">{model.name}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{model.id}</div>
                        </div>
                        <div className="flex items-center gap-1 ml-2 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => handleEditModel(model, index)}
                          >
                            <Settings2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => handleDeleteModel(index)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">
                    {t('settings.webSearchToolsConfiguration')}
                  </Label>
                  <Button size="sm" variant="outline" onClick={handleAddTool} className="h-7 gap-1">
                    <Plus className="h-3.5 w-3.5" />
                    <span>{t('settings.webSearchNewTool')}</span>
                  </Button>
                </div>
                <div className="space-y-2">
                  {tools.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">
                      {t('settings.webSearchNoTools')}
                    </p>
                  ) : (
                    tools.map((tool, index) => (
                      <div
                        key={`${tool.type}-${tool.name}-${index}`}
                        className="flex items-center justify-between p-2 rounded-md border bg-background text-sm"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium">{tool.name}</span>
                          <span className="text-xs text-muted-foreground font-mono">
                            {tool.type}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => handleEditTool(tool, index)}
                          >
                            <Settings2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => handleDeleteTool(index)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <ToolEditDialog
        open={isToolDialogOpen}
        onOpenChange={setIsToolDialogOpen}
        tool={editingTool}
        setTool={setEditingTool}
        onSave={handleSaveTool}
      />

      <WebSearchModelDialog
        open={isModelDialogOpen}
        onOpenChange={setIsModelDialogOpen}
        model={editingModel}
        setModel={setEditingModel}
        onSave={handleSaveModel}
        isEditing={editingModelIndex !== null}
        isModelValid={isModelValid}
        apiKey={webSearchProvidersConfig[selectedProviderId]?.apiKey || ''}
        providerId={selectedProviderId || ''}
        isServerConfigured={isServerConfigured}
      />
    </div>
  );
}
