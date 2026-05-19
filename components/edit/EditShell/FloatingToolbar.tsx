'use client';

import { Fragment } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { FloatingAction } from '@/lib/edit/scene-editor-surface';

interface FloatingToolbarProps {
  readonly actions: readonly FloatingAction[];
}

/**
 * Contextual mini-bar shown above the canvas when something is selected.
 * Each action is either a button (onInvoke) or a popover trigger
 * (popoverContent) — used by the slide surface for color pickers, font
 * select, etc. so properties live here instead of in a fixed right panel.
 */
export function FloatingToolbar({ actions }: FloatingToolbarProps) {
  if (actions.length === 0) return null;

  const grouped = groupByGroup(actions);

  return (
    <div className="pointer-events-none absolute left-1/2 top-5 z-20 -translate-x-1/2">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-2xl bg-white/95 p-1 shadow-[0_4px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-zinc-200/60 backdrop-blur dark:bg-zinc-900/95 dark:shadow-[0_4px_24px_-8px_rgba(0,0,0,0.5)] dark:ring-zinc-800/60">
        {grouped.map((group, groupIndex) => (
          <Fragment key={groupIndex}>
            {groupIndex > 0 && <div className="mx-0.5 h-5 w-px bg-zinc-200 dark:bg-zinc-800" />}
            {group.map((action) => (
              <ActionButton key={action.id} action={action} />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ActionButton({ action }: { readonly action: FloatingAction }) {
  const isDanger = action.id === 'delete';
  const button = (
    <button
      type="button"
      disabled={action.disabled}
      onClick={action.popoverContent ? undefined : action.onInvoke}
      className={`flex h-8 items-center gap-1.5 rounded-xl px-2 transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        isDanger
          ? 'text-zinc-500 hover:bg-rose-50 hover:text-rose-600 dark:text-zinc-400 dark:hover:bg-rose-950/40 dark:hover:text-rose-400'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
      }`}
    >
      {action.icon}
      {!action.icon && <span className="text-xs">{action.label}</span>}
    </button>
  );

  const triggerWithTooltip = (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{action.tooltip ?? action.label}</TooltipContent>
    </Tooltip>
  );

  if (!action.popoverContent) return triggerWithTooltip;

  // Chain both triggers' asChild Slots directly onto the real <button>.
  // Wrapping PopoverTrigger around <Tooltip> (a provider, not a DOM node)
  // dropped the popover trigger handler, so the popover never opened —
  // this is the first popoverContent consumer to exercise that path.
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{action.tooltip ?? action.label}</TooltipContent>
      </Tooltip>
      {/* w-auto: let the action's own content size the popover (the text
          property bar is a wide single row); max-w-[92vw] keeps it on-screen
          and Radix handles edge collision. Avoids the fixed-w-72 clip.

          onOpenAutoFocus prevented: opening the bar must NOT pull focus off
          the canvas selection (commands apply to the live selection).
          onFocusOutside prevented: format commands refocus the editor
          (execCommand → editorView.focus()); without this the bar would
          dismiss after every single click. Escape and pointer-down truly
          outside still close it (defaults untouched), so it behaves like a
          contextual bar that stays up across consecutive formatting steps. */}
      <PopoverContent
        side="bottom"
        align="center"
        className="w-auto max-w-[92vw] p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onFocusOutside={(e) => e.preventDefault()}
      >
        {action.popoverContent()}
      </PopoverContent>
    </Popover>
  );
}

function groupByGroup(items: readonly FloatingAction[]): FloatingAction[][] {
  const groups: FloatingAction[][] = [];
  let current: FloatingAction[] = [];
  let currentKey: string | undefined;
  for (const item of items) {
    const key = item.group;
    if (key !== currentKey && current.length > 0) {
      groups.push(current);
      current = [];
    }
    currentKey = key;
    current.push(item);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
