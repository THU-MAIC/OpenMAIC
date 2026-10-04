'use client';

import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { TTSProviderConfig } from '@/lib/audio/types';

interface TTSSpeedFieldProps {
  provider?: Pick<TTSProviderConfig, 'speedRange' | 'supportsSpeed'>;
  speed: number;
  /** A Qwen cloned voice always synthesizes at 1×. */
  cloneVoiceLocked?: boolean;
  onSpeedChange: (speed: number) => void;
}

export function TTSSpeedField({
  provider,
  speed,
  cloneVoiceLocked = false,
  onSpeedChange,
}: TTSSpeedFieldProps) {
  const { t } = useI18n();
  const speedUnsupported = provider?.supportsSpeed === false;
  const disabled = cloneVoiceLocked || speedUnsupported;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm">{t('settings.ttsSpeed')}</Label>
        <span className="text-xs text-muted-foreground">
          {disabled ? '1×' : `${speed.toFixed(2)}×`}
        </span>
      </div>
      <input
        aria-label={t('settings.ttsSpeed')}
        type="range"
        min={provider?.speedRange?.min ?? 0.5}
        max={provider?.speedRange?.max ?? 2}
        step={0.05}
        value={disabled ? 1 : speed}
        disabled={disabled}
        onChange={(event) => onSpeedChange(Number(event.target.value))}
        className="w-full disabled:cursor-not-allowed disabled:opacity-50"
      />
      {cloneVoiceLocked && (
        <p className="text-xs text-muted-foreground">{t('settings.qwenCloneSpeedHint')}</p>
      )}
      {speedUnsupported && (
        <p className="text-xs text-muted-foreground">{t('settings.ttsSpeedUnsupported')}</p>
      )}
    </div>
  );
}
