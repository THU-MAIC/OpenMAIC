'use client';

import { useState, useRef } from 'react';
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
import { getValidASRLanguage, useSettingsStore } from '@/lib/store/settings';
import { ASR_PROVIDERS } from '@/lib/audio/constants';
import { regionalEndpointTemplate } from '@/lib/config/official-endpoints';
import type { ASRProviderId } from '@/lib/audio/types';
import { Mic, MicOff, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { normalizeASRUploadAudio } from '@/lib/audio/wav-utils';
import { modelChange, modelRef } from '@/lib/model-settings/edit';
import {
  ApiKeyField,
  ApiKeySecurityNotice,
  EndpointServerOnlyHint,
  RegionalEndpointField,
  ServerConfiguredNotice,
  ServerOnlyNotice,
  reportApply,
  rootUse,
  saveServiceProvider,
  type ServicePanelProps,
} from './server-settings';

const log = createLogger('ASRSettings');

/** Language names for the recognition language picker, in the UI language (codes as a fallback). */
function languageName(code: string, locale: string): string {
  if (code === 'auto') return code;
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * A speech recognition service: its key (write-only), a recording test on the
 * server with the saved configuration, its model (the workspace's while it is
 * in use), and the language the user's speech input listens for.
 */
export function ASRSettings({ view, apply, entry }: ServicePanelProps) {
  const { t, locale } = useI18n();

  const asrLanguage = useSettingsStore((state) => state.asrLanguage);
  const setASRLanguage = useSettingsStore((state) => state.setASRLanguage);

  const providerId = entry.registryId as ASRProviderId;
  const asrProvider = ASR_PROVIDERS[providerId as keyof typeof ASR_PROVIDERS];
  const regionalEndpoint = regionalEndpointTemplate('asr', providerId);
  const isBrowser = providerId === 'browser-native';
  const editable = (entry.state === 'workspace' || entry.state === 'available') && !isBrowser;
  const use = rootUse(view, 'asr', entry.id);
  const languages = asrProvider?.supportedLanguages ?? [];
  const effectiveLanguage = getValidASRLanguage(providerId, asrLanguage);
  const modelId = use.modelId || asrProvider?.defaultModelId;

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [asrResult, setASRResult] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const canTest = isBrowser || !!entry.provider;

  const handleToggleASRRecording = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
      return;
    }
    setASRResult('');
    setTestStatus('testing');
    setTestMessage('');

    if (isBrowser) {
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
      recognition.lang = effectiveLanguage || 'zh-CN';
      recognition.onresult = (event: {
        results: { [index: number]: { [index: number]: { transcript: string } } };
      }) => {
        setASRResult(event.results[0][0].transcript);
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
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      const audioChunks: Blob[] = [];
      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setIsProcessing(true);
        try {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          const uploadAudio = await normalizeASRUploadAudio(providerId, audioBlob);
          const formData = new FormData();
          formData.append('audio', uploadAudio.blob, uploadAudio.fileName);
          // The saved service is tested with the server's configuration of it.
          formData.append('previewProvider', entry.id);
          if (use.inUse && use.modelId) formData.append('previewModel', use.modelId);
          formData.append('language', effectiveLanguage);
          const response = await fetch('/api/transcription', { method: 'POST', body: formData });
          if (response.ok) {
            const data = await response.json();
            if (data.text?.trim()) {
              setASRResult(data.text);
              setTestStatus('success');
              setTestMessage(t('settings.asrTestSuccess'));
            } else {
              setTestStatus('error');
              setTestMessage(data.error || t('settings.asrNoTranscription'));
            }
          } else {
            setTestStatus('error');
            const errorData = await response.json().catch(() => ({ error: response.statusText }));
            setTestMessage(errorData.details || errorData.error || t('settings.asrTestFailed'));
          }
        } catch (error) {
          log.error('ASR test failed:', error);
          setTestStatus('error');
          setTestMessage(
            error instanceof Error && error.message
              ? `${t('settings.asrTestFailed')}: ${error.message}`
              : t('settings.asrTestFailed'),
          );
        } finally {
          setIsProcessing(false);
        }
      };
      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      log.error('Failed to access microphone:', error);
      setTestStatus('error');
      setTestMessage(t('settings.microphoneAccessFailed'));
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {entry.state === 'deployment' && <ServerConfiguredNotice />}
      {entry.state === 'server-only' && (
        <ServerOnlyNotice policy={!view.policy.allowWorkspaceProviders} />
      )}

      {/* API Key & Base URL — the server's services are the operator's. */}
      {editable && (
        <>
          <ApiKeySecurityNotice />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.asrApiKey')}</Label>
              <ApiKeyField
                name={`asr-api-key-${entry.id}`}
                provider={entry.provider}
                inputClassName="font-mono text-sm"
                onSave={(apiKey) => saveServiceProvider(view, apply, entry, { apiKey }, t)}
                onRemove={() => saveServiceProvider(view, apply, entry, { apiKey: '' }, t)}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.asrBaseUrl')}</Label>
              {regionalEndpoint ? (
                // Azure Speech takes its official endpoint for the key's region.
                <RegionalEndpointField
                  name={`asr-endpoint-${entry.id}`}
                  provider={entry.provider}
                  template={regionalEndpoint}
                  onSave={(baseUrl) => saveServiceProvider(view, apply, entry, { baseUrl }, t)}
                />
              ) : (
                <>
                  {asrProvider?.defaultBaseUrl && (
                    <p className="text-xs text-muted-foreground break-all">
                      {t('settings.requestUrl')}: {asrProvider.defaultBaseUrl}
                    </p>
                  )}
                  <EndpointServerOnlyHint />
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* Test ASR */}
      {entry.state !== 'server-only' && (
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
              onClick={() => void handleToggleASRRecording()}
              disabled={isProcessing || !canTest}
              className="gap-2 w-[140px]"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('settings.asrProcessing')}
                </>
              ) : isRecording ? (
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
      )}

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

      {/* Model: the workspace's speech recognition model while this service is in use. */}
      {asrProvider?.models?.length > 0 && entry.state !== 'server-only' && (
        <div className="space-y-2">
          <Label className="text-sm">{t('settings.defaultModel')}</Label>
          <Select
            value={modelId}
            disabled={!use.inUse || !use.slot || use.slot.locked}
            onValueChange={async (value) => {
              if (!use.slot) return;
              reportApply(await apply(modelChange(use.slot, modelRef(entry.id, value)), view), t);
            }}
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
          {!use.inUse && (
            <p className="text-xs text-muted-foreground">
              {t('settings.serverConfig.modelWhenInUse')}
            </p>
          )}
        </div>
      )}

      {/* The language the user's speech input listens for (kept per user). */}
      {languages.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm">{t('settings.asrLanguage')}</Label>
          <Select value={effectiveLanguage} onValueChange={setASRLanguage}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {languages.map((code) => (
                <SelectItem key={code} value={code}>
                  {languageName(code, locale)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
