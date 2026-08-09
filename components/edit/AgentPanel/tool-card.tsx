'use client';

/**
 * Shared tool-call card for the AgentBar, in the AgentSidebar design board's
 * `.ae-tool` language: a bordered row with a leading glyph, truncating title, an
 * optional `@scene` pill, an optional inline bar-action (always visible on the
 * row — e.g. a Restore button), an icon-only status mark (running = violet
 * spinner, done = emerald check ✓, failed = amber cross ✗; the text label is a
 * hover tooltip). Tool cards are intentionally NOT expandable. Every tool card
 * (regenerate / read / future) renders through this
 * shell so they stay visually uniform.
 */
import type { ReactNode } from 'react';
import { AtSign, Check, CircleStop, Loader2, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useStageStore } from '@/lib/store/stage';

export type ToolStatus = 'running' | 'done' | 'failed' | 'stopped';

/**
 * True when a tool result is the synthetic "stopped" marker the client runtime
 * writes for tool calls that never produced a result because the user cancelled
 * the turn (see use-agent-runtime). Shared so every tool UI reports a stopped
 * card the same way.
 */
export function isStoppedResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { __stopped?: boolean }).__stopped === true
  );
}

/**
 * The page (scene) a tool acted on, shown as an `@title` chip — the chat is a
 * single global thread (Cursor-style), so each tool card carries its own scene
 * reference instead of splitting history per page.
 */
export function ScenePill({ sceneId }: { sceneId?: string }) {
  const title = useStageStore((s) =>
    sceneId ? (s.scenes.find((x) => x.id === sceneId)?.title ?? null) : null,
  );
  if (!title) return null;
  return (
    <span className="inline-flex min-w-0 max-w-[150px] shrink items-center gap-0.5 rounded-md border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10.5px] font-medium text-[#5b1fa8] dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
      <AtSign className="size-2.5 shrink-0 text-violet-500" />
      <span className="truncate">{title}</span>
    </span>
  );
}

const STATUS_ICON: Record<ToolStatus, LucideIcon> = {
  running: Loader2,
  done: Check,
  failed: X,
  stopped: CircleStop,
};

const STATUS_TONE: Record<ToolStatus, string> = {
  running: 'text-[#5b1fa8] dark:text-violet-300',
  done: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-amber-600 dark:text-amber-400',
  // Stopped: a deliberately loud rose stop sign so an interrupted run reads as
  // "you stopped this", clearly distinct from a green done or amber failure.
  stopped: 'text-rose-600 dark:text-rose-400',
};

export function ToolCard({
  title,
  icon: Icon,
  sceneId,
  status,
  statusLabel,
  barAction,
}: {
  title: string;
  icon: LucideIcon;
  sceneId?: string;
  status: ToolStatus;
  /** Shown as a hover tooltip on the status mark (the mark itself is icon-only). */
  statusLabel: string;
  /** Inline action rendered on the always-visible row (e.g. Restore). */
  barAction?: ReactNode;
}) {
  const running = status === 'running';
  const StatusIcon = STATUS_ICON[status];

  return (
    <div
      className={cn(
        'overflow-hidden rounded-[9px] border',
        running ? 'border-violet-300 dark:border-violet-500/40' : 'border-border',
      )}
    >
      <div className="flex w-full items-center gap-2 bg-muted/50 px-2.5 py-2 text-left">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        {/* Title takes the free space and truncates; the @scene pill rides in the
            right cluster next to the status mark, so pills stay right-aligned
            across cards regardless of how long each tool name is. */}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground">
          {title}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {barAction ? <span>{barAction}</span> : null}
          <ScenePill sceneId={sceneId} />
          <span title={statusLabel} className={cn('inline-flex items-center', STATUS_TONE[status])}>
            <StatusIcon className={cn('size-4', running && 'animate-spin')} />
          </span>
        </span>
      </div>
    </div>
  );
}
