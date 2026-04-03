'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { ASR_PROVIDERS } from '@/lib/audio/constants';
import type { ASRProviderId } from '@/lib/audio/types';
import { Mic, MicOff, CheckCircle2, XCircle, Eye, EyeOff, Plus, Settings2, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { MediaModelEditDialog } from './media-model-edit-dialog';

const log = createLogger('ASRSettings');

interface ASRSettingsProps {
  selectedProviderId: ASRProviderId;
}

export function ASRSettings({ selectedProviderId }: ASRSettingsProps) {
  const { t } = useI18n();

  const asrLanguage = useSettingsStore((state) => state.asrLanguage);
  const asrProvidersConfig = useSettingsStore((state) => state.asrProvidersConfig);
  const setASRProviderConfig = useSettingsStore((state) => state.setASRProviderConfig);

  const [showApiKey, setShowApiKey] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [asrResult, setASRResult] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  
  // Model dialog state
  const [showModelDialog, setShowModelDialog] = useState(false);
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null);
  const [modelDialogData, setModelDialogData] = useState<{ id: string; name: string }>({ id: '', name: '' });

  const asrProvider = ASR_PROVIDERS[selectedProviderId] ?? ASR_PROVIDERS['openai-whisper'];
  const isServerConfigured = !!asrProvidersConfig[selectedProviderId]?.isServerConfigured;
  const customModels = useMemo(
    () => asrProvidersConfig[selectedProviderId]?.customModels || [],
    [asrProvidersConfig[selectedProviderId]?.customModels],
  );

  // Reset state when provider changes (derived state pattern)
  const [prevProviderId, setPrevProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevProviderId) {
    setPrevProviderId(selectedProviderId);
    setShowApiKey(false);
    setTestStatus('idle');
    setTestMessage('');
    setASRResult('');
    setShowModelDialog(false);
    setEditingModelIndex(null);
  }

  const handleToggleASRRecording = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
    } else {
      setASRResult('');
      setTestStatus('testing');
      setTestMessage('');

      if (selectedProviderId === 'browser-native') {
        const SpeechRecognitionCtor =
          (window as unknown as Record<string, unknown>).SpeechRecognition ||
          (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
        if (!SpeechRecognitionCtor) {
          setTestStatus('error');
          setTestMessage(t('settings.asrNotSupported'));
          return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Vendor-prefixed API without standard typings
        const recognition = new (SpeechRecognitionCtor as new () => any)();
        recognition.lang = asrLanguage || 'zh-CN';
        recognition.onresult = (event: {
          results: {
            [index: number]: { [index: number]: { transcript: string } };
          };
        }) => {
          const transcript = event.results[0][0].transcript;
          setASRResult(transcript);
          setTestStatus('success');
          setTestMessage(t('settings.asrTestSuccess'));
        };
        recognition.onerror = (event: { error: string }) => {
          setTestStatus('error');
          setTestMessage(t('settings.asrTestFailed') + ': ' + event.error);
        };
        recognition.onend = () => {
          setIsRecording(false);
        };
        recognition.start();
        setIsRecording(true);
      } else {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          const mediaRecorder = new MediaRecorder(stream);
          mediaRecorderRef.current = mediaRecorder;
          const audioChunks: Blob[] = [];
          mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
          };
          mediaRecorder.onstop = async () => {
            stream.getTracks().forEach((track) => track.stop());
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const formData = new FormData();
            formData.append('audio', audioBlob, 'recording.webm');
            formData.append('providerId', selectedProviderId);
            formData.append(
              'modelId',
              asrProvidersConfig[selectedProviderId]?.modelId || asrProvider.defaultModelId,
            );
            formData.append('language', asrLanguage);
            const apiKeyValue = asrProvidersConfig[selectedProviderId]?.apiKey;
            if (apiKeyValue?.trim()) formData.append('apiKey', apiKeyValue);
            const baseUrlValue = asrProvidersConfig[selectedProviderId]?.baseUrl;
            if (baseUrlValue?.trim()) formData.append('baseUrl', baseUrlValue);

            try {
              const response = await fetch('/api/transcription', {
                method: 'POST',
                body: formData,
              });
              if (response.ok) {
                const data = await response.json();
                setASRResult(data.text);
                setTestStatus('success');
                setTestMessage(t('settings.asrTestSuccess'));
              } else {
                setTestStatus('error');
                const errorData = await response
                  .json()
                  .catch(() => ({ error: response.statusText }));
                setTestMessage(errorData.details || errorData.error || t('settings.asrTestFailed'));
              }
            } catch (error) {
              log.error('ASR test failed:', error);
              setTestStatus('error');
              setTestMessage(t('settings.asrTestFailed'));
            }
          };
          mediaRecorder.start();
          setIsRecording(true);
        } catch (error) {
          log.error('Failed to access microphone:', error);
          setTestStatus('error');
          setTestMessage(t('settings.microphoneAccessFailed'));
        }
      }
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
    setASRProviderConfig(selectedProviderId, {
      customModels: newCustomModels,
    });
    setShowModelDialog(false);
  }, [modelDialogData, editingModelIndex, customModels, selectedProviderId, setASRProviderConfig]);

  const handleDeleteModel = (index: number) => {
    const newCustomModels = customModels.filter((_, i) => i !== index);
    setASRProviderConfig(selectedProviderId, {
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
      {(asrProvider.requiresApiKey || isServerConfigured) && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.asrApiKey')}</Label>
              <div className="relative">
                <Input
                  name={`asr-api-key-${selectedProviderId}`}
                  type={showApiKey ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={
                    isServerConfigured ? t('settings.optionalOverride') : t('settings.enterApiKey')
                  }
                  value={asrProvidersConfig[selectedProviderId]?.apiKey || ''}
                  onChange={(e) =>
                    setASRProviderConfig(selectedProviderId, {
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
              <Label className="text-sm">{t('settings.asrBaseUrl')}</Label>
              <Input
                name={`asr-base-url-${selectedProviderId}`}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={asrProvider.defaultBaseUrl || t('settings.enterCustomBaseUrl')}
                value={asrProvidersConfig[selectedProviderId]?.baseUrl || ''}
                onChange={(e) =>
                  setASRProviderConfig(selectedProviderId, {
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
              asrProvidersConfig[selectedProviderId]?.baseUrl || asrProvider.defaultBaseUrl || '';
            if (!effectiveBaseUrl) return null;
            let endpointPath = '';
            switch (selectedProviderId) {
              case 'openai-whisper':
                endpointPath = '/audio/transcriptions';
                break;
              case 'qwen-asr':
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

      {/* Test ASR */}
      <div className="space-y-2">
        <Label className="text-sm">{t('settings.testASR')}</Label>
        <div className="flex gap-2">
          <Input
            value={asrResult}
            readOnly
            placeholder={t('settings.asrResultPlaceholder')}
            className="flex-1 bg-muted/50"
          />
          <Button
            onClick={handleToggleASRRecording}
            disabled={
              asrProvider.requiresApiKey &&
              !asrProvidersConfig[selectedProviderId]?.apiKey?.trim() &&
              !isServerConfigured
            }
            className="gap-2 w-[140px]"
          >
            {isRecording ? (
              <>
                <MicOff className="h-4 w-4" />
                {t('settings.stopRecording')}
              </>
            ) : (
              <>
                <Mic className="h-4 w-4" />
                {t('settings.startRecording')}
              </>
            )}
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

      {/* Model Selection */}
      {asrProvider.models.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm">{t('settings.ttsModel')}</Label>
          <Select
            value={asrProvidersConfig[selectedProviderId]?.modelId || asrProvider.defaultModelId}
            onValueChange={(value) => setASRProviderConfig(selectedProviderId, { modelId: value })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {asrProvider.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Custom Models Section (OpenAI Compatible) */}
      {selectedProviderId === 'openai-compatible-asr' && (
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
      )}

      {/* Model Edit Dialog */}
      <MediaModelEditDialog
        open={showModelDialog}
        onOpenChange={setShowModelDialog}
        mediaType="asr"
        modelId={modelDialogData.id}
        onModelIdChange={(id) => setModelDialogData((prev) => ({ ...prev, id }))}
        modelName={modelDialogData.name}
        onModelNameChange={(name) => setModelDialogData((prev) => ({ ...prev, name }))}
        apiKey={asrProvidersConfig[selectedProviderId]?.apiKey || ''}
        baseUrl={asrProvidersConfig[selectedProviderId]?.baseUrl || ''}
        providerId={selectedProviderId}
        language={asrLanguage}
        onSave={handleSaveModel}
        isEditing={editingModelIndex !== null}
      />
    </div>
  );
}
