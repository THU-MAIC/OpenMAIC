'use client';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { InsertPaletteItem } from '@/lib/edit/scene-editor-surface';
import { cn } from '@/lib/utils';

interface Props {
  readonly item: InsertPaletteItem;
  readonly iconOnly?: boolean;
  readonly popoverSide?: 'bottom' | 'right';
}

/**
 * Single insert-palette button. Reused by both the (legacy) CommandBar
 * insert slot and the FloatingInsertToolbar at the canvas's left edge.
 *
 * When the item declares `popoverContent`, the button doubles as a
 * popover trigger — and PopoverTrigger's `asChild` Slot is chained
 * directly onto the real `<button>` so wrapping a `<Tooltip>`
 * (provider, not DOM) doesn't drop the popover trigger handler.
 */
export function InsertButton({ item, iconOnly = false, popoverSide = 'bottom' }: Props) {
  const button = (
    <button
      type="button"
      disabled={item.disabled}
      onClick={item.popoverContent ? undefined : item.onInvoke}
      aria-label={iconOnly ? item.label : undefined}
      aria-pressed={typeof item.active === 'boolean' ? item.active : undefined}
      className={cn(
        'group flex h-9 items-center rounded-xl transition-colors disabled:pointer-events-none disabled:opacity-40',
        iconOnly ? 'w-9 justify-center px-0' : 'gap-1.5 px-3',
        item.active
          ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
      )}
    >
      <span className="flex h-4 w-4 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">
        {item.icon}
      </span>
      {!iconOnly && <span className="text-xs font-medium">{item.label}</span>}
    </button>
  );

  const triggerWithTooltip = (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      {item.tooltip && (
        <TooltipContent side={iconOnly ? 'right' : undefined}>{item.tooltip}</TooltipContent>
      )}
    </Tooltip>
  );

  if (!item.popoverContent) return triggerWithTooltip;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
        </TooltipTrigger>
        {item.tooltip && (
          <TooltipContent side={iconOnly ? 'right' : undefined}>{item.tooltip}</TooltipContent>
        )}
      </Tooltip>
      <PopoverContent
        side={popoverSide}
        align={popoverSide === 'right' ? 'start' : 'center'}
        className="w-80 p-3"
      >
        {item.popoverContent()}
      </PopoverContent>
    </Popover>
  );
}
