'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

/* Volume icon based on level */
export function VolumeIcon({
  muted,
  volume,
  disabled,
  className = 'w-3.5 h-3.5',
}: {
  muted: boolean;
  volume: number;
  disabled: boolean;
  className?: string;
}) {
  if (disabled || muted || volume === 0) return <VolumeX className={className} />;
  if (volume < 0.5) return <Volume1 className={className} />;
  return <Volume2 className={className} />;
}

/**
 * The product's volume control: the speaker mutes on a click, and resting on it brings up
 * the level above. One control for every surface that reads aloud.
 */
export function VolumeControl({
  muted,
  volume,
  enabled = true,
  onToggleMute,
  onVolumeChange,
  buttonClassName,
  iconClassName,
  side = 'top',
}: {
  readonly muted: boolean;
  readonly volume: number;
  readonly enabled?: boolean;
  readonly onToggleMute: () => void;
  readonly onVolumeChange?: (volume: number) => void;
  readonly buttonClassName?: string;
  readonly iconClassName?: string;
  /** Where the level opens: above the speaker, or beside it where something sits above. */
  readonly side?: 'top' | 'left' | 'right';
}) {
  const [volumeHover, setVolumeHover] = useState(false);
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleVolumeEnter = useCallback(() => {
    clearTimeout(volumeTimerRef.current);
    setVolumeHover(true);
  }, []);
  const handleVolumeLeave = useCallback(() => {
    volumeTimerRef.current = setTimeout(() => setVolumeHover(false), 300);
  }, []);
  useEffect(() => () => clearTimeout(volumeTimerRef.current), []);
  const { t } = useI18n();
  const effectiveVolume = muted ? 0 : volume;
  return (
    <div
      className="relative flex items-center"
      data-testid="volume-control"
      data-toolbar-control="volume"
      onFocus={handleVolumeEnter}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) handleVolumeLeave();
      }}
      onMouseEnter={handleVolumeEnter}
      onMouseLeave={handleVolumeLeave}
    >
      <button
        type="button"
        onClick={onToggleMute}
        disabled={!enabled}
        className={cn(
          buttonClassName,
          !enabled
            ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
            : muted
              ? 'text-red-500 dark:text-red-400'
              : 'text-gray-500 dark:text-gray-400',
        )}
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        <VolumeIcon muted={muted} volume={volume} disabled={!enabled} className={iconClassName} />
      </button>

      {/* Vertical volume slider (pops up above) */}
      <div
        inert={!volumeHover || !enabled}
        className={cn(
          'absolute z-30 flex items-center',
          side === 'top'
            ? 'bottom-full left-1/2 -translate-x-1/2 mb-2 flex-col'
            : side === 'left'
              ? 'right-full top-1/2 -translate-y-1/2 mr-2 flex-row'
              : 'left-full top-1/2 -translate-y-1/2 ml-2 flex-row-reverse',
          'transition-all duration-200 ease-out pointer-events-none opacity-0',
          volumeHover && enabled && 'pointer-events-auto opacity-100',
        )}
      >
        <div
          className={cn(
            'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg flex items-center gap-1.5',
            side === 'top'
              ? 'flex-col px-2 py-2.5'
              : side === 'left'
                ? 'flex-row-reverse px-2.5 py-2'
                : 'flex-row px-2.5 py-2',
          )}
        >
          <span
            className={cn(
              'text-[10px] text-gray-400 dark:text-gray-500 tabular-nums font-medium select-none',
              side === 'left' && 'w-5 text-end',
              side === 'right' && 'w-5 text-start',
            )}
          >
            {Math.round(effectiveVolume * 100)}
          </span>
          <input
            type="range"
            aria-label={t('mobileClassroom.volume')}
            disabled={!enabled}
            min={0}
            max={1}
            step={0.05}
            value={effectiveVolume}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              onVolumeChange?.(v);
              if (v > 0 && muted) onToggleMute();
            }}
            className={cn(
              'appearance-none cursor-pointer',
              'rounded-full bg-gray-200 dark:bg-gray-600',
              side === 'top' ? 'h-16 w-1 [writing-mode:vertical-lr] [direction:rtl]' : 'h-1 w-20',
              '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3',
              '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-violet-500 [&::-webkit-slider-thumb]:dark:bg-violet-400',
              '[&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer',
              '[&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3',
              '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-violet-500 [&::-moz-range-thumb]:border-0',
            )}
          />
        </div>
        {/* Arrow pointing at the speaker */}
        <div
          className={cn(
            'w-2 h-2 bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 rotate-45',
            side === 'top'
              ? 'border-b border-r -mt-[5px]'
              : side === 'left'
                ? 'border-t border-r -ml-[5px]'
                : 'border-b border-l -mr-[5px]',
          )}
        />
      </div>
    </div>
  );
}
