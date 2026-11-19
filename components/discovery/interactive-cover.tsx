'use client';

import type { LucideIcon } from 'lucide-react';
import { Atom, Box, CodeXml, FlaskConical, Gamepad2, ListChecks, Workflow } from 'lucide-react';
import type { WidgetType } from '@openmaic/dsl';
import type { InteractiveCoverData } from '@/lib/utils/course-cover';

/** The glyph of each widget kind; Atom (the interactive-mode badge) when none. */
const WIDGET_ICONS: Record<WidgetType, LucideIcon> = {
  simulation: FlaskConical,
  diagram: Workflow,
  code: CodeXml,
  game: Gamepad2,
  visualization3d: Box,
  'procedural-skill': ListChecks,
};

/**
 * The static cover of an interactive page: the widget kind's glyph and the
 * page's title on the interactive surface (the emerald family the editor's
 * interactive mockups use). A picture of the page, never the page itself —
 * no iframe runs, the title is plain text.
 *
 * Fills the cover box it is placed in and takes no size of its own, so it
 * changes no card's geometry. Decorative on purpose: every surface showing
 * this cover also names the course next to it (`aria-hidden`). `compact`
 * drops the title for the smallest covers, e.g. the 64px chat course chip.
 */
export function InteractiveCover({
  cover,
  compact = false,
}: {
  cover: InteractiveCoverData;
  compact?: boolean;
}) {
  const Icon = (cover.widgetType && WIDGET_ICONS[cover.widgetType]) || Atom;
  const showTitle = !compact && cover.title.length > 0;
  return (
    <div
      aria-hidden="true"
      className="flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br from-emerald-50 to-teal-50 p-3 text-center dark:from-emerald-950/40 dark:to-teal-950/30"
    >
      <div
        className={
          compact
            ? 'flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300'
            : 'flex size-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300'
        }
      >
        <Icon className={compact ? 'size-4' : 'size-6'} />
      </div>
      {showTitle && (
        <p className="line-clamp-2 max-w-full text-[13px] leading-snug font-medium text-emerald-900/70 dark:text-emerald-100/70">
          {cover.title}
        </p>
      )}
    </div>
  );
}
