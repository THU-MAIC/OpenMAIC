'use client';

import { Mic } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface SpeechButtonProps {
  onTranscription: (text: string) => void;
  className?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

/**
 * Speech button stub — ASR providers removed.
 * Renders a disabled mic button that does nothing.
 */
export function SpeechButton({ className, disabled, size = 'sm' }: SpeechButtonProps) {
  const { t } = useI18n();

  const isMd = size === 'md';
  const sizeClasses = isMd ? 'h-8 w-8' : 'h-6 w-6';
  const iconSize = isMd ? 'w-4 h-4' : 'w-3.5 h-3.5';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={true}
          className={cn(
            'relative flex items-center justify-center rounded-lg transition-all duration-200 shrink-0 cursor-pointer',
            sizeClasses,
            'text-muted-foreground/60 opacity-40 pointer-events-none',
            disabled && 'opacity-40 pointer-events-none',
            className,
          )}
        >
          <Mic className={cn(iconSize, 'relative z-10')} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {t('voice.startListening')}
      </TooltipContent>
    </Tooltip>
  );
}
