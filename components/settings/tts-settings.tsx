'use client';

import { useState, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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
import { Volume2, Loader2, CheckCircle2, XCircle, Eye, EyeOff, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import { useTTSPreview } from '@/lib/audio/use-tts-preview';
import { isCustomTTSProvider } from '@/lib/audio/types';

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
  const setTTSVoice = useSettingsStore((state) => state.setTTSVoice);
  const removeCustomTTSProvider = useSettingsStore((state) => state.removeCustomTTSProvider);

  const ttsProvider = TTS_PROVIDERS[selectedProviderId as keyof typeof TTS_PROVIDERS];
  const isCustom = isCustomTTSProvider(selectedProviderId);
  const providerConfig = ttsProvidersConfig[selectedProviderId];
  const isServerConfigured = !!providerConfig?.isServerConfigured;
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
      await startPreview({
        text: testText,
        providerId: selectedProviderId,
        modelId:
          ttsProvidersConfig[selectedProviderId]?.modelId || ttsProvider?.defaultModelId || '',
        voice: effectiveVoice,
        speed: ttsSpeed,
        apiKey: ttsProvidersConfig[selectedProviderId]?.apiKey,
        baseUrl:
          ttsProvidersConfig[selectedProviderId]?.baseUrl ||
          providerConfig?.customDefaultBaseUrl ||
          '',
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

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* API Key & Base URL */}
      {(requiresApiKey || isServerConfigured || isCustom) && (
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
          {/* Request URL Preview */}
          {(() => {
            const effectiveBaseUrl =
              ttsProvidersConfig[selectedProviderId]?.baseUrl ||
              (isCustom ? providerConfig?.customDefaultBaseUrl : ttsProvider?.defaultBaseUrl) ||
              '';
            if (!effectiveBaseUrl) return null;
            let endpointPath = '';
            if (isCustom) {
              endpointPath = '/audio/speech';
            } else {
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
      {ttsProvider?.models?.length > 0 && (
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
