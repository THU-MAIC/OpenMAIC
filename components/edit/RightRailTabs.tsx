'use client';

import { useCallback, useRef, useState } from 'react';
import {
  History,
  PanelRightClose,
  PanelRightOpen,
  SquarePen,
  Trash2,
  UsersRound,
} from 'lucide-react';
import type { AssistantRuntime } from '@assistant-ui/react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { AgentEditSessionRecord } from '@/lib/agent/client/agent-edit-session-types';
import { useI18n } from '@/lib/hooks/use-i18n';
import { AgentPanel } from '@/components/edit/AgentPanel/AgentPanel';
import { AgentRosterPanel } from '@/components/edit/AgentsView/AgentRosterPanel';
import { shouldRenderAgentPanel } from '@/components/edit/agent-panel-visibility';

const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 384;

type RailTab = 'ai' | 'agents';

export interface RightRailTabsProps {
  readonly scene?: { id: string; title: string; type?: string };
  readonly runtime: AssistantRuntime;
  readonly clearThread: () => void;
  readonly hasMessages: boolean;
  readonly canSend: boolean;
  readonly agentEnabled: boolean;
  readonly isRunning: boolean;
  readonly sessions: AgentEditSessionRecord[];
  readonly activeSessionId: string | undefined;
  readonly switchSession: (id: string) => Promise<void>;
  readonly deleteSessionAndRefresh: (id: string) => Promise<void>;
  readonly refreshSessions: () => Promise<void>;
}

/**
 * Tabbed right rail: "Edit with AI" | "课堂阵容"
 *
 * Owns the aside wrapper, resize handle, collapse state, and tab state.
 * The AgentPanel is rendered in naked (no-wrapper) mode for the AI tab;
 * the 课堂阵容 tab renders AgentRosterPanel. Both are kept mounted so state
 * is preserved when switching tabs (hidden via CSS).
 *
 * The "Edit with AI" tab is gated by shouldRenderAgentPanel — when the current
 * scene type does not support AI editing, the tab is hidden and the active tab
 * falls back to 课堂阵容 (which is always available, as agents are stage-level).
 */
export function RightRailTabs({
  scene,
  runtime,
  clearThread,
  hasMessages,
  canSend,
  agentEnabled,
  isRunning,
  sessions,
  activeSessionId,
  switchSession,
  deleteSessionAndRefresh,
  refreshSessions,
}: RightRailTabsProps) {
  const { t } = useI18n();
  const showAiTab = shouldRenderAgentPanel({ agentEnabled, hasMessages, isRunning });
  const [activeTab, setActiveTab] = useState<RailTab>(() => (showAiTab ? 'ai' : 'agents'));

  // When the AI tab becomes unavailable (e.g. PBL scene), fall back to agents tab.
  // Render-time setState: React re-renders immediately before painting.
  if (!showAiTab && activeTab === 'ai') {
    setActiveTab('agents');
  }
  const [collapsed, setCollapsed] = useState(false);

  const railRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragRef = useRef<{
    startX: number;
    startW: number;
    lastW: number;
    pointerId: number;
  } | null>(null);

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const startW = railRef.current?.getBoundingClientRect().width ?? width;
      dragRef.current = { startX: e.clientX, startW, lastW: startW, pointerId: e.pointerId };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* best effort */
      }
      document.body.style.cursor = 'col-resize';
    },
    [width],
  );

  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, d.startW + (d.startX - e.clientX)));
    d.lastW = next;
    if (railRef.current) railRef.current.style.width = `${next}px`;
  }, []);

  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* may already be released */
    }
    setWidth(d.lastW);
    dragRef.current = null;
    document.body.style.cursor = '';
  }, []);

  if (collapsed) {
    return (
      <aside
        onClick={() => setCollapsed(false)}
        title={t('edit.agent.expand')}
        className="group/rail relative flex h-full w-11 shrink-0 cursor-pointer flex-col items-center gap-3 border-l border-gray-100 bg-white/80 pt-3 backdrop-blur-xl transition-colors hover:bg-violet-50/40 dark:border-gray-800 dark:bg-slate-900/80 dark:hover:bg-violet-500/5 shadow-[-2px_0_24px_rgba(0,0,0,0.02)]"
      >
        <span className="grid size-8 place-items-center rounded-lg text-[#5b1fa8] transition-colors group-hover/rail:bg-violet-100/70 dark:text-violet-300 dark:group-hover/rail:bg-violet-500/15">
          <PanelRightOpen className="size-4" />
        </span>
      </aside>
    );
  }

  const agentPanelProps = {
    scene,
    runtime,
    clearThread,
    hasMessages,
    canSend,
    sessions,
    activeSessionId,
    switchSession,
    deleteSessionAndRefresh,
    refreshSessions,
  };

  return (
    <aside
      ref={railRef}
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-gray-100 bg-white/80 backdrop-blur-xl dark:border-gray-800 dark:bg-slate-900/80 shadow-[-2px_0_24px_rgba(0,0,0,0.02)]"
    >
      {/* Resize handle */}
      <div
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="group absolute left-0 top-0 bottom-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-violet-400/30 active:bg-violet-500/50 dark:hover:bg-violet-500/30"
      >
        <div className="absolute left-0.5 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-gray-300 transition-colors group-hover:bg-violet-400 dark:bg-gray-600 dark:group-hover:bg-violet-500" />
      </div>

      {/* Tab strip — single header row, no nested header */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-gray-100 px-2 dark:border-gray-800">
        <div
          role="tablist"
          className="flex items-center gap-0.5 rounded-lg bg-zinc-100/80 p-0.5 dark:bg-zinc-800"
        >
          {showAiTab && (
            <RailTabButton
              label="Edit with AI"
              active={activeTab === 'ai'}
              onClick={() => setActiveTab('ai')}
            />
          )}
          <RailTabButton
            label="课堂阵容"
            icon={<UsersRound className="size-[15px]" />}
            active={activeTab === 'agents'}
            onClick={() => setActiveTab('agents')}
          />
        </div>

        {/* Spacer + conditional AI-tab actions */}
        <div className="flex flex-1 items-center justify-end gap-0.5">
          {activeTab === 'ai' && (
            <>
              <Popover onOpenChange={(open) => open && void refreshSessions()}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    title={t('edit.agent.sessionHistory')}
                    aria-label={t('edit.agent.sessionHistory')}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <History className="size-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-1">
                  {sessions.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                      {t('edit.agent.sessionEmpty')}
                    </p>
                  ) : (
                    <ul className="max-h-80 overflow-y-auto">
                      {sessions.map((s) => (
                        <li key={s.id} className="group flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void switchSession(s.id)}
                            className={cn(
                              'flex-1 truncate rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted',
                              s.id === activeSessionId
                                ? 'bg-muted font-medium text-foreground'
                                : 'text-muted-foreground',
                            )}
                          >
                            {s.title || t('edit.agent.sessionUntitled')}
                          </button>
                          <button
                            type="button"
                            title={t('edit.agent.sessionDelete')}
                            aria-label={t('edit.agent.sessionDelete')}
                            onClick={() => void deleteSessionAndRefresh(s.id)}
                            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground/40 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </PopoverContent>
              </Popover>

              {hasMessages && (
                <button
                  type="button"
                  onClick={clearThread}
                  title={t('edit.agent.newConversation')}
                  aria-label={t('edit.agent.newConversation')}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
                >
                  <SquarePen className="size-4" />
                </button>
              )}
            </>
          )}

          {/* Collapse button always visible */}
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title={t('edit.agent.collapse')}
            aria-label={t('edit.agent.collapse')}
            className="grid size-7 place-items-center rounded-md text-muted-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
          >
            <PanelRightClose className="size-4" />
          </button>
        </div>
      </div>

      {/* Tab content — both mounted, non-active hidden via CSS for state preservation */}
      <div className={cn('flex flex-1 min-h-0 flex-col', activeTab !== 'ai' && 'hidden')}>
        <AgentPanel naked {...agentPanelProps} />
      </div>
      <div className={cn('flex flex-1 min-h-0 flex-col', activeTab !== 'agents' && 'hidden')}>
        <AgentRosterPanel />
      </div>
    </aside>
  );
}

function RailTabButton({
  label,
  icon,
  active,
  onClick,
}: {
  readonly label: string;
  readonly icon?: React.ReactNode;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-md px-2.5 py-0.5 text-[11.5px] font-semibold transition-all',
        active
          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
