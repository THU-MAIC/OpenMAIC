'use client';

import { ChevronDown } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

/**
 * Host-side "more below" cue for an interactive page that still scrolls after
 * the frame shrank it to its floor scale. It sits over the frame, outside the
 * sandbox, and disappears once the page reports it is scrolled to the end.
 * Clicking it scrolls the page by most of a screen.
 */
export function InteractiveMoreBelowCue({ onClick }: { readonly onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-testid="interactive-more-below"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-background/90 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-safe:animate-in motion-safe:fade-in"
    >
      <ChevronDown aria-hidden className="size-3.5" />
      {t('chat.interactiveMoreBelow')}
    </button>
  );
}
