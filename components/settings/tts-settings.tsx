'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { TTS_PROVIDERS, DEFAULT_TTS_VOICES } from '@/lib/audio/constants';
import type { TTSProviderId } from '@/lib/audio/types';
import {
  Volume2,
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Plus,
  Settings2,
  Trash2,
  Circle,
  CircleDot,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('TTSSettings');

interface TTSSettingsProps {
  selectedProviderId: TTSProviderId;
}

export function TTSSettings({ selectedProviderId }: TTSSettingsProps) {
  const { t } = useI18n();

  const ttsModelId = useSettingsStore((state) => state.ttsModelId);
  const ttsVoice = useSettingsStore((state) => state.ttsVoice);
  const ttsSpeed = useSettingsStore((state) => state.ttsSpeed);
  const ttsProvidersConfig = useSettingsStore((state) => state.ttsProvidersConfig);
  const setTTSProviderConfig = useSettingsStore((state) => state.setTTSProviderConfig);
  const setTTSModelId = useSettingsStore((state) => state.setTTSModelId);
  const activeProviderId = useSettingsStore((state) => state.ttsProviderId);

  // When testing a non-active provider, use that provider's default voice
  // instead of the active provider's voice (which may be incompatible)
  const effectiveVoice =
    selectedProviderId === activeProviderId
      ? ttsVoice
      : DEFAULT_TTS_VOICES[selectedProviderId] || 'default';

  const ttsProvider = TTS_PROVIDERS[selectedProviderId] ?? TTS_PROVIDERS['openai-tts'];
  const builtInModels = useMemo(() => ttsProvider.models || [], [ttsProvider.models]);
  const customModels = useMemo(
    () => ttsProvidersConfig[selectedProviderId]?.customModels || [],
    [selectedProviderId, ttsProvidersConfig],
  );
  const isServerConfigured = !!ttsProvidersConfig[selectedProviderId]?.isServerConfigured;

  const [showApiKey, setShowApiKey] = useState(false);
  const [testingTTS, setTestingTTS] = useState(false);
  const [testText, setTestText] = useState(t('settings.ttsTestTextDefault'));
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [showModelDialog, setShowModelDialog] = useState(false);
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null);
  const [modelForm, setModelForm] = useState({ id: '', name: '' });
  const audioRef = useRef<HTMLAudioElement>(null);

  // Update test text when language changes
  useEffect(() => {
    setTestText(t('settings.ttsTestTextDefault'));
  }, [t]);

  // Reset state when provider changes
  useEffect(() => {
    setShowApiKey(false);
    setTestStatus('idle');
    setTestMessage('');
  }, [selectedProviderId]);

  useEffect(() => {
    const availableModelIds = new Set([
      ...builtInModels.map((model) => model.id),
      ...customModels.map((model) => model.id),
    ]);
    if (availableModelIds.size > 0 && !availableModelIds.has(ttsModelId)) {
      const nextModelId = builtInModels[0]?.id || customModels[0]?.id || '';
      if (nextModelId) setTTSModelId(nextModelId);
    }
  }, [builtInModels, customModels, ttsModelId, setTTSModelId]);

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
    const nextCustomModels = [...customModels];
    const normalizedModel = {
      id: modelForm.id.trim(),
      name: modelForm.name.trim() || modelForm.id.trim(),
    };
    if (editingModelIndex !== null) {
      nextCustomModels[editingModelIndex] = normalizedModel;
    } else {
      nextCustomModels.push(normalizedModel);
    }
    setTTSProviderConfig(selectedProviderId, { customModels: nextCustomModels });
    setTTSModelId(normalizedModel.id);
    setShowModelDialog(false);
  }, [
    customModels,
    editingModelIndex,
    modelForm,
    selectedProviderId,
    setTTSModelId,
    setTTSProviderConfig,
  ]);

  const handleDeleteModel = (index: number) => {
    const targetModel = customModels[index];
    const nextCustomModels = customModels.filter((_, i) => i !== index);
    setTTSProviderConfig(selectedProviderId, { customModels: nextCustomModels });
    if (ttsModelId === targetModel?.id) {
      const nextModelId = builtInModels[0]?.id || nextCustomModels[0]?.id || '';
      setTTSModelId(nextModelId);
    }
  };

  const handleTestTTS = async () => {
    if (!testText.trim()) return;
    setTestingTTS(true);
    setTestStatus('testing');
    setTestMessage('');

    try {
      if (selectedProviderId === 'browser-native-tts') {
        if (!('speechSynthesis' in window)) {
          setTestStatus('error');
          setTestMessage(t('settings.browserTTSNotSupported'));
          return;
        }

        const utterance = new SpeechSynthesisUtterance(testText);
        utterance.rate = ttsSpeed;
        const voices = window.speechSynthesis.getVoices();
        const selectedVoice = voices.find(
          (v) => v.name === effectiveVoice || v.lang === effectiveVoice,
        );
        if (selectedVoice) utterance.voice = selectedVoice;

        await new Promise<void>((resolve, reject) => {
          utterance.onend = () => resolve();
          utterance.onerror = (event) => reject(new Error(event.error));
          window.speechSynthesis.speak(utterance);
        });

        setTestStatus('success');
        setTestMessage(t('settings.ttsTestSuccess'));
        return;
      }

      const requestBody: Record<string, unknown> = {
        text: testText,
        audioId: 'tts-test',
        ttsProviderId: selectedProviderId,
        ttsModelId,
        ttsVoice: effectiveVoice,
        ttsSpeed: ttsSpeed,
      };
      const apiKeyValue = ttsProvidersConfig[selectedProviderId]?.apiKey;
      if (apiKeyValue?.trim()) requestBody.ttsApiKey = apiKeyValue;
      const baseUrlValue = ttsProvidersConfig[selectedProviderId]?.baseUrl;
      if (baseUrlValue?.trim()) requestBody.ttsBaseUrl = baseUrlValue;

      const response = await fetch('/api/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const data = await response
        .json()
        .catch(() => ({ success: false, error: response.statusText }));
      if (response.ok && data.success) {
        const binaryStr = atob(data.base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const audioBlob = new Blob([bytes], { type: `audio/${data.format}` });
        const audioUrl = URL.createObjectURL(audioBlob);
        if (audioRef.current) {
          audioRef.current.src = audioUrl;
          await audioRef.current.play();
        }
        setTestStatus('success');
        setTestMessage(t('settings.ttsTestSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(data.error || t('settings.ttsTestFailed'));
      }
    } catch (error) {
      log.error('TTS test failed:', error);
      setTestStatus('error');
      setTestMessage(
        error instanceof Error && error.message
          ? `${t('settings.ttsTestFailed')}: ${error.message}`
          : t('settings.ttsTestFailed'),
      );
    } finally {
      setTestingTTS(false);
    }
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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.ttsApiKey')}</Label>
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  placeholder={
                    isServerConfigured ? t('settings.optionalOverride') : t('settings.enterApiKey')
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
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.ttsBaseUrl')}</Label>
              <Input
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

      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Label className="text-base">{t('settings.models')}</Label>
          <Button variant="outline" size="sm" onClick={handleOpenAddModel} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            {t('settings.addNewModel')}
          </Button>
        </div>

        <div className="space-y-1.5">
          {builtInModels.map((model) => {
            const selected = ttsModelId === model.id;
            return (
              <button
                key={model.id}
                type="button"
                onClick={() => setTTSModelId(model.id)}
                className={cn(
                  'w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors',
                  selected
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-border/50 bg-card hover:bg-muted/40',
                )}
              >
                {selected ? (
                  <CircleDot className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm font-medium">{model.name}</div>
                  <div className="text-xs text-muted-foreground font-mono mt-0.5">{model.id}</div>
                </div>
              </button>
            );
          })}

          {customModels.map((model, index) => {
            const selected = ttsModelId === model.id;
            return (
              <div
                key={`custom-${index}`}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border transition-colors',
                  selected
                    ? 'border-primary/50 bg-primary/5'
                    : 'border-border/50 bg-card hover:bg-muted/40',
                )}
              >
                <button
                  type="button"
                  onClick={() => setTTSModelId(model.id)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                >
                  {selected ? (
                    <CircleDot className="h-4 w-4 shrink-0 text-primary" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm font-medium">{model.name}</div>
                    <div className="text-xs text-muted-foreground font-mono mt-0.5">{model.id}</div>
                  </div>
                </button>
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
            );
          })}
        </div>
      </div>

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
                placeholder="e.g. my-custom-tts-model"
                className="h-8 font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('settings.modelName')}</Label>
              <Input
                value={modelForm.name}
                onChange={(e) => setModelForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. My Custom TTS Model"
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

      <audio ref={audioRef} className="hidden" />
    </div>
  );
}
