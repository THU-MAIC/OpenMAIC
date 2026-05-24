'use client';

import { Redo2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type {
  EditorCommand,
  InsertPaletteItem,
  SurfaceHistory,
} from '@/lib/edit/scene-editor-surface';

interface CommandBarProps {
  readonly title: string;
  readonly history?: SurfaceHistory;
  readonly insertItems?: readonly InsertPaletteItem[];
  readonly commands?: readonly EditorCommand[];
}

/**
 * Top bar of the Pro mode chrome. Undo/redo + title on the left, insert
 * primitives in the center, surface commands on the right. History /
 * insertItems / commands are all optional so the bar renders cleanly when
 * no surface is registered for the current scene type. Exiting Pro mode
 * is handled by the global Pro toggle in the playback Header (which stays
 * mounted above this bar), not by a dedicated button here.
 */
export function CommandBar({ title, history, insertItems, commands }: CommandBarProps) {
  const { t } = useI18n();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200/60 px-5 dark:border-zinc-800/60">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {history && (
          <>
            <IconButton title={t('edit.undo')} disabled={!history.canUndo} onClick={history.undo}>
              <Undo2 className="h-4 w-4" />
            </IconButton>
            <IconButton title={t('edit.redo')} disabled={!history.canRedo} onClick={history.redo}>
              <Redo2 className="h-4 w-4" />
            </IconButton>
          </>
        )}
        <span
          className={cn(
            'truncate text-sm font-medium text-zinc-700 dark:text-zinc-300',
            history && 'ml-2',
          )}
        >
          {title}
        </span>
      </div>

      {insertItems && insertItems.length > 0 && (
        <div className="flex shrink-0 items-center gap-1">
          {insertItems.map((item) => (
            <InsertButton key={item.id} item={item} />
          ))}
        </div>
      )}

      {commands && commands.length > 0 && (
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          {commands.map((command) => (
            <IconButton
              key={command.id}
              title={command.tooltip ?? command.label}
              disabled={command.disabled}
              onClick={command.onInvoke}
            >
              {command.icon ?? <span className="px-1 text-xs">{command.label}</span>}
            </IconButton>
          ))}
        </div>
      )}
    </header>
  );
}

function InsertButton({ item }: { readonly item: InsertPaletteItem }) {
  const button = (
    <button
      type="button"
      disabled={item.disabled}
      onClick={item.popoverContent ? undefined : item.onInvoke}
      className={`group flex h-9 items-center gap-1.5 rounded-xl px-3 transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        item.active
          ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
      }`}
    >
      <span className="flex h-4 w-4 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">
        {item.icon}
      </span>
      <span className="text-xs font-medium">{item.label}</span>
    </button>
  );

  const triggerWithTooltip = (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      {item.tooltip && <TooltipContent>{item.tooltip}</TooltipContent>}
    </Tooltip>
  );

  if (!item.popoverContent) return triggerWithTooltip;

  // Chain both triggers' asChild Slots directly onto the real <button>.
  // Wrapping PopoverTrigger around <Tooltip> (a provider, not a DOM node)
  // dropped the popover trigger handler, so the popover never opened —
  // mirrors the PR1 fix in FloatingToolbar's ActionButton.
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
        </TooltipTrigger>
        {item.tooltip && <TooltipContent>{item.tooltip}</TooltipContent>}
      </Tooltip>
      <PopoverContent side="bottom" align="center" className="w-80 p-3">
        {item.popoverContent()}
      </PopoverContent>
    </Popover>
  );
}

function IconButton({
  title,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { readonly title: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="h-8 w-8 shrink-0 rounded-xl text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}
