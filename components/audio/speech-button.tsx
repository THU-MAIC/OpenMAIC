'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Mic, Loader2 } from 'lucide-react';
import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';

interface SpeechButtonProps {
  onTranscription: (text: string) => void;
  className?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function SpeechButton({
  onTranscription,
  className,
  disabled,
  size = 'sm',
}: SpeechButtonProps) {
  const { t } = useI18n();

  // Ref to always call the latest onTranscription, avoiding stale closures
  const onTranscriptionRef = useRef(onTranscription);
  useEffect(() => {
    onTranscriptionRef.current = onTranscription;
  }, [onTranscription]);

  const stableOnTranscription = useCallback((text: string) => {
    onTranscriptionRef.current(text);
  }, []);

  const handleError = useCallback((error: string) => {
    toast.error(error);
  }, []);

  const { isRecording, isProcessing, startRecording, stopRecording } = useAudioRecorder({
    onTranscription: stableOnTranscription,
    onError: handleError,
  });

  const active = isRecording || isProcessing;

  const handleClick = () => {
    if (isRecording) {
      stopRecording();
    } else if (!isProcessing) {
      startRecording();
    }
  };

  const isMd = size === 'md';
  const sizeClasses = isMd ? 'h-8 w-8' : 'h-6 w-6';
  const iconSize = isMd ? 'w-4 h-4' : 'w-3.5 h-3.5';
  const barH = isMd ? 14 : 10;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled || isProcessing}
          onClick={handleClick}
          className={cn(
            'relative flex items-center justify-center rounded-lg transition-all duration-200 shrink-0 cursor-pointer',
            sizeClasses,
            active
              ? 'bg-violet-500/90 dark:bg-violet-600/80 text-white shadow-[0_0_12px_rgba(139,92,246,0.45)] dark:shadow-[0_0_12px_rgba(139,92,246,0.3)]'
              : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/80',
            disabled && 'opacity-40 pointer-events-none',
            className,
          )}
        >
          {/* Breathing ring when recording */}
          {isRecording && (
            <span
              className="absolute inset-[-4px] rounded-[10px] border border-violet-400/40 dark:border-violet-400/25"
              style={{
                animation: 'speech-ring 2s ease-in-out infinite',
              }}
            />
          )}

          {isProcessing ? (
            <Loader2 className={cn(iconSize, 'animate-spin')} />
          ) : isRecording ? (
            /* Mini equalizer bars */
            <span className="flex items-center gap-[2.5px] relative z-10">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="rounded-full bg-white"
                  style={{
                    width: isMd ? 2.5 : 2,
                    animation: `speech-bar ${0.4 + i * 0.15}s ease-in-out ${i * 0.1}s infinite alternate`,
                    height: 3,
                  }}
                />
              ))}
            </span>
          ) : (
            <Mic className={cn(iconSize, 'relative z-10')} />
          )}

          {/* Injected keyframes */}
          <style jsx>{`
            @keyframes speech-bar {
              0% {
                height: 3px;
              }
              100% {
                height: ${barH}px;
              }
            }
            @keyframes speech-ring {
              0%,
              100% {
                opacity: 0.3;
                transform: scale(1);
              }
              50% {
                opacity: 0.7;
                transform: scale(1.08);
              }
            }
          `}</style>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {isProcessing
          ? t('roundtable.processing')
          : isRecording
            ? t('voice.stopListening')
            : t('voice.startListening')}
      </TooltipContent>
    </Tooltip>
  );
}
