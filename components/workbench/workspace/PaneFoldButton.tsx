'use client';

/**
 * A pane's own fold button — one per pane, in that pane's header.
 *
 * Folding used to happen on the seam. That works for exactly one collapsible
 * pane per seam; with two it produced a pair of mutually-reversed chevrons at the
 * same height, an arm's length from the slide navigator's own fold, and no way to
 * tell which panel any of them meant. A panel's controls belong in the panel, so
 * each pane now folds from the trailing end of its own header row: it is the one
 * place where "this panel" is unambiguous, because the header IS the panel's name
 * plate.
 *
 * The NAVIGATION RAIL uses this too, and its adoption closed the last exception:
 * the rail was held to have "no header", so its fold stayed a pill floating in
 * the middle of its own seam — the one line that also resizes the rail, which
 * left one seam speaking two languages. The rail does have a header: the row
 * carrying the wordmark and the PRO pill. Its fold sits there now, beside them,
 * and the rail's seam resizes and nothing else, exactly like the other two.
 *
 * Not a boxed panel glyph — the product removed those on purpose. It is a thin
 * chevron in a ghost button that only tints on hover: at rest a quiet mark in a
 * header, and the direction it points is the direction the pane leaves.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export function PaneFoldButton({
  testId,
  label,
  /** Which way the pane folds — the chevron points there. */
  direction,
  expanded,
  className,
  onClick,
}: {
  readonly testId: string;
  readonly label: string;
  readonly direction: 'left' | 'right';
  /**
   * Publish `aria-expanded` for the pane this button folds. Passed where the
   * SAME control is the only one governing a pane's two states (the rail's, in
   * its header) so a screen reader hears which state it is in; omitted where
   * folding and reopening are two different controls in two different places,
   * and a permanent `aria-expanded="true"` would be describing a state the
   * button can never be seen in.
   */
  readonly expanded?: boolean;
  /** Layout hook for the owning header; the control keeps its shared visuals. */
  readonly className?: string;
  readonly onClick: () => void;
}) {
  const Chevron = direction === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      title={label}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md',
        'text-[var(--ws-ink-mute,currentColor)] opacity-60 transition-[opacity,background-color,color] duration-150',
        'hover:bg-[var(--ws-tint,rgba(0,0,0,0.04))] hover:opacity-100',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ws-accent-thread,currentColor)]',
        className,
      )}
    >
      <Chevron className="size-4" strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
