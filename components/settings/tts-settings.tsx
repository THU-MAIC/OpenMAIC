'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { TTS_PROVIDERS, DEFAULT_TTS_VOICES } from '@/lib/audio/constants';
import type { TTSProviderId } from '@/lib/audio/types';
import { Volume2, Loader2, CheckCircle2, XCircle, Eye, EyeOff, Plus, Settings2, Trash2, ChevronUp, ChevronDown, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { useTTSPreview } from '@/lib/audio/use-tts-preview';
import { MediaModelEditDialog } from './media-model-edit-dialog';

const log = createLogger('TTSSettings');

interface TTSSettingsProps {
  selectedProviderId: TTSProviderId;
}

export function TTSSettings({ selectedProviderId }: TTSSettingsProps) {
  const { t } = useI18n();

  const ttsVoice = useSettingsStore((state) => state.ttsVoice);
  const ttsSpeed = useSettingsStore((state) => state.ttsSpeed);
  const ttsProvidersConfig = useSettingsStore((state) => state.ttsProvidersConfig);
  const setTTSProviderConfig = useSettingsStore((state) => state.setTTSProviderConfig);
  const activeProviderId = useSettingsStore((state) => state.ttsProviderId);

  // When testing a non-active provider, use that provider's default voice
  // instead of the active provider's voice (which may be incompatible).
  const effectiveVoice =
    selectedProviderId === activeProviderId
      ? ttsVoice
      : DEFAULT_TTS_VOICES[selectedProviderId] || 'default';

  const ttsProvider = TTS_PROVIDERS[selectedProviderId] ?? TTS_PROVIDERS['openai-tts'];
  const isServerConfigured = !!ttsProvidersConfig[selectedProviderId]?.isServerConfigured;
  const customModels = useMemo(
    () => ttsProvidersConfig[selectedProviderId]?.customModels || [],
    [ttsProvidersConfig[selectedProviderId]?.customModels],
  );

  const [showApiKey, setShowApiKey] = useState(false);
  const [testText, setTestText] = useState(t('settings.ttsTestTextDefault'));
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const { previewing: testingTTS, startPreview, stopPreview } = useTTSPreview();
  
  // Model dialog state
  const [showModelDialog, setShowModelDialog] = useState(false);
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null);
  const [modelDialogData, setModelDialogData] = useState<{ id: string; name: string }>({ id: '', name: '' });

  // Doubao TTS uses compound "appId:accessKey" — split for separate UI fields
  const isDoubao = selectedProviderId === 'doubao-tts';
  const rawApiKey = ttsProvidersConfig[selectedProviderId]?.apiKey || '';
  const doubaoColonIdx = rawApiKey.indexOf(':');
  const doubaoAppId = isDoubao && doubaoColonIdx > 0 ? rawApiKey.slice(0, doubaoColonIdx) : '';
  const doubaoAccessKey =
    isDoubao && doubaoColonIdx > 0
      ? rawApiKey.slice(doubaoColonIdx + 1)
      : isDoubao
        ? rawApiKey
        : '';

  const setDoubaoCompoundKey = (appId: string, accessKey: string) => {
    const combined = appId && accessKey ? `${appId}:${accessKey}` : appId || accessKey;
    setTTSProviderConfig(selectedProviderId, { apiKey: combined });
  };

  // Keep the sample text in sync with locale changes.
  useEffect(() => {
    setTestText(t('settings.ttsTestTextDefault'));
  }, [t]);

  // Reset transient UI state when switching providers.
  useEffect(() => {
    stopPreview();
    setShowApiKey(false);
    setTestStatus('idle');
    setTestMessage('');
    setShowModelDialog(false);
    setEditingModelIndex(null);
  }, [selectedProviderId, stopPreview]);

  const handleTestTTS = async () => {
    if (!testText.trim()) return;

    setTestStatus('testing');
    setTestMessage('');

    try {
      // For OpenAI Compatible, use first custom model if available
      let modelId = ttsProvidersConfig[selectedProviderId]?.modelId || ttsProvider.defaultModelId;
      if (selectedProviderId === 'openai-compatible-tts' && customModels.length > 0) {
        modelId = customModels[0].id;
      }
      
      // For OpenAI Compatible TTS, use custom voice if configured
      let voiceToTest = effectiveVoice;
      if (selectedProviderId === 'openai-compatible-tts') {
        const customVoice = ttsProvidersConfig[selectedProviderId]?.providerOptions?.customVoice as string | undefined;
        if (customVoice?.trim()) {
          voiceToTest = customVoice.trim();
        }
      }

      await startPreview({
        text: testText,
        providerId: selectedProviderId,
        modelId,
        voice: voiceToTest,
        speed: ttsSpeed,
        apiKey: ttsProvidersConfig[selectedProviderId]?.apiKey,
        baseUrl: ttsProvidersConfig[selectedProviderId]?.baseUrl,
      });
      setTestStatus('success');
      setTestMessage(t('settings.ttsTestSuccess'));
    } catch (error) {
      log.error('TTS test failed:', error);
      setTestStatus('error');
      setTestMessage(
        error instanceof Error && error.message
          ? `${t('settings.ttsTestFailed')}: ${error.message}`
          : t('settings.ttsTestFailed'),
      );
    }
  };

  // Model CRUD
  const handleOpenAddModel = () => {
    setEditingModelIndex(null);
    setModelDialogData({ id: '', name: '' });
    setShowModelDialog(true);
  };

  const handleOpenEditModel = (index: number) => {
    setEditingModelIndex(index);
    setModelDialogData({ ...customModels[index] });
    setShowModelDialog(true);
  };

  const handleSaveModel = useCallback(() => {
    if (!modelDialogData.id.trim()) return;
    const newCustomModels = [...customModels];
    if (editingModelIndex !== null) {
      newCustomModels[editingModelIndex] = {
        id: modelDialogData.id.trim(),
        name: modelDialogData.name.trim() || modelDialogData.id.trim(),
      };
    } else {
      newCustomModels.push({
        id: modelDialogData.id.trim(),
        name: modelDialogData.name.trim() || modelDialogData.id.trim(),
      });
    }
    setTTSProviderConfig(selectedProviderId, {
      customModels: newCustomModels,
    });
    setShowModelDialog(false);
  }, [modelDialogData, editingModelIndex, customModels, selectedProviderId, setTTSProviderConfig]);

  const handleDeleteModel = (index: number) => {
    const newCustomModels = customModels.filter((_, i) => i !== index);
    setTTSProviderConfig(selectedProviderId, {
      customModels: newCustomModels,
    });
  };

  const handleMoveModel = (fromIndex: number, direction: 'up' | 'down') => {
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= customModels.length) return;

    const newCustomModels = [...customModels];
    [newCustomModels[fromIndex], newCustomModels[toIndex]] = [
      newCustomModels[toIndex],
      newCustomModels[fromIndex],
    ];
    setTTSProviderConfig(selectedProviderId, {
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

      {/* API Key & Base URL */}
      {(ttsProvider.requiresApiKey || isServerConfigured) && (
        <>
          <div className={cn('grid gap-4', isDoubao ? 'grid-cols-3' : 'grid-cols-2')}>
            {isDoubao ? (
              <>
                <div className="space-y-2">
                  <Label className="text-sm">{t('settings.doubaoAppId')}</Label>
                  <div className="relative">
                    <Input
                      name={`tts-app-id-${selectedProviderId}`}
                      type={showApiKey ? 'text' : 'password'}
                      autoComplete="new-password"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={
                        isServerConfigured
                          ? t('settings.optionalOverride')
                          : t('settings.enterApiKey')
                      }
                      value={doubaoAppId}
                      onChange={(e) => setDoubaoCompoundKey(e.target.value, doubaoAccessKey)}
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
                </div>
                <div className="space-y-2">
                  <Label className="text-sm">{t('settings.doubaoAccessKey')}</Label>
                  <div className="relative">
                    <Input
                      name={`tts-access-key-${selectedProviderId}`}
                      type={showApiKey ? 'text' : 'password'}
                      autoComplete="new-password"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={
                        isServerConfigured
                          ? t('settings.optionalOverride')
                          : t('settings.enterApiKey')
                      }
                      value={doubaoAccessKey}
                      onChange={(e) => setDoubaoCompoundKey(doubaoAppId, e.target.value)}
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
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label className="text-sm">{t('settings.ttsApiKey')}</Label>
                <div className="relative">
                  <Input
                    name={`tts-api-key-${selectedProviderId}`}
                    type={showApiKey ? 'text' : 'password'}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={
                      isServerConfigured
                        ? t('settings.optionalOverride')
                        : t('settings.enterApiKey')
                    }
                    value={ttsProvidersConfig[selectedProviderId]?.apiKey || ''}
                    onChange={(e) =>
                      setTTSProviderConfig(selectedProviderId, {
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
              </div>
            )}
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.ttsBaseUrl')}</Label>
              <Input
                name={`tts-base-url-${selectedProviderId}`}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={ttsProvider.defaultBaseUrl || t('settings.enterCustomBaseUrl')}
                value={ttsProvidersConfig[selectedProviderId]?.baseUrl || ''}
                onChange={(e) =>
                  setTTSProviderConfig(selectedProviderId, {
                    baseUrl: e.target.value,
                  })
                }
                className="text-sm"
              />
            </div>
          </div>
          {/* Request URL Preview */}
          {(() => {
            const effectiveBaseUrl =
              ttsProvidersConfig[selectedProviderId]?.baseUrl || ttsProvider.defaultBaseUrl || '';
            if (!effectiveBaseUrl) return null;
            let endpointPath = '';
            switch (selectedProviderId) {
              case 'openai-tts':
              case 'glm-tts':
                endpointPath = '/audio/speech';
                break;
              case 'azure-tts':
                endpointPath = '/cognitiveservices/v1';
                break;
              case 'qwen-tts':
                endpointPath = '/services/aigc/multimodal-generation/generation';
                break;
              case 'elevenlabs-tts':
                endpointPath = '/text-to-speech';
                break;
              case 'doubao-tts':
                endpointPath = '/unidirectional';
                break;
            }
            if (!endpointPath) return null;
            return (
              <p className="text-xs text-muted-foreground break-all">
                {t('settings.requestUrl')}: {effectiveBaseUrl + endpointPath}
              </p>
            );
          })()}
        </>
      )}

      {/* Test TTS */}
      <div className="space-y-2">
        <Label className="text-sm">{t('settings.testTTS')}</Label>
        <div className="flex gap-2">
          <Input
            placeholder={t('settings.ttsTestTextPlaceholder')}
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            className="flex-1"
          />
          <Button
            onClick={handleTestTTS}
            disabled={
              testingTTS ||
              !testText.trim() ||
              (ttsProvider.requiresApiKey &&
                !ttsProvidersConfig[selectedProviderId]?.apiKey?.trim() &&
                !isServerConfigured)
            }
            size="default"
            className="gap-2 w-32"
          >
            {testingTTS ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )}
            {t('settings.testTTS')}
          </Button>
        </div>
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

      {/* Available Models */}
      {ttsProvider.models.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">{t('settings.availableModels')}</Label>
          <div className="flex flex-wrap gap-2">
            {ttsProvider.models.map((model) => (
              <div
                key={model.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted/50 border border-border/40 text-xs font-mono text-muted-foreground"
              >
                <span className="size-1.5 rounded-full bg-emerald-500/70" />
                {model.name}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground/60">
            {t('settings.modelSelectedViaVoice')}
          </p>
        </div>
      )}

      {/* Custom Models Section (OpenAI Compatible) */}
      {selectedProviderId === 'openai-compatible-tts' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <Label className="text-base">{t('settings.customModels')}</Label>
            <Button variant="outline" size="sm" onClick={handleOpenAddModel} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              {t('settings.addNewModel')}
            </Button>
          </div>

          <div className="space-y-1.5">
            {customModels.map((model, index) => (
              <div
                key={`custom-${index}`}
                className={cn(
                  'flex items-center justify-between p-3 rounded-lg border transition-colors',
                  index === 0
                    ? 'border-emerald-500/50 bg-emerald-50 dark:bg-emerald-950/20'
                    : 'border-border/50 bg-card',
                )}
              >
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  {index === 0 && (
                    <Star className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm font-medium flex items-center gap-2">
                      {model.name}
                      {index === 0 && (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400 font-normal">
                          {t('settings.defaultModel')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono mt-0.5">{model.id}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2"
                    onClick={() => handleMoveModel(index, 'up')}
                    disabled={index === 0}
                    title="Move up"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2"
                    onClick={() => handleMoveModel(index, 'down')}
                    disabled={index === customModels.length - 1}
                    title="Move down"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
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
      )}

      {/* Supported Voices & Custom Voice Selection (OpenAI Compatible) */}
      {selectedProviderId === 'openai-compatible-tts' && (
        <>
          {/* Supported Voices List */}
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.supportedVoices')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.supportedVoicesDescription')}
            </p>
            <Input
              placeholder="e.g., aiden, dylan, eric, ryan, serena, vivian"
              value={(ttsProvidersConfig[selectedProviderId]?.providerOptions?.supportedVoices as string) || ''}
              onChange={(e) => {
                const voices = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
                setTTSProviderConfig(selectedProviderId, {
                  providerOptions: {
                    ...ttsProvidersConfig[selectedProviderId]?.providerOptions,
                    supportedVoices: voices.length > 0 ? voices.join(',') : undefined,
                    // Reset customVoice if it's not in the new list
                    customVoice: voices.length > 0 ? voices[0] : undefined,
                  },
                });
              }}
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground/60">
              {t('settings.supportedVoicesHint')}
            </p>
          </div>

          {/* Custom Voice Selection */}
          {(() => {
            const supportedVoicesStr = (ttsProvidersConfig[selectedProviderId]?.providerOptions?.supportedVoices as string) || '';
            const voiceList = supportedVoicesStr.split(',').map((v) => v.trim()).filter(Boolean);
            if (voiceList.length === 0) return null;
            
            const selectedVoice = (ttsProvidersConfig[selectedProviderId]?.providerOptions?.customVoice as string) || voiceList[0];
            
            return (
              <div className="space-y-2">
                <Label className="text-sm">{t('settings.defaultVoice')}</Label>
                <Select
                  value={selectedVoice}
                  onValueChange={(value) =>
                    setTTSProviderConfig(selectedProviderId, {
                      providerOptions: {
                        ...ttsProvidersConfig[selectedProviderId]?.providerOptions,
                        customVoice: value,
                      },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {voiceList.map((voice) => (
                      <SelectItem key={voice} value={voice}>
                        {voice}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground/60">
                  {t('settings.defaultVoiceHint')}
                </p>
              </div>
            );
          })()}
        </>
      )}

      {/* Model Edit Dialog */}
      <MediaModelEditDialog
        open={showModelDialog}
        onOpenChange={setShowModelDialog}
        mediaType="tts"
        modelId={modelDialogData.id}
        onModelIdChange={(id) => setModelDialogData((prev) => ({ ...prev, id }))}
        modelName={modelDialogData.name}
        onModelNameChange={(name) => setModelDialogData((prev) => ({ ...prev, name }))}
        apiKey={ttsProvidersConfig[selectedProviderId]?.apiKey || ''}
        baseUrl={ttsProvidersConfig[selectedProviderId]?.baseUrl || ''}
        providerId={selectedProviderId}
        onSave={handleSaveModel}
        isEditing={editingModelIndex !== null}
      />
    </div>
  );
}
