'use client';

import { ListChecks, Plus, Presentation } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { EditableSceneType } from '@/lib/edit/scene-defaults';

interface InsertionZoneProps {
  readonly label: string;
  readonly slideLabel: string;
  readonly quizLabel: string;
  readonly onInsert: (type: EditableSceneType) => void;
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
export function InsertionZone({ label, slideLabel, quizLabel, onInsert }: InsertionZoneProps) {
  // `z-20` lifts the whole zone above adjacent `Reorder.Item` siblings.
  // Without this, the next-in-DOM-order ThumbItem (which has a `transform`
  // via motion's Reorder, creating its own stacking context) paints on
  // top, and its violet ring clips through the `+` badge regardless of
  // any z-index applied inside the InsertionZone itself.
  return (
    <Popover>
      <div className="group/insert relative isolate z-20 h-2 cursor-pointer overflow-visible">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            title={label}
            data-testid="slide-nav-insert"
            className="absolute inset-0 z-10 outline-none focus-visible:opacity-100"
          >
            <span className="sr-only">{label}</span>
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
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="center"
          sideOffset={8}
          className="w-40 p-1.5"
          data-testid="scene-type-chooser"
        >
          <SceneTypeChoice
            type="slide"
            label={slideLabel}
            Icon={Presentation}
            onInsert={onInsert}
          />
          <SceneTypeChoice type="quiz" label={quizLabel} Icon={ListChecks} onInsert={onInsert} />
        </PopoverContent>
      </div>
    </Popover>
  );
}

function SceneTypeChoice({
  type,
  label,
  Icon,
  onInsert,
}: {
  readonly type: EditableSceneType;
  readonly label: string;
  readonly Icon: typeof Presentation;
  readonly onInsert: (type: EditableSceneType) => void;
}) {
  return (
    <PopoverClose asChild>
      <button
        type="button"
        onClick={() => onInsert(type)}
        data-testid={`scene-type-${type}`}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm',
          'text-zinc-700 outline-none transition-colors hover:bg-violet-50 hover:text-violet-700',
          'focus-visible:bg-violet-50 focus-visible:text-violet-700',
          'dark:text-zinc-200 dark:hover:bg-violet-500/10 dark:hover:text-violet-300',
          'dark:focus-visible:bg-violet-500/10 dark:focus-visible:text-violet-300',
        )}
      >
        <Icon className="h-4 w-4 text-violet-500" strokeWidth={1.8} aria-hidden="true" />
        <span>{label}</span>
      </button>
    </PopoverClose>
  );
}
