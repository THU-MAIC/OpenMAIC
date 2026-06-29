'use client';

import { Users } from 'lucide-react';
import { AgentCard } from './AgentCard';
import type { AgentRoster } from '@/lib/edit/agent-ops';

interface AgentRosterGridProps {
  readonly roster: AgentRoster;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onAdd: (role?: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onReorder: (id: string, index: number) => void;
  readonly canRemove: (id: string) => boolean;
}

/**
 * A responsive grid of AgentCard tiles, with a trailing [+ 添加角色] add tile.
 */
export function AgentRosterGrid({
  roster,
  selectedId,
  onSelect,
  onAdd,
  onRemove,
  onReorder,
  canRemove,
}: AgentRosterGridProps) {
  if (roster.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center p-8">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-100 to-violet-50 text-violet-500 shadow-[0_8px_24px_-12px_rgba(114,46,209,0.4)] dark:from-violet-500/20 dark:to-violet-500/5 dark:text-violet-300">
          <Users className="h-7 w-7" strokeWidth={1.75} />
        </div>
        <p className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">还没有角色</p>
        <p className="max-w-xs text-xs text-zinc-400 dark:text-zinc-500">
          点击下方按钮添加教师、助教或学生角色
        </p>
        <button
          type="button"
          onClick={() => onAdd('teacher')}
          className="mt-2 rounded-xl border border-dashed border-violet-300 bg-violet-50/60 px-4 py-2 text-sm font-medium text-violet-600 transition-colors hover:border-violet-400 hover:bg-violet-100/60 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300 dark:hover:border-violet-400/60"
        >
          + 添加教师角色
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {roster.map((agent, index) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            selected={selectedId === agent.id}
            isFirst={index === 0}
            isLast={index === roster.length - 1}
            canRemove={canRemove(agent.id)}
            onSelect={() => onSelect(agent.id)}
            onRemove={() => onRemove(agent.id)}
            onMoveLeft={() => onReorder(agent.id, index - 1)}
            onMoveRight={() => onReorder(agent.id, index + 1)}
          />
        ))}

        {/* Add tile */}
        <button
          type="button"
          data-testid="agent-add-tile"
          onClick={() => onAdd('teacher')}
          className="flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-zinc-200 text-zinc-400 transition-all hover:border-violet-300 hover:bg-violet-50/40 hover:text-violet-500 dark:border-zinc-700 dark:text-zinc-500 dark:hover:border-violet-500/40 dark:hover:bg-violet-500/10 dark:hover:text-violet-400"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-100 text-xl font-light transition-colors group-hover:bg-violet-100 dark:bg-zinc-800">
            +
          </span>
          <span className="text-xs font-medium">添加角色</span>
        </button>
      </div>
    </div>
  );
}
