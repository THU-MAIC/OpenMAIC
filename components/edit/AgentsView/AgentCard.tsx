'use client';

import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

/** Role display label (bilingual: English role key used internally). */
const ROLE_LABEL: Record<string, string> = {
  teacher: '教师',
  assistant: '助教',
  student: '学生',
};

/** Role accent colours matching the agent color palette conventions. */
const ROLE_ACCENT: Record<string, { badge: string; rail: string }> = {
  teacher: {
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
    rail: 'from-blue-400 to-blue-600',
  },
  assistant: {
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    rail: 'from-emerald-400 to-emerald-600',
  },
  student: {
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
    rail: 'from-amber-400 to-amber-600',
  },
};

const defaultAccent = {
  badge: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  rail: 'from-zinc-400 to-zinc-600',
};

interface AgentCardProps {
  readonly agent: GeneratedAgentConfig;
  readonly selected: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly canRemove: boolean;
  readonly onSelect: () => void;
  readonly onRemove: () => void;
  readonly onMoveLeft: () => void;
  readonly onMoveRight: () => void;
}

export function AgentCard({
  agent,
  selected,
  isFirst,
  isLast,
  canRemove,
  onSelect,
  onRemove,
  onMoveLeft,
  onMoveRight,
}: AgentCardProps) {
  const accent = ROLE_ACCENT[agent.role] ?? defaultAccent;

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
      data-testid="agent-card"
      className={cn(
        'group/card relative cursor-pointer overflow-hidden rounded-2xl border bg-white transition-all dark:bg-zinc-900',
        selected
          ? 'border-violet-200/80 shadow-[0_12px_32px_-16px_rgba(114,46,209,0.35)] dark:border-violet-500/25'
          : 'border-zinc-200/80 hover:border-zinc-300 hover:shadow-[0_8px_24px_-16px_rgba(24,24,27,0.20)] dark:border-zinc-800 dark:hover:border-zinc-700',
      )}
    >
      {/* Left accent rail */}
      <div
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 w-1 bg-gradient-to-b transition-opacity',
          accent.rail,
          selected ? 'opacity-100' : 'opacity-0',
        )}
      />

      <div className="flex flex-col gap-3 p-4 pl-5">
        {/* Avatar + name + role */}
        <div className="flex items-center gap-3">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-zinc-200/60 bg-zinc-100 dark:border-zinc-700/60 dark:bg-zinc-800"
            style={{ borderColor: agent.color + '33' }}
          >
            <img src={agent.avatar} alt={agent.name} className="h-full w-full object-cover" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              {agent.name}
            </p>
            <span
              className={cn(
                'mt-0.5 inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
                accent.badge,
              )}
            >
              {ROLE_LABEL[agent.role] ?? agent.role}
            </span>
          </div>
        </div>

        {/* Persona excerpt */}
        {agent.persona && (
          <p className="line-clamp-2 text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
            {agent.persona}
          </p>
        )}

        {/* Action row — visible on hover/selection */}
        <div
          className={cn(
            'flex items-center justify-between gap-1 transition-opacity',
            selected ? 'opacity-100' : 'opacity-0 group-hover/card:opacity-100',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Reorder buttons */}
          <div className="flex items-center gap-1">
            <SmallIconButton
              label="向左移动"
              disabled={isFirst}
              onClick={onMoveLeft}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </SmallIconButton>
            <SmallIconButton
              label="向右移动"
              disabled={isLast}
              onClick={onMoveRight}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </SmallIconButton>
          </div>

          {/* Delete button */}
          <SmallIconButton
            label="删除"
            disabled={!canRemove}
            onClick={onRemove}
            danger
            title={!canRemove ? '需保留至少一位老师' : undefined}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </SmallIconButton>
        </div>
      </div>
    </div>
  );
}

function SmallIconButton({
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
        'flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 transition-colors disabled:pointer-events-none disabled:opacity-30',
        danger
          ? 'hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40'
          : 'hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300',
      )}
    >
      {children}
    </button>
  );
}
