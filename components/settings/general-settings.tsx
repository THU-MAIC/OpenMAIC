'use client';

import { useState, useCallback, useRef } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Loader2, Trash2, AlertTriangle, Upload, CheckCircle2 } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { clearDatabase } from '@/lib/utils/database';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import type { ProviderId } from '@/lib/ai/providers';
import type { TTSProviderId, ASRProviderId } from '@/lib/audio/types';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import type { WebSearchProviderId } from '@/lib/web-search/types';

const log = createLogger('GeneralSettings');

// Mapping from .env.local variable prefixes to provider IDs
const LLM_ENV_MAP: Record<string, ProviderId> = {
  OPENAI: 'openai' as ProviderId,
  ANTHROPIC: 'anthropic' as ProviderId,
  GOOGLE: 'google' as ProviderId,
  DEEPSEEK: 'deepseek' as ProviderId,
  QWEN: 'qwen' as ProviderId,
  KIMI: 'kimi' as ProviderId,
  MINIMAX: 'minimax' as ProviderId,
  GLM: 'glm' as ProviderId,
  SILICONFLOW: 'siliconflow' as ProviderId,
  DOUBAO: 'doubao' as ProviderId,
  GROK: 'grok' as ProviderId,
};

const TTS_ENV_MAP: Record<string, TTSProviderId> = {
  TTS_OPENAI: 'openai-tts',
  TTS_AZURE: 'azure-tts',
  TTS_GLM: 'glm-tts',
  TTS_QWEN: 'qwen-tts',
  TTS_ELEVENLABS: 'elevenlabs-tts',
};

const ASR_ENV_MAP: Record<string, ASRProviderId> = {
  ASR_OPENAI: 'openai-whisper',
  ASR_QWEN: 'qwen-asr',
};

const PDF_ENV_MAP: Record<string, PDFProviderId> = {
  PDF_UNPDF: 'unpdf' as PDFProviderId,
  PDF_MINERU: 'mineru' as PDFProviderId,
};

const IMAGE_ENV_MAP: Record<string, ImageProviderId> = {
  IMAGE_SEEDREAM: 'seedream' as ImageProviderId,
  IMAGE_QWEN_IMAGE: 'qwen-image' as ImageProviderId,
  IMAGE_NANO_BANANA: 'nano-banana' as ImageProviderId,
  IMAGE_GROK: 'grok-image' as ImageProviderId,
};

const VIDEO_ENV_MAP: Record<string, VideoProviderId> = {
  VIDEO_SEEDANCE: 'seedance' as VideoProviderId,
  VIDEO_KLING: 'kling' as VideoProviderId,
  VIDEO_VEO: 'veo' as VideoProviderId,
  VIDEO_SORA: 'sora' as VideoProviderId,
  VIDEO_GROK: 'grok-video' as VideoProviderId,
};

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

export function GeneralSettings() {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [showImportResult, setShowImportResult] = useState(false);

  // Settings store actions
  const setProviderConfig = useSettingsStore((state) => state.setProviderConfig);
  const setTTSProviderConfig = useSettingsStore((state) => state.setTTSProviderConfig);
  const setASRProviderConfig = useSettingsStore((state) => state.setASRProviderConfig);
  const setPDFProviderConfig = useSettingsStore((state) => state.setPDFProviderConfig);
  const setImageProviderConfig = useSettingsStore((state) => state.setImageProviderConfig);
  const setVideoProviderConfig = useSettingsStore((state) => state.setVideoProviderConfig);
  const setWebSearchProviderConfig = useSettingsStore((state) => state.setWebSearchProviderConfig);

  const handleImportEnv = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const content = ev.target?.result as string;
          const env = parseEnvFile(content);
          let count = 0;

          // LLM providers
          for (const [prefix, providerId] of Object.entries(LLM_ENV_MAP)) {
            const apiKey = env[`${prefix}_API_KEY`];
            const baseUrl = env[`${prefix}_BASE_URL`];
            if (apiKey || baseUrl) {
              const config: Record<string, string> = {};
              if (apiKey) config.apiKey = apiKey;
              if (baseUrl) config.baseUrl = baseUrl;
              setProviderConfig(providerId, config);
              count++;
            }
          }

          // TTS providers
          for (const [prefix, providerId] of Object.entries(TTS_ENV_MAP)) {
            const apiKey = env[`${prefix}_API_KEY`];
            const baseUrl = env[`${prefix}_BASE_URL`];
            if (apiKey || baseUrl) {
              const config: Record<string, string> = {};
              if (apiKey) config.apiKey = apiKey;
              if (baseUrl) config.baseUrl = baseUrl;
              setTTSProviderConfig(providerId, config);
              count++;
            }
          }

          // ASR providers
          for (const [prefix, providerId] of Object.entries(ASR_ENV_MAP)) {
            const apiKey = env[`${prefix}_API_KEY`];
            const baseUrl = env[`${prefix}_BASE_URL`];
            if (apiKey || baseUrl) {
              const config: Record<string, string> = {};
              if (apiKey) config.apiKey = apiKey;
              if (baseUrl) config.baseUrl = baseUrl;
              setASRProviderConfig(providerId, config);
              count++;
            }
          }

          // PDF providers
          for (const [prefix, providerId] of Object.entries(PDF_ENV_MAP)) {
            const apiKey = env[`${prefix}_API_KEY`];
            const baseUrl = env[`${prefix}_BASE_URL`];
            if (apiKey || baseUrl) {
              const config: Record<string, string> = {};
              if (apiKey) config.apiKey = apiKey;
              if (baseUrl) config.baseUrl = baseUrl;
              setPDFProviderConfig(providerId, config);
              count++;
            }
          }

          // Image providers
          for (const [prefix, providerId] of Object.entries(IMAGE_ENV_MAP)) {
            const apiKey = env[`${prefix}_API_KEY`];
            const baseUrl = env[`${prefix}_BASE_URL`];
            if (apiKey || baseUrl) {
              const config: Record<string, string> = {};
              if (apiKey) config.apiKey = apiKey;
              if (baseUrl) config.baseUrl = baseUrl;
              setImageProviderConfig(providerId, config);
              count++;
            }
          }

          // Video providers
          for (const [prefix, providerId] of Object.entries(VIDEO_ENV_MAP)) {
            const apiKey = env[`${prefix}_API_KEY`];
            const baseUrl = env[`${prefix}_BASE_URL`];
            if (apiKey || baseUrl) {
              const config: Record<string, string> = {};
              if (apiKey) config.apiKey = apiKey;
              if (baseUrl) config.baseUrl = baseUrl;
              setVideoProviderConfig(providerId, config);
              count++;
            }
          }

          // Web search (Tavily)
          const tavilyKey = env['TAVILY_API_KEY'];
          if (tavilyKey) {
            setWebSearchProviderConfig('tavily' as WebSearchProviderId, { apiKey: tavilyKey });
            count++;
          }

          setImportedCount(count);
          setShowImportResult(true);
          setTimeout(() => setShowImportResult(false), 3000);

          if (count > 0) {
            toast.success(t('settings.importEnvSuccess').replace('{count}', String(count)));
          } else {
            toast.warning(t('settings.importEnvEmpty'));
          }
        } catch (error) {
          log.error('Failed to import .env.local:', error);
          toast.error(t('settings.importEnvFailed'));
        }
      };
      reader.readAsText(file);
      // Reset input so the same file can be re-imported
      e.target.value = '';
    },
    [
      setProviderConfig,
      setTTSProviderConfig,
      setASRProviderConfig,
      setPDFProviderConfig,
      setImageProviderConfig,
      setVideoProviderConfig,
      setWebSearchProviderConfig,
      t,
    ],
  );

  // Clear cache state
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [clearing, setClearing] = useState(false);

  const confirmPhrase = t('settings.clearCacheConfirmPhrase');
  const isConfirmValid = confirmInput === confirmPhrase;

  const handleClearCache = useCallback(async () => {
    if (!isConfirmValid) return;
    setClearing(true);
    try {
      // 1. Clear IndexedDB
      await clearDatabase();
      // 2. Clear localStorage
      localStorage.clear();
      // 3. Clear sessionStorage
      sessionStorage.clear();

      toast.success(t('settings.clearCacheSuccess'));

      // Reload page after a short delay
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (error) {
      log.error('Failed to clear cache:', error);
      toast.error(t('settings.clearCacheFailed'));
      setClearing(false);
    }
  }, [isConfirmValid, t]);

  const clearCacheItems =
    t('settings.clearCacheConfirmItems').split('、').length > 1
      ? t('settings.clearCacheConfirmItems').split('、')
      : t('settings.clearCacheConfirmItems').split(', ');

  return (
    <div className="flex flex-col gap-8">
      {/* Import .env.local */}
      <div className="rounded-xl border bg-card p-4 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-primary/10 text-primary">
            <Upload className="w-4 h-4" />
          </div>
          <h3 className="text-sm font-semibold">{t('settings.importEnvTitle')}</h3>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{t('settings.importEnv')}</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              {t('settings.importEnvDescription')}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {showImportResult && (
              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {importedCount} {t('settings.importEnvProviders')}
              </span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".local,.env,.txt"
              className="hidden"
              onChange={handleImportEnv}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="w-3.5 h-3.5 mr-1.5" />
              {t('settings.importEnvButton')}
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone - Clear Cache */}
      <div className="relative rounded-xl border border-destructive/30 bg-destructive/[0.03] dark:bg-destructive/[0.06] overflow-hidden">
        {/* Subtle diagonal stripe pattern for danger emphasis */}
        <div
          className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03] pointer-events-none"
          style={{
            backgroundImage: `repeating-linear-gradient(
              -45deg,
              transparent,
              transparent 10px,
              currentColor 10px,
              currentColor 11px
            )`,
          }}
        />

        <div className="relative p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-md bg-destructive/10 text-destructive">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold text-destructive">{t('settings.dangerZone')}</h3>
          </div>

          {/* Content */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{t('settings.clearCache')}</p>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {t('settings.clearCacheDescription')}
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0"
              onClick={() => {
                setConfirmInput('');
                setShowClearDialog(true);
              }}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('settings.clearCache')}
            </Button>
          </div>
        </div>
      </div>

      {/* Clear Cache Confirmation Dialog */}
      <AlertDialog
        open={showClearDialog}
        onOpenChange={(open) => {
          if (!clearing) {
            setShowClearDialog(open);
            if (!open) setConfirmInput('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {t('settings.clearCacheConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('settings.clearCacheConfirmDescription')}</p>
                <ul className="space-y-1.5 ml-1">
                  {clearCacheItems.map((item, i) => (
                    <li key={i} className="flex items-center gap-2 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-destructive/60 shrink-0" />
                      {item.trim()}
                    </li>
                  ))}
                </ul>
                <div className="pt-1">
                  <Label className="text-xs font-medium text-foreground">
                    {t('settings.clearCacheConfirmInput')}
                  </Label>
                  <Input
                    className="mt-1.5 h-9 text-sm"
                    placeholder={confirmPhrase}
                    value={confirmInput}
                    onChange={(e) => setConfirmInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && isConfirmValid) {
                        handleClearCache();
                      }
                    }}
                    autoFocus
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!isConfirmValid || clearing}
              onClick={handleClearCache}
            >
              {clearing ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-1.5" />
              )}
              {t('settings.clearCacheButton')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
