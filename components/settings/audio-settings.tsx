'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import {
  TTS_PROVIDERS,
  getTTSVoices,
  ASR_PROVIDERS,
  getASRSupportedLanguages,
} from '@/lib/audio/constants';
import type { TTSProviderId, ASRProviderId } from '@/lib/audio/types';
import { Volume2, Mic, MicOff, Loader2, CheckCircle2, XCircle, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import azureVoicesData from '@/lib/audio/azure.json';
import { createLogger } from '@/lib/logger';
import {
  ensureVoicesLoaded,
  isBrowserTTSAbortError,
  playBrowserTTSPreview,
} from '@/lib/audio/browser-tts-preview';

const log = createLogger('AudioSettings');

/**
 * Get provider display name with i18n
 */
function getTTSProviderName(providerId: TTSProviderId, t: (key: string) => string): string {
  const names: Record<TTSProviderId, string> = {
    'openai-tts': t('settings.providerOpenAITTS'),
    'azure-tts': t('settings.providerAzureTTS'),
    'glm-tts': t('settings.providerGLMTTS'),
    'qwen-tts': t('settings.providerQwenTTS'),
    'browser-native-tts': t('settings.providerBrowserNativeTTS'),
  };
  return names[providerId];
}

function getASRProviderName(providerId: ASRProviderId, t: (key: string) => string): string {
  const names: Record<ASRProviderId, string> = {
    'openai-whisper': t('settings.providerOpenAIWhisper'),
    'browser-native': t('settings.providerBrowserNative'),
    'qwen-asr': t('settings.providerQwenASR'),
  };
  return names[providerId];
}

function getLanguageName(code: string, t: (key: string) => string): string {
  const key = `settings.lang_${code}`;
  const translated = t(key);
  // If translation key not found, return the code itself
  return translated === key ? code : translated;
}

interface AudioSettingsProps {
  onSave?: () => void;
}

export function AudioSettings({ onSave }: AudioSettingsProps = {}) {
  const { t } = useI18n();

  // TTS state
  const ttsProviderId = useSettingsStore((state) => state.ttsProviderId);
  const ttsVoice = useSettingsStore((state) => state.ttsVoice);
  const ttsSpeed = useSettingsStore((state) => state.ttsSpeed);
  const ttsProvidersConfig = useSettingsStore((state) => state.ttsProvidersConfig);
  const setTTSProvider = useSettingsStore((state) => state.setTTSProvider);
  const setTTSVoice = useSettingsStore((state) => state.setTTSVoice);
  const setTTSSpeed = useSettingsStore((state) => state.setTTSSpeed);
  const setTTSProviderConfig = useSettingsStore((state) => state.setTTSProviderConfig);

  // ASR state
  const asrProviderId = useSettingsStore((state) => state.asrProviderId);
  const asrLanguage = useSettingsStore((state) => state.asrLanguage);
  const asrProvidersConfig = useSettingsStore((state) => state.asrProvidersConfig);
  const setASRProvider = useSettingsStore((state) => state.setASRProvider);
  const setASRLanguage = useSettingsStore((state) => state.setASRLanguage);
  const setASRProviderConfig = useSettingsStore((state) => state.setASRProviderConfig);

  const ttsEnabled = useSettingsStore((state) => state.ttsEnabled);
  const asrEnabled = useSettingsStore((state) => state.asrEnabled);
  const setTTSEnabled = useSettingsStore((state) => state.setTTSEnabled);
  const setASREnabled = useSettingsStore((state) => state.setASREnabled);

  const ttsProvider = TTS_PROVIDERS[ttsProviderId] ?? TTS_PROVIDERS['openai-tts'];

  // Azure voices - load from static JSON
  const azureVoices = useMemo(() => azureVoicesData.voices, []);

  // Wrapped setters that trigger onSave callback
  const handleTTSProviderChange = (providerId: TTSProviderId) => {
    setTTSProvider(providerId);
    onSave?.();
  };

  const handleTTSVoiceChange = (voice: string) => {
    setTTSVoice(voice);
    onSave?.();
  };

  const handleTTSSpeedChange = (speed: number) => {
    setTTSSpeed(speed);
    onSave?.();
  };

  const handleTTSProviderConfigChange = (
    providerId: TTSProviderId,
    config: Partial<{ apiKey: string; baseUrl: string; enabled: boolean }>,
  ) => {
    setTTSProviderConfig(providerId, config);
    onSave?.();
  };

  const handleASRProviderChange = (providerId: ASRProviderId) => {
    setASRProvider(providerId);
    onSave?.();
  };

  const handleASRLanguageChange = (language: string) => {
    setASRLanguage(language);
    onSave?.();
  };

  const handleASRProviderConfigChange = (
    providerId: ASRProviderId,
    config: Partial<{ apiKey: string; baseUrl: string; enabled: boolean }>,
  ) => {
    setASRProviderConfig(providerId, config);
    onSave?.();
  };

  // Password visibility state
  const [showTTSApiKey, setShowTTSApiKey] = useState(false);
  const [showASRApiKey, setShowASRApiKey] = useState(false);

  // Language filter state
  const [selectedLocale, setSelectedLocale] = useState<string>('all');

  // Test state
  const [testingTTS, setTestingTTS] = useState(false);
  const [testText, setTestText] = useState(t('settings.ttsTestTextDefault'));
  const [ttsTestStatus, setTTSTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>(
    'idle',
  );
  const [ttsTestMessage, setTTSTestMessage] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [asrResult, setASRResult] = useState('');
  const [asrTestStatus, setASRTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>(
    'idle',
  );
  const [asrTestMessage, setASRTestMessage] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrlRef = useRef<string | null>(null);
  const browserPreviewCancelRef = useRef<(() => void) | null>(null);
  const ttsTestRequestIdRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const asrProvider = ASR_PROVIDERS[asrProviderId] ?? ASR_PROVIDERS['openai-whisper'];

  // Update test text when language changes (derived state pattern)
  const [prevT, setPrevT] = useState(() => t);
  if (t !== prevT) {
    setPrevT(t);
    setTestText(t('settings.ttsTestTextDefault'));
  }

  // Reset locale filter when provider changes (derived state pattern)
  const [prevTTSProviderId, setPrevTTSProviderId] = useState(ttsProviderId);
  if (ttsProviderId !== prevTTSProviderId) {
    setPrevTTSProviderId(ttsProviderId);
    if (ttsProviderId !== 'azure-tts') {
      setSelectedLocale('all');
    }
  }

  const stopTTSPreview = useCallback((resetState = true) => {
    ttsTestRequestIdRef.current += 1;
    browserPreviewCancelRef.current?.();
    browserPreviewCancelRef.current = null;
    audioRef.current?.pause();
    if (audioRef.current) {
      audioRef.current.src = '';
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    if (resetState) {
      setTestingTTS(false);
    }
  }, []);

  // Update voice selection when locale filter changes
  useEffect(() => {
    if (ttsProviderId === 'azure-tts' && selectedLocale !== 'all') {
      // Filter Azure voices by selected locale
      const filteredVoices = azureVoices.filter((voice) => voice.Locale === selectedLocale);

      // Check if current voice is in the filtered list
      const currentVoiceInFilter = filteredVoices.some((voice) => voice.ShortName === ttsVoice);

      // If current voice is not in filtered list, select the first voice in the filtered list
      if (!currentVoiceInFilter && filteredVoices.length > 0) {
        setTTSVoice(filteredVoices[0].ShortName);
      }
    }
    // Intentionally exclude ttsVoice from dependencies to avoid infinite loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocale, ttsProviderId, azureVoices, setTTSVoice]);

  useEffect(() => {
    stopTTSPreview(false);
    setTTSTestStatus('idle');
    setTTSTestMessage('');
  }, [ttsProviderId, stopTTSPreview]);

  // Initialize and reset TTS voice when provider changes
  useEffect(() => {
    let availableVoices: Array<{ id: string; name: string }> = [];

    if (ttsProviderId === 'azure-tts') {
      // Use Azure voices from JSON
      availableVoices = azureVoices.map((voice) => ({
        id: voice.ShortName,
        name: voice.LocalName,
      }));
    } else {
      // Use static voices from constants
      availableVoices = getTTSVoices(ttsProviderId);
    }

    if (availableVoices.length > 0) {
      // Initialize default voice if not set
      if (!ttsVoice) {
        setTTSVoice(availableVoices[0].id);
      } else {
        // Check if current voice is available in new provider
        const currentVoiceExists = availableVoices.some((v) => v.id === ttsVoice);
        if (!currentVoiceExists) {
          setTTSVoice(availableVoices[0].id);
        }
      }
    }
  }, [ttsProviderId, ttsVoice, azureVoices, setTTSVoice]);

  // Initialize and reset ASR language when provider changes
  useEffect(() => {
    const availableLanguages = getASRSupportedLanguages(asrProviderId);
    if (availableLanguages.length > 0) {
      // Initialize default language if not set
      if (!asrLanguage) {
        setASRLanguage(availableLanguages[0]);
      } else {
        // Check if current language is available in new provider
        const currentLanguageExists = availableLanguages.includes(asrLanguage);
        if (!currentLanguageExists) {
          setASRLanguage(availableLanguages[0]);
        }
      }
    }
  }, [asrProviderId, asrLanguage, setASRLanguage]);

  useEffect(() => {
    return () => {
      stopTTSPreview(false);
    };
  }, [stopTTSPreview]);

  // Clear ASR test status when provider changes (derived state pattern)
  const [prevASRProviderId, setPrevASRProviderId] = useState(asrProviderId);
  if (asrProviderId !== prevASRProviderId) {
    setPrevASRProviderId(asrProviderId);
    setASRTestStatus('idle');
    setASRTestMessage('');
    setASRResult('');
  }

  // Test TTS
  const handleTestTTS = async () => {
    if (!testText.trim()) {
      return;
    }

    const requestId = ttsTestRequestIdRef.current + 1;
    ttsTestRequestIdRef.current = requestId;

    setTestingTTS(true);
    setTTSTestStatus('testing');
    setTTSTestMessage('');

    try {
      if (ttsProviderId === 'browser-native-tts') {
        if (!('speechSynthesis' in window)) {
          setTTSTestStatus('error');
          setTTSTestMessage(t('settings.browserTTSNotSupported'));
          return;
        }

        const voices = await ensureVoicesLoaded();
        if (ttsTestRequestIdRef.current !== requestId) {
          return;
        }
        if (voices.length === 0) {
          setTTSTestStatus('error');
          setTTSTestMessage(t('settings.browserTTSNoVoices'));
          return;
        }

        const controller = playBrowserTTSPreview({
          text: testText,
          voice: ttsVoice,
          rate: ttsSpeed,
          voices,
        });
        browserPreviewCancelRef.current = controller.cancel;
        await controller.promise;

        if (ttsTestRequestIdRef.current !== requestId) {
          return;
        }
        setTTSTestStatus('success');
        setTTSTestMessage(t('settings.ttsTestSuccess'));
        return;
      }

      const requestBody: Record<string, unknown> = {
        text: testText,
        audioId: 'tts-test',
        ttsProviderId,
        ttsVoice: ttsVoice,
        ttsSpeed: ttsSpeed,
      };

      const apiKeyValue = ttsProvidersConfig[ttsProviderId]?.apiKey;
      if (apiKeyValue && apiKeyValue.trim()) {
        requestBody.ttsApiKey = apiKeyValue;
      }

      const baseUrlValue = ttsProvidersConfig[ttsProviderId]?.baseUrl;
      if (baseUrlValue && baseUrlValue.trim()) {
        requestBody.ttsBaseUrl = baseUrlValue;
      }

      const response = await fetch('/api/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const data = await response
        .json()
        .catch(() => ({ success: false, error: response.statusText }));
      if (ttsTestRequestIdRef.current !== requestId) {
        return;
      }
      if (response.ok && data.success) {
        const binaryStr = atob(data.base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const audioBlob = new Blob([bytes], { type: `audio/${data.format}` });
        if (audioUrlRef.current) {
          URL.revokeObjectURL(audioUrlRef.current);
        }
        const audioUrl = URL.createObjectURL(audioBlob);
        audioUrlRef.current = audioUrl;
        if (audioRef.current) {
          audioRef.current.src = audioUrl;
          await audioRef.current.play();
        }
        setTTSTestStatus('success');
        setTTSTestMessage(t('settings.ttsTestSuccess'));
      } else {
        setTTSTestStatus('error');
        setTTSTestMessage(data.error || t('settings.ttsTestFailed'));
      }
    } catch (error) {
      if (ttsTestRequestIdRef.current !== requestId || isBrowserTTSAbortError(error)) {
        return;
      }
      log.error('TTS test failed:', error);
      setTTSTestStatus('error');
      setTTSTestMessage(
        error instanceof Error && error.message
          ? `${t('settings.ttsTestFailed')}: ${error.message}`
          : t('settings.ttsTestFailed'),
      );
    } finally {
      if (ttsTestRequestIdRef.current === requestId) {
        browserPreviewCancelRef.current = null;
        setTestingTTS(false);
      }
    }
  };

  // Test ASR
  const handleToggleASRRecording = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
    } else {
      setASRResult('');
      setASRTestStatus('testing');
      setASRTestMessage('');

      if (asrProviderId === 'browser-native') {
        const SpeechRecognitionCtor =
          (window as unknown as Record<string, unknown>).SpeechRecognition ||
          (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
        if (!SpeechRecognitionCtor) {
          setASRTestStatus('error');
          setASRTestMessage(t('settings.asrNotSupported'));
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
          setASRTestStatus('success');
          setASRTestMessage(t('settings.asrTestSuccess'));
        };
        recognition.onerror = (event: { error: string }) => {
          log.error('Speech recognition error:', event.error);
          setASRTestStatus('error');
          setASRTestMessage(t('settings.asrTestFailed') + ': ' + event.error);
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
            formData.append('providerId', asrProviderId);
            formData.append('language', asrLanguage);

            // Only append non-empty values
            const apiKeyValue = asrProvidersConfig[asrProviderId]?.apiKey;
            if (apiKeyValue && apiKeyValue.trim()) {
              formData.append('apiKey', apiKeyValue);
            }
            const baseUrlValue = asrProvidersConfig[asrProviderId]?.baseUrl;
            if (baseUrlValue && baseUrlValue.trim()) {
              formData.append('baseUrl', baseUrlValue);
            }

            try {
              const response = await fetch('/api/transcription', {
                method: 'POST',
                body: formData,
              });

              if (response.ok) {
                const data = await response.json();
                setASRResult(data.text);
                setASRTestStatus('success');
                setASRTestMessage(t('settings.asrTestSuccess'));
              } else {
                setASRTestStatus('error');
                const errorData = await response
                  .json()
                  .catch(() => ({ error: response.statusText }));
                // Show details if available, otherwise show error message
                setASRTestMessage(
                  errorData.details || errorData.error || t('settings.asrTestFailed'),
                );
              }
            } catch (error) {
              log.error('ASR test failed:', error);
              setASRTestStatus('error');
              setASRTestMessage(t('settings.asrTestFailed'));
            }
          };

          mediaRecorder.start();
          setIsRecording(true);
        } catch (error) {
          log.error('Failed to access microphone:', error);
          setASRTestStatus('error');
          setASRTestMessage(t('settings.microphoneAccessFailed'));
        }
      }
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {/* TTS Section */}
      <div className="space-y-4">
        <div
          className={cn(
            'relative flex items-center gap-3 rounded-lg border px-4 py-3 transition-all duration-300',
            ttsEnabled ? 'bg-background border-border' : 'bg-muted/30 border-transparent',
          )}
        >
          <div
            className={cn(
              'absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full transition-colors duration-300',
              ttsEnabled ? 'bg-primary' : 'bg-muted-foreground/20',
            )}
          />
          <div
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-300',
              ttsEnabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            <Volume2 className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h3
              className={cn(
                'text-sm font-medium transition-colors duration-300',
                !ttsEnabled && 'text-muted-foreground',
              )}
            >
              {t('settings.ttsSection')}
            </h3>
            <p className="text-xs text-muted-foreground">{t('settings.ttsEnabledDescription')}</p>
          </div>
          <Switch
            checked={ttsEnabled}
            onCheckedChange={(checked) => {
              setTTSEnabled(checked);
              onSave?.();
            }}
          />
        </div>

        <div
          className={cn(
            'space-y-4 transition-all duration-300 overflow-hidden',
            ttsEnabled ? 'opacity-100' : 'opacity-40 max-h-0 pointer-events-none',
          )}
        >
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.ttsProvider')}</Label>
            <Select
              value={ttsProviderId}
              onValueChange={(value) => handleTTSProviderChange(value as TTSProviderId)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(TTS_PROVIDERS).map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    <div className="flex items-center gap-2">
                      {provider.icon && (
                        <img src={provider.icon} alt={provider.name} className="w-4 h-4" />
                      )}
                      {getTTSProviderName(provider.id, t)}
                      {ttsProvidersConfig[provider.id]?.isServerConfigured && (
                        <span className="text-[10px] px-1 py-0.5 rounded border text-muted-foreground">
                          {t('settings.serverConfigured')}
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {(ttsProvider.requiresApiKey ||
            ttsProvidersConfig[ttsProviderId]?.isServerConfigured) && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm">{t('settings.ttsApiKey')}</Label>
                  <div className="relative">
                    <Input
                      type={showTTSApiKey ? 'text' : 'password'}
                      placeholder={
                        ttsProvidersConfig[ttsProviderId]?.isServerConfigured
                          ? t('settings.optionalOverride')
                          : t('settings.enterApiKey')
                      }
                      value={ttsProvidersConfig[ttsProviderId]?.apiKey || ''}
                      onChange={(e) =>
                        handleTTSProviderConfigChange(ttsProviderId, {
                          apiKey: e.target.value,
                        })
                      }
                      className="font-mono text-sm pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowTTSApiKey(!showTTSApiKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showTTSApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">{t('settings.ttsBaseUrl')}</Label>
                  <Input
                    placeholder={ttsProvider.defaultBaseUrl || t('settings.enterCustomBaseUrl')}
                    value={ttsProvidersConfig[ttsProviderId]?.baseUrl || ''}
                    onChange={(e) =>
                      handleTTSProviderConfigChange(ttsProviderId, {
                        baseUrl: e.target.value,
                      })
                    }
                    className="text-sm"
                  />
                </div>
              </div>
              {(() => {
                const effectiveBaseUrl =
                  ttsProvidersConfig[ttsProviderId]?.baseUrl || ttsProvider.defaultBaseUrl || '';
                if (!effectiveBaseUrl) return null;

                // Get endpoint path based on provider
                let endpointPath = '';
                switch (ttsProviderId) {
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
                  default:
                    endpointPath = '';
                }

                if (!endpointPath) return null;
                const fullUrl = effectiveBaseUrl + endpointPath;
                return (
                  <p className="text-xs text-muted-foreground break-all">
                    {t('settings.requestUrl')}: {fullUrl}
                  </p>
                );
              })()}
            </>
          )}

          {/* Voice Selection Row */}
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns:
                ttsProviderId === 'azure-tts' ? '280px 280px 200px' : '280px 200px',
            }}
          >
            {/* Language Filter for Azure TTS */}
            {ttsProviderId === 'azure-tts' && (
              <div className="space-y-2">
                <Label className="text-sm">{t('settings.ttsLanguageFilter')}</Label>
                <Select value={selectedLocale} onValueChange={setSelectedLocale}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('settings.allLanguages')}</SelectItem>
                    {(() => {
                      // Extract unique locales from Azure voices
                      const uniqueLocales = Array.from(
                        new Set(azureVoices.map((voice) => voice.Locale)),
                      );

                      // Sort: Chinese dialects first, then other major languages, then alphabetically
                      const sortedLocales = uniqueLocales.sort((a, b) => {
                        // Get LocaleName for both locales
                        const voiceA = azureVoices.find((v) => v.Locale === a);
                        const voiceB = azureVoices.find((v) => v.Locale === b);
                        const localeNameA = voiceA?.LocaleName || a;
                        const localeNameB = voiceB?.LocaleName || b;

                        // Check if LocaleName contains "Chinese" (case-insensitive)
                        const aIsChinese = /chinese/i.test(localeNameA);
                        const bIsChinese = /chinese/i.test(localeNameB);

                        // Both are Chinese - sort by priority
                        if (aIsChinese && bIsChinese) {
                          const chinesePriority = [
                            'zh-CN', // Chinese (Simplified, China)
                            'zh-CN-liaoning', // Chinese (Northeastern Mandarin, Liaoning)
                            'zh-CN-shaanxi', // Chinese (Shaanxi dialect)
                            'wuu-CN', // Chinese (Wu, China)
                            'zh-HK', // Chinese (Cantonese, Hong Kong)
                            'yue-CN', // Chinese (Cantonese, China)
                            'zh-CN-shandong', // Chinese (Jinan dialect, Shandong)
                            'zh-CN-sichuan', // Chinese (Sichuan dialect)
                            'zh-TW', // Chinese (Taiwanese Mandarin)
                          ];
                          const aIndex = chinesePriority.indexOf(a);
                          const bIndex = chinesePriority.indexOf(b);

                          if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
                          if (aIndex !== -1) return -1;
                          if (bIndex !== -1) return 1;
                          return localeNameA.localeCompare(localeNameB);
                        }

                        // Only a is Chinese
                        if (aIsChinese) return -1;
                        // Only b is Chinese
                        if (bIsChinese) return 1;

                        // Neither is Chinese - sort by priority for other major languages
                        const otherPriority = [
                          'en-US',
                          'en-GB',
                          'ja-JP',
                          'ko-KR',
                          'es-ES',
                          'fr-FR',
                          'de-DE',
                          'ru-RU',
                          'ar-SA',
                          'pt-BR',
                          'it-IT',
                        ];
                        const aIndex = otherPriority.indexOf(a);
                        const bIndex = otherPriority.indexOf(b);

                        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
                        if (aIndex !== -1) return -1;
                        if (bIndex !== -1) return 1;

                        // Sort alphabetically
                        return a.localeCompare(b);
                      });

                      return sortedLocales.map((locale) => {
                        // Find a voice with this locale to get the LocaleName
                        const voiceWithLocale = azureVoices.find((v) => v.Locale === locale);
                        const localeName = voiceWithLocale?.LocaleName || locale;
                        return (
                          <SelectItem key={locale} value={locale}>
                            {localeName}
                          </SelectItem>
                        );
                      });
                    })()}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-sm">{t('settings.ttsVoice')}</Label>
              <Select value={ttsVoice} onValueChange={handleTTSVoiceChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(() => {
                    // For Azure TTS, use JSON data
                    if (ttsProviderId === 'azure-tts') {
                      // Filter voices by selected locale
                      const filteredVoices =
                        selectedLocale === 'all'
                          ? azureVoices
                          : azureVoices.filter((voice) => voice.Locale === selectedLocale);

                      return filteredVoices.map((voice) => (
                        <SelectItem key={voice.ShortName} value={voice.ShortName}>
                          {voice.LocalName} ({voice.DisplayName})
                        </SelectItem>
                      ));
                    }

                    // For other providers, use static voices
                    const allVoices = getTTSVoices(ttsProviderId);
                    return allVoices.map((voice) => (
                      <SelectItem key={voice.id} value={voice.id}>
                        {voice.name}
                        {voice.description && ` - ${t(`settings.${voice.description}`)}`}
                      </SelectItem>
                    ));
                  })()}
                </SelectContent>
              </Select>
            </div>

            {ttsProvider.speedRange && (
              <div className="space-y-2">
                <Label className="text-sm">{t('settings.ttsSpeed')}</Label>
                <div className="flex items-center gap-3">
                  <Slider
                    value={[ttsSpeed]}
                    onValueChange={(value) => handleTTSSpeedChange(value[0])}
                    min={ttsProvider.speedRange.min}
                    max={ttsProvider.speedRange.max}
                    step={0.1}
                    className="flex-1"
                  />
                  <span className="text-xs text-muted-foreground min-w-[3rem] text-right">
                    {ttsSpeed.toFixed(1)}x
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Test TTS Section */}
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
                    !ttsProvidersConfig[ttsProviderId]?.apiKey?.trim() &&
                    !ttsProvidersConfig[ttsProviderId]?.isServerConfigured)
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

          {ttsTestMessage && (
            <div
              className={cn(
                'rounded-lg p-3 text-sm overflow-hidden',
                ttsTestStatus === 'success' &&
                  'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/50 dark:text-green-400 dark:border-green-800',
                ttsTestStatus === 'error' &&
                  'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800',
              )}
            >
              <div className="flex items-start gap-2 min-w-0">
                {ttsTestStatus === 'success' && (
                  <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                )}
                {ttsTestStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                <p className="flex-1 min-w-0 break-all">{ttsTestMessage}</p>
              </div>
            </div>
          )}

          <audio ref={audioRef} className="hidden" />
        </div>
      </div>

      {/* ASR Section */}
      <div className="space-y-4 pt-4 border-t">
        <div
          className={cn(
            'relative flex items-center gap-3 rounded-lg border px-4 py-3 transition-all duration-300',
            asrEnabled ? 'bg-background border-border' : 'bg-muted/30 border-transparent',
          )}
        >
          <div
            className={cn(
              'absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full transition-colors duration-300',
              asrEnabled ? 'bg-primary' : 'bg-muted-foreground/20',
            )}
          />
          <div
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-300',
              asrEnabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            <Mic className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h3
              className={cn(
                'text-sm font-medium transition-colors duration-300',
                !asrEnabled && 'text-muted-foreground',
              )}
            >
              {t('settings.asrSection')}
            </h3>
            <p className="text-xs text-muted-foreground">{t('settings.asrEnabledDescription')}</p>
          </div>
          <Switch
            checked={asrEnabled}
            onCheckedChange={(checked) => {
              setASREnabled(checked);
              onSave?.();
            }}
          />
        </div>

        <div
          className={cn(
            'space-y-4 transition-all duration-300 overflow-hidden',
            asrEnabled ? 'opacity-100' : 'opacity-40 max-h-0 pointer-events-none',
          )}
        >
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.asrProvider')}</Label>
            <Select
              value={asrProviderId}
              onValueChange={(value) => handleASRProviderChange(value as ASRProviderId)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(ASR_PROVIDERS).map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    <div className="flex items-center gap-2">
                      {provider.icon && (
                        <img src={provider.icon} alt={provider.name} className="w-4 h-4" />
                      )}
                      {getASRProviderName(provider.id, t)}
                      {asrProvidersConfig[provider.id]?.isServerConfigured && (
                        <span className="text-[10px] px-1 py-0.5 rounded border text-muted-foreground">
                          {t('settings.serverConfigured')}
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {(asrProvider.requiresApiKey ||
            asrProvidersConfig[asrProviderId]?.isServerConfigured) && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm">{t('settings.asrApiKey')}</Label>
                  <div className="relative">
                    <Input
                      type={showASRApiKey ? 'text' : 'password'}
                      placeholder={
                        asrProvidersConfig[asrProviderId]?.isServerConfigured
                          ? t('settings.optionalOverride')
                          : t('settings.enterApiKey')
                      }
                      value={asrProvidersConfig[asrProviderId]?.apiKey || ''}
                      onChange={(e) =>
                        handleASRProviderConfigChange(asrProviderId, {
                          apiKey: e.target.value,
                        })
                      }
                      className="font-mono text-sm pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowASRApiKey(!showASRApiKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showASRApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">{t('settings.asrBaseUrl')}</Label>
                  <Input
                    placeholder={asrProvider.defaultBaseUrl || t('settings.enterCustomBaseUrl')}
                    value={asrProvidersConfig[asrProviderId]?.baseUrl || ''}
                    onChange={(e) =>
                      handleASRProviderConfigChange(asrProviderId, {
                        baseUrl: e.target.value,
                      })
                    }
                    className="text-sm"
                  />
                </div>
              </div>
              {(() => {
                const effectiveBaseUrl =
                  asrProvidersConfig[asrProviderId]?.baseUrl || asrProvider.defaultBaseUrl || '';
                if (!effectiveBaseUrl) return null;

                // Get endpoint path based on provider
                let endpointPath = '';
                switch (asrProviderId) {
                  case 'openai-whisper':
                    endpointPath = '/audio/transcriptions';
                    break;
                  case 'qwen-asr':
                    endpointPath = '/services/aigc/multimodal-generation/generation';
                    break;
                  default:
                    endpointPath = '';
                }

                if (!endpointPath) return null;
                const fullUrl = effectiveBaseUrl + endpointPath;
                return (
                  <p className="text-xs text-muted-foreground break-all">
                    {t('settings.requestUrl')}: {fullUrl}
                  </p>
                );
              })()}
            </>
          )}

          {(() => {
            const supportedLanguages = getASRSupportedLanguages(asrProviderId);
            const hasLanguageSelection = supportedLanguages.length > 0;

            return (
              <div
                className="grid gap-4"
                style={{
                  gridTemplateColumns: hasLanguageSelection ? '160px 1fr' : '1fr',
                }}
              >
                {hasLanguageSelection && (
                  <div className="space-y-2">
                    <Label className="text-sm">{t('settings.asrLanguage')}</Label>
                    <Select value={asrLanguage} onValueChange={handleASRLanguageChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {supportedLanguages.map((lang) => (
                          <SelectItem key={lang} value={lang}>
                            {getLanguageName(lang, t)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

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
                        !asrProvidersConfig[asrProviderId]?.apiKey?.trim() &&
                        !asrProvidersConfig[asrProviderId]?.isServerConfigured
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
              </div>
            );
          })()}

          {asrTestMessage && (
            <div
              className={cn(
                'rounded-lg p-3 text-sm overflow-hidden',
                asrTestStatus === 'success' &&
                  'bg-green-50 text-green-700 border border-green-200 dark:bg-green-950/50 dark:text-green-400 dark:border-green-800',
                asrTestStatus === 'error' &&
                  'bg-red-50 text-red-700 border border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800',
              )}
            >
              <div className="flex items-start gap-2 min-w-0">
                {asrTestStatus === 'success' && (
                  <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                )}
                {asrTestStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                <p className="flex-1 min-w-0 break-all">{asrTestMessage}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
