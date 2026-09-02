'use client';

/**
 * Composer pills — the one visual language for everything staged above the input
 * box: an uploaded material, a loaded skill, a referenced slide element.
 *
 * Before this there were three: a 6px-radius bordered chip for materials, a
 * 5px-radius accent chip for skills, and nothing for elements. They also sat on
 * different token sets — the skill chip read `--wb-accent-soft`, which only
 * exists inside `.wbchat`, so on the homepage launch composer it rendered with
 * no fill at all. Everything here is expressed in the app's semantic tokens, so
 * one pill looks the same on all three composer surfaces and follows the theme.
 *
 * The register is deliberately quiet. The workbench composer is a single input
 * box and this row sits directly above it: it is a receipt for what is attached,
 * not a second control panel. So: one line, 11px, a hairline, a wash at ~8%
 * strength, and colour only where colour carries meaning (accent = a skill is
 * steering the turn, ref = these elements are pinned on the canvas right now,
 * danger = this one failed). The remove affordance stays at low contrast until
 * the pill is hovered — a row of six bright ✕ glyphs is the loudest thing on a
 * surface whose loudest thing should be the send button.
 */
import { Loader2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export type ComposerPillTone = 'neutral' | 'accent' | 'ref' | 'pending' | 'danger';

/**
 * `ref` borrows the violet of the canvas pin on purpose: a numbered pin on the
 * slide and its pill in the composer are one object seen twice, and sharing the
 * hue is what says so before any number is read.
 */
const TONE: Record<ComposerPillTone, string> = {
  neutral: 'border-border bg-muted/50 text-foreground/85',
  accent: 'border-primary/30 bg-primary/[0.08] text-primary',
  ref: 'border-violet-400/45 bg-violet-500/[0.08] text-violet-700 dark:border-violet-400/40 dark:text-violet-300',
  pending: 'border-border/70 bg-transparent text-muted-foreground',
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
};

const REMOVE_TONE: Record<ComposerPillTone, string> = {
  neutral: 'hover:bg-foreground/10',
  accent: 'hover:bg-primary/15',
  ref: 'hover:bg-violet-500/15',
  pending: 'hover:bg-foreground/10',
  danger: 'hover:bg-destructive/15',
};

/** Wash behind the ordinal badge, per tone (only `ref` numbers its pills today). */
const ORDINAL_TONE: Record<ComposerPillTone, string> = {
  neutral: 'bg-foreground/10',
  accent: 'bg-primary/15',
  ref: 'bg-violet-500/18',
  pending: 'bg-foreground/10',
  danger: 'bg-destructive/15',
};

/** The row a composer's pills live in — one place for its gap and wrapping. */
export function ComposerPillRow({
  children,
  className,
  testId,
  contents = false,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly testId?: string;
  /**
   * This group is INSIDE another group's row. `display: contents` drops this
   * box so its pills join the outer row's flex line — materials, elements,
   * named courses and skills then wrap through one another as a single run
   * instead of each kind claiming a line of its own — while the group keeps a
   * node to be addressed by (its test id).
   */
  readonly contents?: boolean;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        contents ? 'contents' : 'flex flex-wrap items-center gap-1 px-1 pb-2',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ComposerPill({
  tone = 'neutral',
  icon,
  /** Ordinal badge shown before the icon (element references only). */
  ordinal,
  label,
  /** Second, dimmer run on the same line — a skill's `/handle`, a file's size. */
  meta,
  title,
  onRemove,
  removeLabel,
  onMouseEnter,
  onMouseLeave,
  testId,
  className,
}: {
  readonly tone?: ComposerPillTone;
  readonly icon?: ReactNode;
  readonly ordinal?: number;
  readonly label: ReactNode;
  readonly meta?: ReactNode;
  readonly title?: string;
  readonly onRemove?: () => void;
  readonly removeLabel?: string;
  readonly onMouseEnter?: () => void;
  readonly onMouseLeave?: () => void;
  readonly testId?: string;
  readonly className?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      title={title}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        'group/pill inline-flex max-w-[220px] items-center gap-1 rounded-[7px] border py-[1px] pl-1.5 pr-1 text-[11px] leading-[17px] transition-colors duration-150',
        'motion-safe:animate-[composer-pill-in_160ms_cubic-bezier(0.16,1,0.3,1)]',
        TONE[tone],
        className,
      )}
    >
      {ordinal ? (
        <span
          className={cn(
            // `leading-none` is the centring: the pill's own 17px line-height is
            // inherited by this 14px circle otherwise, so the digit is laid out
            // in a line box taller than the badge and sits visibly low.
            'grid size-[14px] shrink-0 place-items-center rounded-full font-mono text-[9px] font-semibold leading-none tabular-nums',
            ORDINAL_TONE[tone],
          )}
        >
          {ordinal}
        </span>
      ) : null}
      {icon ? <span className="inline-flex shrink-0 items-center opacity-70">{icon}</span> : null}
      <span className="min-w-0 truncate">{label}</span>
      {/* Also truncatable, and that is not a detail: a skill's handle can be
          `/my-adaptive-interactive-course-design`. Held at `shrink-0` it burst
          the pill's max width — the text ran on and the ✕ ended up floating
          outside the rounded ground, which is what made the skill pill read as
          a different species from the material pill beside it. */}
      {meta ? <span className="min-w-0 truncate opacity-60">{meta}</span> : null}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          className={cn(
            'ml-px grid size-[15px] shrink-0 place-items-center rounded-[4px] opacity-45 transition-[opacity,background-color] duration-150 group-hover/pill:opacity-80 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current',
            REMOVE_TONE[tone],
          )}
        >
          <X size={10} strokeWidth={2.5} />
        </button>
      ) : (
        <span className="w-px shrink-0" />
      )}
    </span>
  );
}

/** A pill whose subject is still settling (an upload in flight). */
export function ComposerPendingPill({
  label,
  testId,
}: {
  readonly label: ReactNode;
  readonly testId?: string;
}) {
  return (
    <ComposerPill
      tone="pending"
      testId={testId}
      icon={<Loader2 size={10} className="animate-spin motion-reduce:animate-none" />}
      label={label}
    />
  );
}
