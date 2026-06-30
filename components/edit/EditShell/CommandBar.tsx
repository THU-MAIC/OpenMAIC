'use client';

import { ArrowLeft, Redo2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { EditorCommand, SurfaceHistory } from '@/lib/edit/scene-editor-surface';

interface CommandBarProps {
  readonly title: string;
  readonly history?: SurfaceHistory;
  readonly commands?: readonly EditorCommand[];
  /**
   * Right-edge slot owned by Stage. In Pro mode it carries the
   * HeaderControls (settings pill + Pro Switch + Download) since Stage
   * Header is unmounted to keep top chrome to a single bar.
   */
  readonly trailing?: ReactNode;
}

/**
 * Top bar of the Pro mode chrome. Undo/redo + title on the left, insert
 * primitives in the center, surface commands on the right. History /
 * insertItems / commands are all optional so the bar renders cleanly when
 * no surface is registered for the current scene type.
 *
 * Exiting Pro mode is handled by the global Pro Switch in the playback
 * Header (which stays mounted above this bar) — Pro mode is a toggle,
 * not a one-way state, so we deliberately do *not* place a "Done" pill
 * here that would compete with the Switch's affordance.
 */
export function CommandBar({ title, history, commands, trailing }: CommandBarProps) {
  const { t } = useI18n();
  const router = useRouter();

  return (
    <header className="flex h-20 shrink-0 items-center gap-3 border-b border-zinc-200/60 px-8 dark:border-zinc-800/60">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Back-to-home — mirrors playback Header's leftmost button so the
            user has the same global-out affordance across modes. */}
        <IconButton title={t('generation.backToHome')} onClick={() => router.push('/')}>
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
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
          className={cn('ml-2 truncate text-sm font-semibold text-zinc-700 dark:text-zinc-200')}
          title={title}
        >
          {title}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {commands && commands.length > 0 && (
          <div className="flex shrink-0 items-center gap-1">
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
        {trailing}
      </div>
    </header>
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
