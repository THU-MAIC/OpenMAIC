'use client';

import { PanelLeft, PanelLeftClose, Redo2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/hooks/use-i18n';
import type {
  EditorCommand,
  InsertPaletteItem,
  SurfaceHistory,
} from '@/lib/edit/scene-editor-surface';

interface CommandBarProps {
  readonly title: string;
  readonly history: SurfaceHistory;
  readonly insertItems: readonly InsertPaletteItem[];
  readonly commands: readonly EditorCommand[];
  readonly sidebarCollapsed?: boolean;
  readonly onToggleSidebar?: () => void;
}

/**
 * Top toolbar — Pitch-inspired: title on the left, insert primitives in the
 * center as labeled icon buttons, global commands (undo/redo + view toggles)
 * on the right. Borderless; relies on bottom hairline for separation.
 */
export function CommandBar({
  title,
  history,
  insertItems,
  commands,
  sidebarCollapsed,
  onToggleSidebar,
}: CommandBarProps) {
  const { t } = useI18n();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200/60 px-5 dark:border-zinc-800/60">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {onToggleSidebar && (
          <IconButton
            title={sidebarCollapsed ? t('edit.sidebar.expand') : t('edit.sidebar.collapse')}
            onClick={onToggleSidebar}
          >
            {sidebarCollapsed ? (
              <PanelLeft className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </IconButton>
        )}
        <IconButton title={t('edit.undo')} disabled={!history.canUndo} onClick={history.undo}>
          <Undo2 className="h-4 w-4" />
        </IconButton>
        <IconButton title={t('edit.redo')} disabled={!history.canRedo} onClick={history.redo}>
          <Redo2 className="h-4 w-4" />
        </IconButton>
        <span className="ml-2 truncate text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {title}
        </span>
      </div>

      {insertItems.length > 0 && (
        <div className="flex shrink-0 items-center gap-1">
          {insertItems.map((item) => (
            <InsertButton key={item.id} item={item} />
          ))}
        </div>
      )}

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
    </header>
  );
}

function InsertButton({ item }: { readonly item: InsertPaletteItem }) {
  const button = (
    <button
      type="button"
      disabled={item.disabled}
      onClick={item.popoverContent ? undefined : item.onInvoke}
      className="group flex h-9 items-center gap-1.5 rounded-xl px-3 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
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

  return (
    <Popover>
      <PopoverTrigger asChild>{triggerWithTooltip}</PopoverTrigger>
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
