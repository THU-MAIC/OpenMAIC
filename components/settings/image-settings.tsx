'use client';

import { useState, useCallback, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Zap,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ImageProviderId } from '@/lib/media/types';

interface ImageSettingsProps {
  selectedProviderId: ImageProviderId;
}

export function ImageSettings({ selectedProviderId }: ImageSettingsProps) {
  const { t } = useI18n();

  const imageModelId = useSettingsStore((state) => state.imageModelId);
  const imageProvidersConfig = useSettingsStore((state) => state.imageProvidersConfig);
  const _setImageModelId = useSettingsStore((state) => state.setImageModelId);
  const setImageProviderConfig = useSettingsStore((state) => state.setImageProviderConfig);

  const [showApiKey, setShowApiKey] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  // Model dialog state
  const [showModelDialog, setShowModelDialog] = useState(false);
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null);
  const [modelForm, setModelForm] = useState({ id: '', name: '' });

  // Reset test state when provider changes (derived state pattern)
  const [prevSelectedProviderId, setPrevSelectedProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevSelectedProviderId) {
    setPrevSelectedProviderId(selectedProviderId);
    setTestStatus('idle');
    setTestMessage('');
  }

  const currentConfig = imageProvidersConfig[selectedProviderId];
  const currentProvider = IMAGE_PROVIDERS[selectedProviderId];
  const builtInModels = currentProvider?.models || [];
  const customModels = useMemo(
    () => currentConfig?.customModels || [],
    [currentConfig?.customModels],
  );
  const isServerConfigured = !!currentConfig?.isServerConfigured;

  const handleApiKeyChange = (apiKey: string) => {
    setImageProviderConfig(selectedProviderId, { apiKey });
  };

  const handleBaseUrlChange = (baseUrl: string) => {
    setImageProviderConfig(selectedProviderId, { baseUrl });
  };

  const handleTest = async () => {
    setTestLoading(true);
    setTestStatus('idle');
    setTestMessage('');
    try {
      const response = await fetch('/api/verify-image-provider', {
        method: 'POST',
        headers: {
          'x-image-provider': selectedProviderId,
          'x-image-model': imageModelId || '',
          'x-api-key': currentConfig?.apiKey || '',
          'x-base-url': currentConfig?.baseUrl || '',
        },
      });
      const data = await response.json();
      if (data.success) {
        setTestStatus('success');
        setTestMessage(t('settings.imageConnectivitySuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(`${t('settings.imageConnectivityFailed')}: ${data.message}`);
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(`${t('settings.imageConnectivityFailed')}: ${err}`);
    } finally {
      setTestLoading(false);
    }
  };

  // Model CRUD
  const handleOpenAddModel = () => {
    setEditingModelIndex(null);
    setModelForm({ id: '', name: '' });
    setShowModelDialog(true);
  };

  const handleOpenEditModel = (index: number) => {
    setEditingModelIndex(index);
    setModelForm({ ...customModels[index] });
    setShowModelDialog(true);
  };

  const handleSaveModel = useCallback(() => {
    if (!modelForm.id.trim()) return;
    const newCustomModels = [...customModels];
    if (editingModelIndex !== null) {
      newCustomModels[editingModelIndex] = {
        id: modelForm.id.trim(),
        name: modelForm.name.trim() || modelForm.id.trim(),
      };
    } else {
      newCustomModels.push({
        id: modelForm.id.trim(),
        name: modelForm.name.trim() || modelForm.id.trim(),
      });
    }
    setImageProviderConfig(selectedProviderId, {
      customModels: newCustomModels,
    });
    setShowModelDialog(false);
  }, [modelForm, editingModelIndex, customModels, selectedProviderId, setImageProviderConfig]);

  const handleDeleteModel = (index: number) => {
    const newCustomModels = customModels.filter((_, i) => i !== index);
    setImageProviderConfig(selectedProviderId, {
      customModels: newCustomModels,
    });
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* API Key + Test inline */}
      <div className="space-y-2">
        <Label>API Key</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              name={`image-api-key-${selectedProviderId}`}
              type={showApiKey ? 'text' : 'password'}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={
                isServerConfigured ? t('settings.optionalOverride') : t('settings.enterApiKey')
              }
              value={currentConfig?.apiKey || ''}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              className="h-8 pr-8"
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
            onClick={handleTest}
            disabled={testLoading || (!currentConfig?.apiKey && !isServerConfigured)}
            className="gap-1.5"
          >
            {testLoading ? (
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
                'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/50 dark:text-green-400 dark:border-green-800',
              testStatus === 'error' &&
                'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800',
            )}
          >
            <div className="flex items-start gap-2 min-w-0">
              {testStatus === 'success' && <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />}
              {testStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
              <p className="flex-1 min-w-0 break-all">{testMessage}</p>
            </div>
          </div>
        )}
      </div>

      {/* Base URL */}
      <div className="space-y-2">
        <Label>Base URL</Label>
        <Input
          name={`image-base-url-${selectedProviderId}`}
          type="url"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={currentConfig?.baseUrl || ''}
          onChange={(e) => handleBaseUrlChange(e.target.value)}
          placeholder={
            currentConfig?.serverBaseUrl ||
            currentProvider?.defaultBaseUrl ||
            t('settings.enterCustomBaseUrl')
          }
          className="h-8"
        />
        {(() => {
          const effectiveBaseUrl =
            currentConfig?.baseUrl ||
            currentConfig?.serverBaseUrl ||
            currentProvider?.defaultBaseUrl ||
            '';
          if (!effectiveBaseUrl) return null;
          return (
            <p className="text-xs text-muted-foreground break-all">
              {t('settings.requestUrl')}: {effectiveBaseUrl}
            </p>
          );
        })()}
      </div>

      {/* Model list */}
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Label className="text-base">{t('settings.models')}</Label>
          <Button variant="outline" size="sm" onClick={handleOpenAddModel} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            {t('settings.addNewModel')}
          </Button>
        </div>

        <div className="space-y-1.5">
          {/* Built-in models */}
          {builtInModels.map((model) => (
            <div
              key={model.id}
              className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-card"
            >
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm font-medium">{model.name}</div>
                <div className="text-xs text-muted-foreground font-mono mt-0.5">{model.id}</div>
              </div>
            </div>
          ))}

          {/* Custom models */}
          {customModels.map((model, index) => (
            <div
              key={`custom-${index}`}
              className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-card"
            >
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm font-medium">{model.name}</div>
                <div className="text-xs text-muted-foreground font-mono mt-0.5">{model.id}</div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  onClick={() => handleOpenEditModel(index)}
                  title={t('settings.editModel')}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => handleDeleteModel(index)}
                  title={t('settings.deleteModel')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Add/Edit Model Dialog */}
      <Dialog open={showModelDialog} onOpenChange={setShowModelDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>
            {editingModelIndex !== null ? t('settings.editModel') : t('settings.addNewModel')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {editingModelIndex !== null ? t('settings.editModel') : t('settings.addNewModel')}
          </DialogDescription>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label>{t('settings.modelId')}</Label>
              <Input
                value={modelForm.id}
                onChange={(e) => setModelForm((prev) => ({ ...prev, id: e.target.value }))}
                placeholder="e.g. my-custom-model-v1"
                className="h-8 font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('settings.modelName')}</Label>
              <Input
                value={modelForm.name}
                onChange={(e) => setModelForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. My Custom Model"
                className="h-8 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowModelDialog(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={handleSaveModel} disabled={!modelForm.id.trim()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
