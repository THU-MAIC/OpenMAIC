'use client';

import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface InsertionZoneProps {
  readonly label: string;
  readonly onInsert: () => void;
}

/**
 * Hover-revealed insertion affordance between two thumbs.
 *
 * The gap is a slim 8px hit zone that matches playback `SceneSidebar`'s
 * `space-y-2` density (no layout shift, ever). On hover the `+` badge
 * pops out to the right side of the gap with a small overshoot, sitting
 * on its own z-layer with a solid background + soft drop shadow so it
 * clearly floats above any adjacent violet ring.
 */
export function InsertionZone({ label, onInsert }: InsertionZoneProps) {
  // `z-20` lifts the whole zone above adjacent `Reorder.Item` siblings.
  // Without this, the next-in-DOM-order ThumbItem (which has a `transform`
  // via motion's Reorder, creating its own stacking context) paints on
  // top, and its violet ring clips through the `+` badge regardless of
  // any z-index applied inside the InsertionZone itself.
  return (
    <div className="group/insert relative isolate z-20 h-2 cursor-pointer overflow-visible">
      <button
        type="button"
        onClick={onInsert}
        aria-label={label}
        title={label}
        data-testid="slide-nav-insert"
        className="absolute inset-0 z-10 outline-none focus-visible:opacity-100"
      >
        <span className="sr-only">{label}</span>
      </button>
      <span
        aria-hidden
        className={cn(
          // Anchored at the right edge of the gap, vertically centered.
          // z-30 lifts it above the adjacent active tile's ring (z-default).
          'pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 z-30',
          'inline-flex h-5 w-5 items-center justify-center rounded-full',
          // Solid background + ring + shadow gives it real visual
          // elevation against the neighbouring violet ring zones.
          'bg-white text-violet-600 ring-1 ring-violet-200',
          'dark:bg-zinc-900 dark:text-violet-300 dark:ring-violet-400/40',
          'shadow-md shadow-violet-500/15 dark:shadow-violet-500/20',
          // Popup motion: start tiny + transparent, end full size with a
          // small overshoot. The custom cubic-bezier is a classic
          // "back-ease-out" giving it a quick, springy reveal.
          'opacity-0 scale-50',
          'group-hover/insert:opacity-100 group-hover/insert:scale-100',
          'group-focus-within/insert:opacity-100 group-focus-within/insert:scale-100',
          'transition-[opacity,transform] duration-200',
          '[transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)]',
        )}
      >
        <Plus className="h-3 w-3" strokeWidth={2.5} />
      </span>
    </div>
  );
}
