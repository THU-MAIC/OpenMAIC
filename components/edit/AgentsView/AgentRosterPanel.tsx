'use client';

import { ChevronDown, ChevronUp, Redo2, Trash2, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import { useAgentRoster } from './useAgentRoster';
import { AgentInspector } from './AgentInspector';

const ROLE_LABEL: Record<string, string> = {
  teacher: '教师',
  assistant: '助教',
  student: '学生',
};

const ROLE_BADGE: Record<string, string> = {
  teacher: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  assistant: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  student: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
};

const defaultBadge = 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';

interface RosterRowProps {
  readonly agent: GeneratedAgentConfig;
  readonly selected: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly canRemove: boolean;
  readonly onSelect: () => void;
  readonly onRemove: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
}

function RosterRow({
  agent,
  selected,
  isFirst,
  isLast,
  canRemove,
  onSelect,
  onRemove,
  onMoveUp,
  onMoveDown,
}: RosterRowProps) {
  const badge = ROLE_BADGE[agent.role] ?? defaultBadge;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group/row flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 transition-colors last:border-b-0',
        selected
          ? 'border-zinc-100 bg-violet-50/60 dark:border-zinc-800 dark:bg-violet-500/10'
          : 'border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40',
      )}
    >
      {/* Avatar */}
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-200/60 bg-zinc-100 dark:border-zinc-700/60 dark:bg-zinc-800"
        style={{ borderColor: agent.color + '33' }}
      >
        <img src={agent.avatar} alt={agent.name} className="h-full w-full object-cover" />
      </div>

      {/* Name + role badge */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
          {agent.name || '未命名'}
        </p>
        <span
          className={cn(
            'mt-0.5 inline-block rounded px-1 py-0 text-[10px] font-semibold uppercase tracking-wide',
            badge,
          )}
        >
          {ROLE_LABEL[agent.role] ?? agent.role}
        </span>
      </div>

      {/* Row actions — visible on hover/selection */}
      <div
        className={cn(
          'flex shrink-0 items-center gap-0.5 transition-opacity',
          selected ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <RowIconButton label="上移" disabled={isFirst} onClick={onMoveUp}>
          <ChevronUp className="size-3.5" />
        </RowIconButton>
        <RowIconButton label="下移" disabled={isLast} onClick={onMoveDown}>
          <ChevronDown className="size-3.5" />
        </RowIconButton>
        <RowIconButton
          label="删除"
          disabled={!canRemove}
          onClick={onRemove}
          danger
          title={!canRemove ? '需保留至少一位老师' : undefined}
        >
          <Trash2 className="size-3.5" />
        </RowIconButton>
      </div>
    </div>
  );
}

function RowIconButton({
  label,
  disabled,
  danger,
  onClick,
  title,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onClick: () => void;
  readonly title?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors disabled:pointer-events-none disabled:opacity-30',
        danger
          ? 'hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40'
          : 'hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Narrow single-column roster editor for the right rail's "角色" tab.
 * Scrollable list of agents with up/down reorder, delete, and inline inspector.
 */
export function AgentRosterPanel() {
  const {
    roster,
    selectedId,
    select,
    add,
    update,
    remove,
    reorder,
    canRemove,
    canChangeRole,
    history,
  } = useAgentRoster();

  const selectedAgent = selectedId ? roster.find((a) => a.id === selectedId) : undefined;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Panel header with undo/redo */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-100 px-3 dark:border-zinc-800">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          角色列表
        </span>
        <button
          type="button"
          title="撤销"
          aria-label="撤销"
          disabled={!history.canUndo}
          onClick={history.undo}
          className="grid size-6 place-items-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <Undo2 className="size-3.5" />
        </button>
        <button
          type="button"
          title="重做"
          aria-label="重做"
          disabled={!history.canRedo}
          onClick={history.redo}
          className="grid size-6 place-items-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <Redo2 className="size-3.5" />
        </button>
      </div>

      {/* Scrollable content: list + inspector */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto">
        {/* Agent rows */}
        <div className="flex flex-col">
          {roster.length === 0 && (
            <p className="px-4 py-6 text-center text-[12px] text-zinc-400 dark:text-zinc-500">
              还没有角色，点击下方按钮添加
            </p>
          )}
          {roster.map((agent, index) => (
            <RosterRow
              key={agent.id}
              agent={agent}
              selected={selectedId === agent.id}
              isFirst={index === 0}
              isLast={index === roster.length - 1}
              canRemove={canRemove(agent.id)}
              onSelect={() => select(agent.id)}
              onRemove={() => remove(agent.id)}
              onMoveUp={() => reorder(agent.id, index - 1)}
              onMoveDown={() => reorder(agent.id, index + 1)}
            />
          ))}

          {/* Add row */}
          <button
            type="button"
            onClick={() => add('teacher')}
            className="flex items-center gap-2 px-3 py-2.5 text-[13px] font-medium text-violet-600 transition-colors hover:bg-violet-50/60 dark:text-violet-400 dark:hover:bg-violet-500/10"
          >
            <span className="flex h-5 w-5 items-center justify-center rounded bg-violet-100 text-sm font-semibold text-violet-600 dark:bg-violet-500/20 dark:text-violet-400">
              +
            </span>
            添加角色
          </button>
        </div>

        {/* Inspector for selected agent */}
        {selectedAgent && (
          <div className="border-t border-zinc-100 dark:border-zinc-800">
            <AgentInspector
              agent={selectedAgent}
              onUpdate={(patch) => update(selectedAgent.id, patch)}
              canChangeRole={canChangeRole}
              narrow
            />
          </div>
        )}
      </div>
    </div>
  );
}
