'use client';

import { useState, useCallback, useMemo } from 'react';
import { Volume2, Play, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { getTTSVoices } from '@/lib/audio/constants';
import { useTTSPreview } from '@/lib/audio/use-tts-preview';
import {
  getVoxCPMProviderOptions,
  getVoxCPMVoiceOptions,
  useVoxCPMVoiceProfiles,
} from '@/lib/audio/voxcpm-voices';
import {
  VOXCPM_AUTO_VOICE_ID,
  normalizeVoxCPMBackend,
  voxCPMBackendSupportsReferenceAudio,
} from '@/lib/audio/voxcpm';

/** Extract the English name from voice name format "ChineseName (English)" */
function getVoiceDisplayName(
  id: string,
  name: string,
  lang: string,
  t: (key: string) => string,
): string {
  if (id === VOXCPM_AUTO_VOICE_ID) {
    return t('settings.voxcpmAutoVoice');
  }
  if (lang === 'en-US') {
    const match = name.match(/\(([^)]+)\)/);
    return match ? match[1] : name;
  }
  return name;
}

export function TtsConfigPopover() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const { previewing, startPreview, stopPreview } = useTTSPreview();

  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);
  const setTTSEnabled = useSettingsStore((s) => s.setTTSEnabled);
  const ttsProviderId = useSettingsStore((s) => s.ttsProviderId);
  const ttsVoice = useSettingsStore((s) => s.ttsVoice);
  const ttsSpeed = useSettingsStore((s) => s.ttsSpeed);
  const ttsProvidersConfig = useSettingsStore((s) => s.ttsProvidersConfig);
  const setTTSVoice = useSettingsStore((s) => s.setTTSVoice);
  const { profiles: voxcpmProfiles } = useVoxCPMVoiceProfiles();
  const voxcpmBackend = normalizeVoxCPMBackend(
    ttsProvidersConfig['voxcpm-tts']?.providerOptions?.backend,
  );

  const voices =
    ttsProviderId === 'voxcpm-tts'
      ? getVoxCPMVoiceOptions(voxcpmProfiles, {
          supportsClone: voxCPMBackendSupportsReferenceAudio(voxcpmBackend),
        })
      : getTTSVoices(ttsProviderId);
  const localizedVoices = useMemo(
    () =>
      voices.map((v) => ({
        ...v,
        displayName: getVoiceDisplayName(v.id, v.name, locale, t),
      })),
    [voices, locale, t],
  );

  const pillCls =
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-all cursor-pointer select-none whitespace-nowrap border';
  const canPreview = ttsProviderId !== 'voxcpm-tts' || ttsVoice !== VOXCPM_AUTO_VOICE_ID;

  const handlePreview = useCallback(async () => {
    if (previewing) {
      stopPreview();
      return;
    }
    if (!canPreview) {
      toast.info(t('settings.voxcpmAutoVoiceNoPreview'));
      return;
    }
    try {
      const providerConfig = ttsProvidersConfig[ttsProviderId];
      const providerOptions =
        ttsProviderId === 'voxcpm-tts'
          ? {
              ...(providerConfig?.providerOptions || {}),
              ...(await getVoxCPMProviderOptions(ttsVoice, { role: 'teacher', locale })),
            }
          : undefined;
      await startPreview({
        text: t('settings.ttsTestTextDefault'),
        providerId: ttsProviderId,
        modelId: providerConfig?.modelId,
        voice: ttsVoice,
        speed: ttsSpeed,
        apiKey: providerConfig?.apiKey,
        baseUrl:
          providerConfig?.serverBaseUrl ||
          providerConfig?.baseUrl ||
          providerConfig?.customDefaultBaseUrl,
        providerOptions,
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : t('settings.ttsTestFailed');
      toast.error(message);
    }
  }, [
    previewing,
    canPreview,
    startPreview,
    stopPreview,
    t,
    locale,
    ttsProviderId,
    ttsProvidersConfig,
    ttsSpeed,
    ttsVoice,
  ]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        stopPreview();
      }
      setOpen(nextOpen);
    },
    [stopPreview],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              className={cn(
                pillCls,
                ttsEnabled
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-700/50'
                  : 'border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60',
              )}
            >
              <Volume2 className="size-3.5" />
              {ttsEnabled && (
                <span className="max-w-[60px] truncate">
                  {localizedVoices.find((v) => v.id === ttsVoice)?.displayName || ttsVoice}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.ttsHint')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-[280px] p-0">
        {/* Header with toggle */}
        <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-border/40">
          <Volume2
            className={cn(
              'size-4 shrink-0',
              ttsEnabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
            )}
          />
          <span
            className={cn('flex-1 text-sm font-medium', !ttsEnabled && 'text-muted-foreground')}
          >
            {t('toolbar.ttsTitle')}
          </span>
          <Switch
            checked={ttsEnabled}
            onCheckedChange={setTTSEnabled}
            className="scale-[0.85] origin-right"
          />
        </div>

        {/* Config body */}
        {ttsEnabled && (
          <div className="px-3.5 py-3 space-y-3">
            {/* Voice + Preview row */}
            <div className="flex items-center gap-2">
              <Select value={ttsVoice} onValueChange={setTTSVoice}>
                <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {localizedVoices.map((v) => (
                    <SelectItem key={v.id} value={v.id} className="text-xs">
                      {v.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                onClick={handlePreview}
                disabled={!canPreview}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all shrink-0',
                  !canPreview && 'cursor-not-allowed opacity-50',
                  previewing
                    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {previewing ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Play className="size-3" />
                )}
                {previewing ? t('toolbar.ttsPreviewing') : t('toolbar.ttsPreview')}
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
