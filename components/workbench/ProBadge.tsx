'use client';

/**
 * The Pro badge — the switch into the workbench, worn on the wordmark's
 * shoulder like a trademark. `role="switch"` rather than a button, because it
 * has an on state that outlives the click.
 *
 * Ported from the spike's `ProBadge` (S9): it states the mode of the whole
 * page, which is exactly what a badge on the logo does and what a chip in a
 * toolbar cannot. Small, hairline, silent when off.
 */
import { motion, useReducedMotion } from 'motion/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import './pro-swap.css';

export interface ProBadgeProps {
  active: boolean;
  onToggle?: () => void;
  className?: string;
  /**
   * Override the default `pro-mode-exit` / `pro-mode-enter` testid.
   *
   * The workspace hero wears its own interactive badge while the rail keeps
   * the persistent switch. A distinct id keeps both controls addressable.
   */
  testId?: string;
}

export function ProBadge({ active, onToggle, className, testId }: ProBadgeProps) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const interactive = !!onToggle;

  const badge = (
    <motion.button
      type="button"
      role={interactive ? 'switch' : undefined}
      aria-checked={interactive ? active : undefined}
      aria-label={t('proMode.badgeAria')}
      data-testid={testId ?? (active ? 'pro-mode-exit' : 'pro-mode-enter')}
      data-pro-badge={active ? 'on' : 'off'}
      disabled={!interactive}
      onClick={onToggle}
      whileTap={reduceMotion || !interactive ? undefined : { scale: 0.94 }}
      className={cn(
        'relative inline-flex select-none items-center rounded-full border',
        'px-[7px] py-[2px] text-[9.5px] font-semibold uppercase leading-[1.35]',
        'tracking-[0.2em] transition-[color,background-color,border-color,box-shadow] duration-300',
        interactive ? 'cursor-pointer' : 'cursor-default',
        active
          ? [
              'border-violet-500/70 bg-violet-600 text-white',
              'shadow-[0_0_0_3px_rgba(139,92,246,0.14),0_1px_6px_rgba(109,40,217,0.35)]',
              'dark:border-violet-400/60 dark:bg-violet-500',
            ]
          : [
              'border-border bg-background/70 text-muted-foreground',
              'hover:border-violet-400/70 hover:bg-violet-50/60 hover:text-violet-600',
              'dark:hover:bg-violet-500/10',
              'dark:hover:border-violet-400/40 dark:hover:text-violet-300',
            ],
        className,
      )}
    >
      {/* The negative right margin pays back the trailing letter-space that
          `tracking` adds after the O, so the word sits centred in the pill. */}
      <span className="-mr-[0.2em]">Pro</span>
    </motion.button>
  );

  if (!interactive) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {active ? t('proMode.badgeExit') : t('proMode.badgeEnter')}
      </TooltipContent>
    </Tooltip>
  );
}
