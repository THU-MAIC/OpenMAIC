'use client';

import { useState, useEffect, useMemo } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import {
  TTS_PROVIDERS,
  isQwenCloneVoice,
  getManuallySelectableTTSModels,
} from '@/lib/audio/constants';
import type { BuiltInTTSProviderId } from '@/lib/audio/types';
import { Volume2, Loader2, CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { useTTSPreview } from '@/lib/audio/use-tts-preview';
import { getVoxCPMProviderOptions } from '@/lib/audio/voxcpm-voices';
import { VOXCPM_TTS_PROVIDER_ID } from '@/lib/audio/voxcpm';
import { defaultVoiceFor, slotVoxCPMBackend, ttsSelection } from '@/lib/audio/tts-selection';
import { modelCapabilities } from '@/lib/model-settings/capabilities';
import { assignService } from '@/lib/model-settings/services';
import { regionalEndpointTemplate } from '@/lib/config/official-endpoints';
import { QwenVoiceCloneManager, VoxCPMVoiceManager } from './tts-voice-managers';
import { TTSSpeedField } from './tts-speed-field';
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

const log = createLogger('TTSSettings');

/**
 * Doubao's key is an app id and an access key, stored as one key
 * (`appId:accessKey`): two fields, saved together once both are filled.
 */
function DoubaoKeyFields({ onSave }: { onSave: (key: string) => Promise<unknown> }) {
  const { t } = useI18n();
  const [appId, setAppId] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [show, setShow] = useState(false);
  const commit = async () => {
    if (!appId.trim() || !accessKey.trim()) return;
    // Cleared only once the server took the key.
    if (!(await onSave(`${appId.trim()}:${accessKey.trim()}`))) return;
    setAppId('');
    setAccessKey('');
  };
  const field = (label: string, value: string, set: (value: string) => void, name: string) => (
    <div className="space-y-2">
      <Label className="text-sm">{label}</Label>
      <div className="relative">
        <Input
          name={name}
          aria-label={name}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t('settings.enterApiKey')}
          value={value}
          onChange={(e) => set(e.target.value)}
          onBlur={() => void commit()}
          className="font-mono text-sm pr-10"
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
  return (
    <>
      {field(t('settings.doubaoAppId'), appId, setAppId, 'tts-app-id-doubao-tts')}
      {field(t('settings.doubaoAccessKey'), accessKey, setAccessKey, 'tts-access-key-doubao-tts')}
    </>
  );
}

/**
 * A text-to-speech service: its key (write-only), the user's narration speed,
 * a spoken test on the server with the saved configuration, its models, and
 * the voices a user makes for voice-design providers.
 */
/** Path each built-in TTS service calls under its base URL, for the request URL hint. */
export function ttsEndpointPath(providerId: string): string {
  switch (providerId) {
    case 'openai-tts':
    case 'glm-tts':
    case 'lemonade-tts':
      return '/audio/speech';
    case 'azure-tts':
      return '/cognitiveservices/v1';
    case 'qwen-tts':
      return '/services/aigc/multimodal-generation/generation';
    case 'elevenlabs-tts':
      return '/text-to-speech';
    case 'doubao-tts':
      return '/unidirectional';
    case 'google-tts':
      return '/interactions';
    default:
      return '';
  }
}

export function TTSSettings({ view, apply, entry }: ServicePanelProps) {
  const { t, locale } = useI18n();

  const ttsSpeed = useSettingsStore((state) => state.ttsSpeed);
  const setTTSSpeed = useSettingsStore((state) => state.setTTSSpeed);
  const ttsVoice = useSettingsStore((state) => state.ttsVoice);
  const ttsVoiceProviderId = useSettingsStore((state) => state.ttsVoiceProviderId);

  const providerId = entry.registryId;
  const ttsProvider = TTS_PROVIDERS[providerId as BuiltInTTSProviderId];
  const isBrowser = providerId === 'browser-native-tts';
  const isVoxCPM = providerId === VOXCPM_TTS_PROVIDER_ID;
  const isDoubao = providerId === 'doubao-tts';
  const editable =
    (entry.state === 'workspace' || entry.state === 'available') &&
    !isBrowser &&
    !!ttsProvider?.requiresApiKey;
  const use = rootUse(view, 'tts', entry.id);
  const manuallySelectableModels = getManuallySelectableTTSModels(
    providerId as BuiltInTTSProviderId,
  );

  // The voice the test speaks with: the user's while this service is the
  // workspace's narration, else the service's own default.
  const capabilities = useMemo(() => modelCapabilities(view), [view]);
  const selection = useMemo(
    () =>
      ttsSelection(capabilities, {
        voice: ttsVoice,
        providerId: ttsVoiceProviderId,
        speed: ttsSpeed,
      }),
    [capabilities, ttsVoice, ttsVoiceProviderId, ttsSpeed],
  );
  const effectiveVoice =
    use.inUse && selection ? selection.voice : defaultVoiceFor(providerId, use.modelId);
  const cloneSpeedDisabled = providerId === 'qwen-tts' && isQwenCloneVoice(effectiveVoice);
  const configured = entry.state === 'deployment' || entry.state === 'workspace' || isBrowser;
  // A service that needs no key (the browser's own speech) can be made the
  // workspace's narration here: it is added first when it is not saved yet.
  const keyless = !ttsProvider?.requiresApiKey && entry.state !== 'server-only';
  const [assigning, setAssigning] = useState(false);
  const makeNarration = async () => {
    setAssigning(true);
    try {
      reportApply(await assignService(apply, view, entry, 'tts'), t);
    } finally {
      setAssigning(false);
    }
  };

  const [testText, setTestText] = useState(t('settings.ttsTestTextDefault'));
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const { previewing: testingTTS, startPreview, stopPreview } = useTTSPreview();

  // Keep the sample text in sync with locale changes.
  useEffect(() => {
    setTestText(t('settings.ttsTestTextDefault'));
  }, [t]);

  // Stop a preview when the panel goes away.
  useEffect(() => stopPreview, [stopPreview]);

  const save = (apiKey: string) => saveServiceProvider(view, apply, entry, { apiKey }, t);
  // Azure Speech takes its official endpoint for the region the key belongs to.
  const regionalEndpoint = regionalEndpointTemplate('tts', providerId);

  const handleTestTTS = async () => {
    if (!testText.trim()) return;
    setTestStatus('testing');
    setTestMessage('');
    try {
      const providerOptions = isVoxCPM
        ? await getVoxCPMProviderOptions(effectiveVoice, {
            role: 'teacher',
            locale,
            backend: slotVoxCPMBackend(capabilities.tts),
          })
        : undefined;
      await startPreview({
        text: testText,
        providerId,
        voice: effectiveVoice,
        speed: ttsSpeed,
        providerOptions,
        // The service as the server saved it, not necessarily the one in use.
        ...(isBrowser
          ? {}
          : { previewProvider: entry.id, ...(use.modelId ? { previewModel: use.modelId } : {}) }),
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
    <div className={cn('space-y-6', isVoxCPM ? 'max-w-5xl' : 'max-w-3xl')}>
      {/* Browser-native TTS can't produce managed audio files, so the Pro-mode
          timeline's per-line audio (preview / regenerate / bulk voiceover) is
          unavailable on it — surface that when this provider is selected. */}
      {isBrowser && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          {t('settings.ttsBrowserNativeTimelineNotice')}
        </div>
      )}

      {entry.state === 'deployment' && <ServerConfiguredNotice />}
      {entry.state === 'server-only' && (
        <ServerOnlyNotice policy={!view.policy.allowWorkspaceProviders} />
      )}

      {/* API Key & Base URL — the server's services are the operator's. */}
      {editable && (
        <>
          {!isVoxCPM && <ApiKeySecurityNotice />}
          <div className={cn('grid gap-4', isDoubao ? 'grid-cols-3' : 'grid-cols-2')}>
            {isDoubao ? (
              <DoubaoKeyFields onSave={save} />
            ) : (
              <div className="space-y-2">
                <Label className="text-sm">{t('settings.ttsApiKey')}</Label>
                <ApiKeyField
                  name={`tts-api-key-${entry.id}`}
                  provider={entry.provider}
                  inputClassName="font-mono text-sm"
                  onSave={save}
                  onRemove={() => save('')}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.ttsBaseUrl')}</Label>
              {regionalEndpoint ? (
                <RegionalEndpointField
                  name={`tts-endpoint-${entry.id}`}
                  provider={entry.provider}
                  template={regionalEndpoint}
                  onSave={(baseUrl) => saveServiceProvider(view, apply, entry, { baseUrl }, t)}
                />
              ) : (
                <>
                  {ttsProvider?.defaultBaseUrl && (
                    <p className="text-xs text-muted-foreground break-all">
                      {t('settings.requestUrl')}: {ttsProvider.defaultBaseUrl}
                      {ttsEndpointPath(providerId)}
                    </p>
                  )}
                  <EndpointServerOnlyHint />
                </>
              )}
            </div>
          </div>
          {isDoubao && entry.provider?.key?.set && (
            <p className="text-xs text-muted-foreground">
              {t('settings.serverConfig.keyStored', { mask: entry.provider.key.mask ?? '' })}
            </p>
          )}
        </>
      )}

      {entry.state !== 'server-only' && (
        <>
          <TTSSpeedField
            provider={ttsProvider}
            speed={ttsSpeed}
            cloneVoiceLocked={cloneSpeedDisabled}
            onSpeedChange={setTTSSpeed}
          />

          {keyless && !use.inUse && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm">
              <span className="min-w-0 text-muted-foreground">
                {t('settings.serverConfig.notNarration')}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={assigning || !use.slot || use.slot.locked}
                onClick={() => void makeNarration()}
              >
                {t('settings.serverConfig.useForNarration')}
              </Button>
            </div>
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
                onClick={() => void handleTestTTS()}
                disabled={testingTTS || !testText.trim() || !configured}
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
        </>
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

      {/* Available Models */}
      {manuallySelectableModels.length > 0 && !isVoxCPM && (
        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">{t('settings.availableModels')}</Label>
          <div className="flex flex-wrap gap-2">
            {manuallySelectableModels.map((model) => (
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

      {/* The voices a user makes: for the workspace's narration service. */}
      {isVoxCPM && use.inUse && <VoxCPMVoiceManager />}
      {providerId === 'qwen-tts' && use.inUse && <QwenVoiceCloneManager />}
    </div>
  );
}
