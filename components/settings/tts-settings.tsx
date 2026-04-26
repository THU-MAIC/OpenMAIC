'use client';

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  Route,
  Server,
  Trash2,
  Upload,
  Wand2,
  FileAudio,
  Mic,
  Square,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import { useTTSPreview } from '@/lib/audio/use-tts-preview';
import { isCustomTTSProvider } from '@/lib/audio/types';
import {
  getVoxCPMProviderOptions,
  normalizeVoxCPMReferenceAudio,
  validateVoxCPMReferenceAudio,
  VOXCPM_REFERENCE_AUDIO_MAX_SECONDS,
  useVoxCPMVoiceProfiles,
} from '@/lib/audio/voxcpm-voices';
import {
  VOXCPM_BACKENDS,
  VOXCPM_TTS_PROVIDER_ID,
  buildVoxCPMBackendUrl,
  getVoxCPMBackendEndpoint,
  getVoxCPMProfileVoiceId,
  normalizeVoxCPMBackend,
  VOXCPM_VLLM_MODEL_ID,
  voxCPMBackendSupportsReferenceAudio,
} from '@/lib/audio/voxcpm';

const log = createLogger('TTSSettings');

interface TTSSettingsProps {
  selectedProviderId: TTSProviderId;
}

export function TTSSettings({ selectedProviderId }: TTSSettingsProps) {
  const { t, locale } = useI18n();

  const ttsVoice = useSettingsStore((state) => state.ttsVoice);
  const ttsSpeed = useSettingsStore((state) => state.ttsSpeed);
  const ttsProvidersConfig = useSettingsStore((state) => state.ttsProvidersConfig);
  const setTTSProviderConfig = useSettingsStore((state) => state.setTTSProviderConfig);
  const activeProviderId = useSettingsStore((state) => state.ttsProviderId);
  const setTTSVoice = useSettingsStore((state) => state.setTTSVoice);
  const removeCustomTTSProvider = useSettingsStore((state) => state.removeCustomTTSProvider);

  const ttsProvider = TTS_PROVIDERS[selectedProviderId as keyof typeof TTS_PROVIDERS];
  const isCustom = isCustomTTSProvider(selectedProviderId);
  const providerConfig = ttsProvidersConfig[selectedProviderId];
  const isServerConfigured = !!providerConfig?.isServerConfigured;
  const isVoxCPM = selectedProviderId === 'voxcpm-tts';
  const voxcpmBackend = normalizeVoxCPMBackend(providerConfig?.providerOptions?.backend);
  const requiresApiKey = isCustom
    ? !!providerConfig?.requiresApiKey
    : !!ttsProvider?.requiresApiKey;

  // When testing a non-active provider, use that provider's default voice
  // instead of the active provider's voice (which may be incompatible).
  const effectiveVoice =
    selectedProviderId === activeProviderId
      ? ttsVoice
      : isCustomTTSProvider(selectedProviderId)
        ? ((providerConfig?.customVoices as Array<{ id: string }> | undefined) || [])[0]?.id ||
          'default'
        : DEFAULT_TTS_VOICES[selectedProviderId as keyof typeof DEFAULT_TTS_VOICES] || 'default';

  const [showApiKey, setShowApiKey] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [testText, setTestText] = useState(t('settings.ttsTestTextDefault'));
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const { previewing: testingTTS, startPreview, stopPreview } = useTTSPreview();

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
  }, [selectedProviderId, stopPreview]);

  const handleTestTTS = async () => {
    if (!testText.trim()) return;

    setTestStatus('testing');
    setTestMessage('');

    try {
      const providerOptions =
        selectedProviderId === 'voxcpm-tts'
          ? {
              ...(ttsProvidersConfig[selectedProviderId]?.providerOptions || {}),
              ...(await getVoxCPMProviderOptions(effectiveVoice, { role: 'teacher', locale })),
            }
          : undefined;
      await startPreview({
        text: testText,
        providerId: selectedProviderId,
        modelId:
          ttsProvidersConfig[selectedProviderId]?.modelId || ttsProvider?.defaultModelId || '',
        voice: effectiveVoice,
        speed: ttsSpeed,
        apiKey: ttsProvidersConfig[selectedProviderId]?.apiKey,
        baseUrl:
          ttsProvidersConfig[selectedProviderId]?.serverBaseUrl ||
          ttsProvidersConfig[selectedProviderId]?.baseUrl ||
          providerConfig?.customDefaultBaseUrl ||
          '',
        providerOptions,
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

  const effectiveBaseUrl =
    ttsProvidersConfig[selectedProviderId]?.baseUrl ||
    (isCustom ? providerConfig?.customDefaultBaseUrl : ttsProvider?.defaultBaseUrl) ||
    '';
  const endpointPath = (() => {
    if (isCustom) return '/audio/speech';
    switch (selectedProviderId) {
      case 'openai-tts':
      case 'glm-tts':
        return '/audio/speech';
      case 'azure-tts':
        return '/cognitiveservices/v1';
      case 'qwen-tts':
        return '/services/aigc/multimodal-generation/generation';
      case 'voxcpm-tts':
        return getVoxCPMBackendEndpoint(voxcpmBackend);
      case 'elevenlabs-tts':
        return '/text-to-speech';
      case 'doubao-tts':
        return '/unidirectional';
      default:
        return '';
    }
  })();
  const requestUrl =
    effectiveBaseUrl && endpointPath
      ? selectedProviderId === 'voxcpm-tts'
        ? buildVoxCPMBackendUrl(effectiveBaseUrl, voxcpmBackend)
        : effectiveBaseUrl + endpointPath
      : '';
  const isVoxCPMVLLMOmni = voxcpmBackend === 'vllm-omni';

  return (
    <div className={cn('space-y-6', isVoxCPM ? 'max-w-5xl' : 'max-w-3xl')}>
      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* API Key & Base URL */}
      {(requiresApiKey || isServerConfigured || isCustom || isVoxCPM) &&
        (isVoxCPM ? (
          <div className="rounded-lg border border-border/60 bg-background px-3 py-2.5">
            <div className="flex flex-col gap-2 md:flex-row md:items-end">
              <div className="min-w-0 md:w-[150px] md:shrink-0">
                <Label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Server className="h-3 w-3" />
                  {t('settings.voxcpmBackend')}
                </Label>
                <Select
                  value={voxcpmBackend}
                  onValueChange={(backend) =>
                    setTTSProviderConfig(selectedProviderId, {
                      providerOptions: {
                        ...(providerConfig?.providerOptions || {}),
                        backend,
                      },
                    })
                  }
                >
                  <SelectTrigger size="sm" className="w-full rounded-md text-sm shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VOXCPM_BACKENDS.map((backend) => (
                      <SelectItem key={backend.id} value={backend.id}>
                        {backend.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="min-w-0 md:flex-1">
                <Label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  {t('settings.ttsBaseUrl')}
                </Label>
                <Input
                  name={`tts-base-url-${selectedProviderId}`}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={ttsProvider?.defaultBaseUrl || t('settings.enterCustomBaseUrl')}
                  value={ttsProvidersConfig[selectedProviderId]?.baseUrl || ''}
                  onChange={(e) =>
                    setTTSProviderConfig(selectedProviderId, {
                      baseUrl: e.target.value,
                    })
                  }
                  className="h-8 min-w-0 rounded-md font-mono text-sm shadow-none"
                />
              </div>

              {isVoxCPMVLLMOmni && (
                <div className="min-w-0 md:w-[130px] md:shrink-0">
                  <Label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    {t('media.model')}
                  </Label>
                  <Input
                    name={`tts-model-${selectedProviderId}`}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={VOXCPM_VLLM_MODEL_ID}
                    value={ttsProvidersConfig[selectedProviderId]?.modelId || ''}
                    onChange={(e) =>
                      setTTSProviderConfig(selectedProviderId, {
                        modelId: e.target.value,
                      })
                    }
                    className="h-8 min-w-0 rounded-md font-mono text-sm shadow-none"
                  />
                </div>
              )}
            </div>

            <div className="mt-2 flex min-w-0 items-center gap-2 rounded-md bg-muted/25 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              <span className="inline-flex shrink-0 items-center gap-1.5 font-medium">
                <Route className="h-3 w-3" />
                {t('settings.requestUrl')}
              </span>
              {requestUrl ? (
                <code
                  className="min-w-0 flex-1 truncate font-mono text-foreground/80"
                  title={requestUrl}
                >
                  {requestUrl}
                </code>
              ) : (
                <span className="min-w-0 flex-1 truncate">
                  {t('settings.voxcpmBaseUrlPending')}
                </span>
              )}
            </div>
          </div>
        ) : (
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
                  placeholder={
                    isCustom
                      ? providerConfig?.customDefaultBaseUrl || 'http://localhost:8000/v1'
                      : ttsProvider?.defaultBaseUrl || t('settings.enterCustomBaseUrl')
                  }
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
            {requestUrl && (
              <p className="break-all text-xs text-muted-foreground">
                {t('settings.requestUrl')}: {requestUrl}
              </p>
            )}
          </>
        ))}

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
              (requiresApiKey &&
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
      {ttsProvider?.models?.length > 0 && !isVoxCPM && (
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

      {selectedProviderId === 'voxcpm-tts' && <VoxCPMVoiceManager />}

      {/* Custom Voice List Management */}
      {isCustom && (
        <div className="space-y-3">
          <Label className="text-sm">{t('settings.customVoices')}</Label>
          {(providerConfig?.customVoices as Array<{ id: string; name: string }> | undefined)
            ?.length ? (
            <div className="rounded-lg border border-border/60 overflow-hidden">
              {/* Column headers */}
              <div className="grid grid-cols-[1fr_1fr_36px] gap-0 bg-muted/40 px-3 py-1.5 border-b border-border/40">
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                  ID
                </span>
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                  {t('settings.voiceNamePlaceholder')}
                </span>
                <span />
              </div>
              {/* Voice rows */}
              {(
                providerConfig?.customVoices as Array<{
                  id: string;
                  name: string;
                }>
              ).map((voice, index) => (
                <div
                  key={voice.id}
                  className={cn(
                    'grid grid-cols-[1fr_1fr_36px] gap-0 items-center px-3 py-2 group hover:bg-muted/20 transition-colors',
                    index > 0 && 'border-t border-border/30',
                  )}
                >
                  <span className="text-sm font-mono text-foreground/80 truncate pr-3">
                    {voice.id}
                  </span>
                  <span className="text-sm text-foreground/60 truncate pr-3">{voice.name}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const voices = [
                        ...(providerConfig?.customVoices as Array<{
                          id: string;
                          name: string;
                        }>),
                      ];
                      voices.splice(index, 1);
                      setTTSProviderConfig(selectedProviderId, {
                        customVoices: voices,
                      });
                    }}
                    className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground/50 italic">{t('settings.noVoicesAdded')}</p>
          )}
          <AddVoiceRow
            existingIds={(
              (providerConfig?.customVoices as Array<{ id: string; name: string }> | undefined) ||
              []
            ).map((v) => v.id)}
            onAdd={(voiceId, voiceName) => {
              const voices = [
                ...((providerConfig?.customVoices as
                  | Array<{ id: string; name: string }>
                  | undefined) || []),
                { id: voiceId, name: voiceName },
              ];
              setTTSProviderConfig(selectedProviderId, {
                customVoices: voices,
              } as Record<string, unknown>);
              // Auto-select the first voice if current voice is 'default'
              if (ttsVoice === 'default' && selectedProviderId === activeProviderId) {
                setTTSVoice(voiceId);
              }
            }}
          />
        </div>
      )}

      {/* Delete Custom Provider */}
      {isCustom && (
        <div className="pt-4 border-t">
          <Button variant="destructive" size="sm" onClick={() => setShowDeleteConfirm(true)}>
            {t('settings.deleteProvider')}
          </Button>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={showDeleteConfirm}
        onOpenChange={(open) => !open && setShowDeleteConfirm(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.deleteProvider')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.deleteProviderConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                removeCustomTTSProvider(selectedProviderId);
                setShowDeleteConfirm(false);
              }}
            >
              {t('settings.deleteProvider')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function VoxCPMVoiceManager() {
  const { t, locale } = useI18n();
  const { profiles, addPromptVoice, addCloneVoice, deleteVoice } = useVoxCPMVoiceProfiles();
  const ttsSpeed = useSettingsStore((state) => state.ttsSpeed);
  const ttsProvidersConfig = useSettingsStore((state) => state.ttsProvidersConfig);
  const { previewing, startPreview, stopPreview } = useTTSPreview();
  const voxcpmBackend = normalizeVoxCPMBackend(
    ttsProvidersConfig[VOXCPM_TTS_PROVIDER_ID]?.providerOptions?.backend,
  );
  const supportsReferenceAudio = voxCPMBackendSupportsReferenceAudio(voxcpmBackend);

  const [createMode, setCreateMode] = useState<'prompt' | 'clone'>('prompt');
  const [promptName, setPromptName] = useState('');
  const [voicePrompt, setVoicePrompt] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [clonePromptText, setClonePromptText] = useState('');
  const [cloneVoicePrompt, setCloneVoicePrompt] = useState('');
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [saving, setSaving] = useState<'prompt' | 'clone' | null>(null);
  const [isRecordingReference, setIsRecordingReference] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  };

  const stopRecordingStream = () => {
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
  };

  const startReferenceRecording = async () => {
    if (isRecordingReference) return;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t('settings.voxcpmRecordingUnsupported'));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined;
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      mediaRecorder.onstop = () => {
        void (async () => {
          const type = mediaRecorder.mimeType || 'audio/webm';
          const blob = new Blob(recordingChunksRef.current, { type });
          if (blob.size > 0) {
            try {
              const referenceAudio = await normalizeVoxCPMReferenceAudio(
                blob,
                `voxcpm-reference-${Date.now()}.webm`,
              );
              const file = new File([referenceAudio.blob], referenceAudio.name, {
                type: referenceAudio.mimeType,
              });
              setCloneFile(file);
              if (!cloneName.trim()) setCloneName(t('settings.voxcpmRecordedVoiceName'));
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : t('settings.voxcpmRecordingFailed'),
              );
            }
          }
          recordingChunksRef.current = [];
          setIsRecordingReference(false);
          setRecordingSeconds(0);
          stopRecordingTimer();
          stopRecordingStream();
        })();
      };

      mediaRecorder.start();
      setIsRecordingReference(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((seconds) => {
          const nextSeconds = seconds + 1;
          if (nextSeconds >= VOXCPM_REFERENCE_AUDIO_MAX_SECONDS) {
            stopReferenceRecording();
          }
          return nextSeconds;
        });
      }, 1000);
    } catch (error) {
      setIsRecordingReference(false);
      stopRecordingTimer();
      stopRecordingStream();
      toast.error(
        error instanceof Error ? error.message : t('settings.voxcpmRecordingStartFailed'),
      );
    }
  };

  const stopReferenceRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };

  useEffect(() => {
    return () => {
      stopRecordingTimer();
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      stopRecordingStream();
    };
  }, []);

  useEffect(() => {
    if (!previewing) setPreviewingVoiceId(null);
  }, [previewing]);

  const handlePreviewVoice = async (voiceId: string) => {
    if (previewingVoiceId === voiceId) {
      stopPreview();
      setPreviewingVoiceId(null);
      return;
    }

    const providerConfig = ttsProvidersConfig[VOXCPM_TTS_PROVIDER_ID];
    const baseUrl =
      providerConfig?.serverBaseUrl ||
      providerConfig?.baseUrl ||
      providerConfig?.customDefaultBaseUrl ||
      '';
    if (!baseUrl.trim()) {
      toast.error(t('settings.voxcpmBaseUrlRequired'));
      return;
    }

    setPreviewingVoiceId(voiceId);
    try {
      const providerOptions = await getVoxCPMProviderOptions(voiceId, {
        role: 'teacher',
        locale,
      });
      await startPreview({
        text: t('settings.ttsTestTextDefault'),
        providerId: VOXCPM_TTS_PROVIDER_ID,
        modelId:
          providerConfig?.modelId || TTS_PROVIDERS[VOXCPM_TTS_PROVIDER_ID]?.defaultModelId || '',
        voice: voiceId,
        speed: ttsSpeed,
        apiKey: providerConfig?.apiKey,
        baseUrl,
        providerOptions: {
          ...(providerConfig?.providerOptions || {}),
          ...providerOptions,
        },
      });
    } catch (error) {
      setPreviewingVoiceId(null);
      toast.error(error instanceof Error ? error.message : t('settings.voxcpmPreviewFailed'));
    }
  };

  const handleAddPromptVoice = async () => {
    if (!promptName.trim() || !voicePrompt.trim()) return;
    setSaving('prompt');
    try {
      await addPromptVoice({
        name: promptName,
        voicePrompt,
      });
      setPromptName('');
      setVoicePrompt('');
      toast.success(t('settings.voxcpmVoiceSaved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.voxcpmVoiceSaveFailed'));
    } finally {
      setSaving(null);
    }
  };

  const handleCloneFileChange = async (file: File | null) => {
    if (!file) {
      setCloneFile(null);
      return;
    }
    try {
      await validateVoxCPMReferenceAudio(file);
      setCloneFile(file);
    } catch (error) {
      setCloneFile(null);
      toast.error(
        error instanceof Error ? error.message : t('settings.voxcpmReferenceAudioInvalid'),
      );
    }
  };

  const handleAddCloneVoice = async () => {
    if (!cloneName.trim() || !cloneFile) return;
    setSaving('clone');
    try {
      await addCloneVoice({
        name: cloneName,
        referenceAudio: cloneFile,
        referenceAudioName: cloneFile.name,
        referenceAudioMimeType: cloneFile.type,
        promptText: clonePromptText,
        voicePrompt: cloneVoicePrompt,
      });
      setCloneName('');
      setClonePromptText('');
      setCloneVoicePrompt('');
      setCloneFile(null);
      toast.success(t('settings.voxcpmCloneSaved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.voxcpmCloneSaveFailed'));
    } finally {
      setSaving(null);
    }
  };

  const promptCount = profiles.filter((profile) => profile.kind !== 'clone').length;
  const cloneCount = profiles.filter((profile) => profile.kind === 'clone').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Label className="text-base font-semibold">{t('settings.voxcpmVoicesTitle')}</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings.voxcpmVoicesDescription')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {t('settings.voxcpmAutoVoicePrivacyNote')}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="rounded-md border border-border/60 px-2 py-1">
            {t('settings.voxcpmPromptCount', { count: promptCount + 1 })}
          </span>
          <span className="rounded-md border border-border/60 px-2 py-1">
            {t('settings.voxcpmCloneCount', { count: cloneCount })}
          </span>
          {!supportsReferenceAudio && (
            <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300">
              {t('settings.voxcpmCloneUnsupported')}
            </span>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/70 bg-background">
        <div className="grid lg:grid-cols-[minmax(280px,0.95fr)_minmax(0,1.15fr)]">
          <section className="border-b border-border/60 lg:border-b-0 lg:border-r">
            <div className="flex h-12 items-center justify-between border-b border-border/60 px-4">
              <span className="text-sm font-medium">{t('settings.voxcpmVoicePool')}</span>
              <span className="text-xs text-muted-foreground">
                {t('settings.voxcpmVoiceCount', { count: profiles.length + 1 })}
              </span>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <VoiceProfileRow
                icon={<Wand2 className="h-4 w-4" />}
                title={t('settings.voxcpmAutoVoice')}
                badge={t('toolbar.default')}
                badgeTone="default"
                detail={t('settings.voxcpmAutoVoiceDescription')}
                kind="auto"
              />
              {profiles.length > 0 ? (
                profiles.map((profile) => {
                  const voiceId = getVoxCPMProfileVoiceId(profile.id);
                  const canPreview = profile.kind !== 'clone' || supportsReferenceAudio;
                  return (
                    <VoiceProfileRow
                      key={profile.id}
                      icon={
                        profile.kind === 'clone' ? (
                          <FileAudio className="h-4 w-4" />
                        ) : (
                          <Wand2 className="h-4 w-4" />
                        )
                      }
                      title={profile.name}
                      badge={
                        profile.kind === 'clone' && !supportsReferenceAudio
                          ? t('settings.voxcpmUnavailable')
                          : profile.kind === 'clone'
                            ? t('settings.voxcpmClone')
                            : 'Prompt'
                      }
                      badgeTone={
                        profile.kind === 'clone' && !supportsReferenceAudio ? 'warning' : 'neutral'
                      }
                      detail={
                        profile.kind === 'clone' && !supportsReferenceAudio
                          ? t('settings.voxcpmCloneUnsupportedDetail')
                          : profile.kind === 'clone'
                            ? profile.referenceAudioName || 'reference audio'
                            : profile.voicePrompt || ''
                      }
                      kind={profile.kind === 'clone' ? 'clone' : 'prompt'}
                      muted={profile.kind === 'clone' && !supportsReferenceAudio}
                      previewing={canPreview && previewingVoiceId === voiceId}
                      onPreview={canPreview ? () => handlePreviewVoice(voiceId) : undefined}
                      onDelete={async () => {
                        await deleteVoice(profile.id);
                      }}
                    />
                  );
                })
              ) : (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground/60">
                  {t('settings.voxcpmNoCustomVoices')}
                </div>
              )}
            </div>
          </section>

          <section className="p-4">
            <Tabs
              value={createMode}
              onValueChange={(value) => setCreateMode(value as typeof createMode)}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TabsList className="h-9 rounded-md bg-muted p-1">
                  <TabsTrigger value="prompt" className="gap-1.5 rounded-sm px-3 text-sm">
                    <Wand2 className="h-3.5 w-3.5" />
                    Prompt
                  </TabsTrigger>
                  <TabsTrigger value="clone" className="gap-1.5 rounded-sm px-3 text-sm">
                    <Upload className="h-3.5 w-3.5" />
                    {t('settings.voxcpmClone')}
                  </TabsTrigger>
                </TabsList>
                {createMode === 'clone' && !supportsReferenceAudio && (
                  <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300">
                    {t('settings.voxcpmCloneSaveOnly')}
                  </span>
                )}
              </div>

              <TabsContent value="prompt" className="mt-4 space-y-3">
                <Input
                  value={promptName}
                  onChange={(e) => setPromptName(e.target.value)}
                  placeholder={t('settings.voxcpmVoiceNamePlaceholder')}
                  className="h-10 rounded-md text-sm"
                />
                <Textarea
                  value={voicePrompt}
                  onChange={(e) => setVoicePrompt(e.target.value)}
                  placeholder={t('settings.voxcpmPromptPlaceholder')}
                  className="min-h-28 resize-none rounded-md text-sm"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={handleAddPromptVoice}
                    disabled={saving === 'prompt' || !promptName.trim() || !voicePrompt.trim()}
                    className="h-9 gap-1.5 rounded-md"
                  >
                    {saving === 'prompt' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    {t('settings.voxcpmAddVoice')}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="clone" className="mt-4 space-y-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                  <Input
                    value={cloneName}
                    onChange={(e) => setCloneName(e.target.value)}
                    placeholder={t('settings.voxcpmCloneVoiceNamePlaceholder')}
                    className="h-10 rounded-md text-sm"
                  />
                  <label className="inline-flex h-10 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent hover:text-accent-foreground">
                    <Upload className="h-3.5 w-3.5 shrink-0" />
                    <span className="max-w-[180px] truncate">
                      {cloneFile ? cloneFile.name : t('settings.voxcpmUploadReferenceAudio')}
                    </span>
                    <input
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={(e) => {
                        void handleCloneFileChange(e.target.files?.[0] || null);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <Button
                    type="button"
                    variant={isRecordingReference ? 'destructive' : 'outline'}
                    size="sm"
                    onClick={
                      isRecordingReference ? stopReferenceRecording : startReferenceRecording
                    }
                    className="h-10 gap-2 rounded-md"
                  >
                    {isRecordingReference ? (
                      <>
                        <Square className="h-3.5 w-3.5" />
                        {formatRecordingTime(recordingSeconds)}
                      </>
                    ) : (
                      <>
                        <Mic className="h-3.5 w-3.5" />
                        {t('settings.voxcpmRecord')}
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground/70">
                  {t('settings.voxcpmReferenceAudioLimitHint')}
                </p>
                <Textarea
                  value={clonePromptText}
                  onChange={(e) => setClonePromptText(e.target.value)}
                  placeholder={t('settings.voxcpmReferenceTextPlaceholder')}
                  className="min-h-20 resize-none rounded-md text-sm"
                />
                <Input
                  value={cloneVoicePrompt}
                  onChange={(e) => setCloneVoicePrompt(e.target.value)}
                  placeholder={t('settings.voxcpmVoiceDescriptionPlaceholder')}
                  className="h-10 rounded-md text-sm"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={handleAddCloneVoice}
                    disabled={saving === 'clone' || !cloneName.trim() || !cloneFile}
                    className="h-9 gap-1.5 rounded-md"
                  >
                    {saving === 'clone' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Plus className="h-3.5 w-3.5" />
                    )}
                    {t('settings.voxcpmAddClone')}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </section>
        </div>
      </div>
    </div>
  );
}

function formatRecordingTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function VoiceProfileRow({
  icon,
  title,
  badge,
  badgeTone = 'neutral',
  detail,
  kind = 'prompt',
  muted,
  previewing,
  onPreview,
  onDelete,
}: {
  icon: ReactNode;
  title: string;
  badge: string;
  badgeTone?: 'default' | 'warning' | 'neutral';
  detail: string;
  kind?: 'auto' | 'prompt' | 'clone';
  muted?: boolean;
  previewing?: boolean;
  onPreview?: () => void;
  onDelete?: () => void | Promise<void>;
}) {
  const iconClassName =
    kind === 'auto'
      ? 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
      : kind === 'clone'
        ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
        : 'bg-muted text-muted-foreground';
  const badgeClassName =
    badgeTone === 'default'
      ? 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800/70 dark:bg-violet-950/40 dark:text-violet-300'
      : badgeTone === 'warning'
        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-300'
        : 'border-border/70 bg-background text-muted-foreground';
  const { t } = useI18n();

  return (
    <div
      className={cn(
        'group relative flex min-h-16 items-center gap-3 border-t border-border/50 px-4 py-3 first:border-t-0',
        muted ? 'opacity-60' : 'hover:bg-muted/35',
      )}
    >
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
          iconClassName,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          <span
            className={cn(
              'rounded-md border px-1.5 py-0.5 text-[10px] leading-none',
              badgeClassName,
            )}
          >
            {badge}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      {onPreview && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onPreview()}
          aria-label={
            previewing ? t('settings.voxcpmStopPreview') : t('settings.voxcpmPreviewVoice')
          }
          className="h-8 w-8 text-muted-foreground opacity-70 hover:text-foreground group-hover:opacity-100"
        >
          {previewing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
        </Button>
      )}
      {onDelete && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void onDelete()}
          aria-label={t('settings.voxcpmDeleteVoice')}
          className="h-8 w-8 text-muted-foreground opacity-70 hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

function AddVoiceRow({
  onAdd,
  existingIds,
}: {
  onAdd: (id: string, name: string) => void;
  existingIds: string[];
}) {
  const { t } = useI18n();
  const [voiceId, setVoiceId] = useState('');
  const [voiceName, setVoiceName] = useState('');

  const handleAdd = () => {
    if (!voiceId.trim()) return;
    if (existingIds.includes(voiceId.trim())) {
      toast.error('Duplicate ID');
      return;
    }
    onAdd(voiceId.trim(), voiceName.trim() || voiceId.trim());
    setVoiceId('');
    setVoiceName('');
  };

  return (
    <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
      <Input
        value={voiceId}
        onChange={(e) => setVoiceId(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        className="text-sm font-mono"
        placeholder={t('settings.voiceIdPlaceholder')}
      />
      <Input
        value={voiceName}
        onChange={(e) => setVoiceName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        className="text-sm"
        placeholder={t('settings.voiceNamePlaceholder')}
      />
      <Button
        variant="outline"
        size="sm"
        onClick={handleAdd}
        disabled={!voiceId.trim()}
        className="shrink-0 gap-1"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('settings.addVoice')}
      </Button>
    </div>
  );
}
