'use client';

/**
 * PBL v2 — Workspace shell.
 *
 * Three-column layout: stage tree sidebar (left, ~22%), agent chat
 * (center, ~52%), submission / hints side panel (right, ~26%).
 * Hidden when `uiPhase` is not 'workspace' — the parent renderer
 * routes other phases to Hero / Completion. The Workspace itself
 * doesn't manage navigation between phases; it just renders the
 * one it's been asked to show.
 */

import type { PBLMilestone, PBLProjectV2 } from '@/lib/pbl/v2/types';
import Image from 'next/image';
import { Maximize2, Workflow } from 'lucide-react';
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { PBLV2Sidebar } from './sidebar';
import { PBLV2AgentTabs } from './agent-tabs';
import { PBLV2SubmissionPanel, type SubmissionEvaluationStatus } from './submission';
import { PBLV2RightPanelTabs } from './right-panel-tabs';
import { shouldShowScenarioBriefing } from './scenario-briefing-gate';
import { cn } from '@/lib/utils/cn';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { CSSProperties } from 'react';
import { runOneStream, type StreamDisplayState, type StreamStatus } from './use-instructor-stream';
import type { PBLProjectPatch } from '@/lib/pbl/v2/api/sse';

interface Props {
  readonly project: PBLProjectV2;
  readonly onProjectChange: (next: PBLProjectV2) => void;
  /** Leave the workspace and go back to the Hero, keeping all progress.
   *  Hero then offers "Continue project" (progress intact) + a reset. */
  readonly onReturnToHero: () => void;
  /** True while an Instructor / evaluator stream is in flight (including one
   *  started before this workspace remounted). Threaded to the chat so its
   *  "thinking…" indicator survives a Hero ↔ workspace round trip. */
  readonly instructorStreaming: boolean;
  readonly onInstructorStreamingChange: (active: boolean) => void;
  /** When provided, render an "expand to fullscreen workspace" button
   *  (inline mode). Absent when rendered inside the immersive overlay. */
  readonly onExpand?: () => void;
}

type PanelSlot = 'sidebar' | 'chat' | 'submission';
type ResizeHandleSide = 'left' | 'right';
type CSSVariableProperties = CSSProperties & Record<`--${string}`, string | number>;

const DEFAULT_PANEL_WIDTHS = {
  sidebar: 22,
  chat: 52,
  submission: 26,
};

const PANEL_LIMITS = {
  sidebarMin: 15,
  sidebarMax: 36,
  chatMin: 34,
  submissionMin: 18,
  submissionMax: 38,
};

function streamStatusForEvaluationKind(kind: unknown): StreamStatus {
  if (kind === 'final') return 'eval-final';
  if (kind === 'milestone') return 'eval-milestone';
  if (kind === 'task') return 'eval-task';
  return 'instructor';
}

const PBL_WORKSPACE_THEME = {
  '--background': 'oklch(0.205 0.055 264)',
  '--foreground': 'oklch(0.962 0.016 260)',
  '--card': 'oklch(0.285 0.055 263)',
  '--card-foreground': 'oklch(0.97 0.014 260)',
  '--popover': 'oklch(0.265 0.055 263)',
  '--popover-foreground': 'oklch(0.97 0.014 260)',
  '--primary': '#9d8cff',
  '--primary-foreground': 'oklch(0.99 0.005 260)',
  '--secondary': 'oklch(0.32 0.052 260)',
  '--secondary-foreground': 'oklch(0.95 0.016 260)',
  '--muted': 'oklch(0.305 0.046 262)',
  '--muted-foreground': 'oklch(0.78 0.04 258)',
  '--accent': 'oklch(0.37 0.07 260)',
  '--accent-foreground': 'oklch(0.965 0.014 260)',
  '--destructive': 'oklch(0.66 0.19 25)',
  '--border': 'oklch(0.74 0.055 262 / 0.22)',
  '--input': 'oklch(0.68 0.05 262 / 0.3)',
  '--ring': 'oklch(0.73 0.12 282)',
} satisfies CSSVariableProperties;

interface CompleteTaskPayload {
  project?: PBLProjectV2;
  completedMicrotaskId?: string;
  milestoneId?: string;
  milestoneCompleted?: boolean;
  projectCompleted?: boolean;
  nextMicrotaskId?: string;
}

export function PBLV2Workspace({
  project,
  onProjectChange,
  onReturnToHero,
  instructorStreaming,
  onInstructorStreamingChange,
  onExpand,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [panelWidths, setPanelWidths] = useState(DEFAULT_PANEL_WIDTHS);
  const [resizingHandle, setResizingHandle] = useState<ResizeHandleSide | null>(null);
  const [submissionEvaluationStatus, setSubmissionEvaluationStatus] =
    useState<SubmissionEvaluationStatus | null>(null);
  const [sceneBusy, setSceneBusy] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [workspaceStream, setWorkspaceStream] = useState<StreamDisplayState | null>(null);
  const activeMilestoneIndex = useMemo(() => workspaceActiveMilestoneIndex(project), [project]);

  // SCENARIO ONLY. Once the learner has ENTERED the scenario (the prep stage is
  // complete), the right column gains a "scenario briefing" tab beside the
  // submission panel. `prep` only ever transitions to `completed`, so this
  // stays true for the rest of the run — through every roleplay stage, the
  // wrapup, and after returning from the completion page. Non-scenario projects
  // (and scenario projects still in prep) keep the bare submission panel, so
  // there is zero change for them.
  const showScenarioBriefing = useMemo(() => shouldShowScenarioBriefing(project), [project]);

  // SCENARIO ONLY. The sidebar scene controls all hit the same stateless
  // task/update endpoint (no LLM, no eval) and replace the local project
  // with the server-mutated result:
  //   - enter_scenario     → prep → first roleplay stage (+ divider)
  //   - continue_handover  → consume a staged handover → next stage (+ divider)
  // There is NO manual beat-advance control: within a roleplay stage, beats
  // advance ONLY when the engine detects the learner actually did them.
  // Ordinary projects never render these buttons; the server rejects any
  // action that is not a scenario stage in the right state.
  const runSceneAction = useCallback(
    async (action: 'enter_scenario' | 'continue_handover' | 'complete_act') => {
      if (sceneBusy) return;
      setSceneBusy(true);
      try {
        const res = await fetch('/api/pbl/v2/task/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project, action }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          data?: { project?: PBLProjectV2 };
          project?: PBLProjectV2;
        };
        const nextProject = data.data?.project ?? data.project;
        if (nextProject) onProjectChange(nextProject);
      } catch {
        /* transient; the button stays available for retry */
      } finally {
        setSceneBusy(false);
      }
    },
    [sceneBusy, project, onProjectChange],
  );
  const handleEnterScenario = useCallback(() => runSceneAction('enter_scenario'), [runSceneAction]);
  const handleContinueHandover = useCallback(
    () => runSceneAction('continue_handover'),
    [runSceneAction],
  );
  // ACT MODEL. Finish the current roleplay act. No confirmation: an act may
  // legitimately hold a single hidden beat that one learner turn satisfies, so
  // "finished after one message" is a valid path — not something to second-guess.
  // The button itself only appears once the learner has engaged the scene
  // (sidebar gates on ≥1 learner message), which is the only guard needed.
  const handleCompleteAct = useCallback(() => {
    void runSceneAction('complete_act');
  }, [runSceneAction]);

  const runWorkspaceStream = useCallback(
    async (startingProject: PBLProjectV2, status: StreamStatus, body: Record<string, unknown>) => {
      setWorkspaceStream({ status, draftAssistant: '', streamCommittedOutput: false });
      return runOneStream({
        endpoint: status === 'instructor' ? '/api/pbl/v2/open-task' : '/api/pbl/v2/evaluate',
        body,
        startingProject,
        setDraftAssistant: (update) => {
          setWorkspaceStream((current) => {
            const base =
              current && current.status === status
                ? current
                : { status, draftAssistant: '', streamCommittedOutput: false };
            return { ...base, draftAssistant: update(base.draftAssistant) };
          });
        },
        onPatch: (patch: PBLProjectPatch) => {
          if (patch.kind === 'message' || patch.kind === 'evaluation') {
            setWorkspaceStream((current) =>
              current ? { ...current, draftAssistant: '', streamCommittedOutput: true } : current,
            );
          }
        },
        onProjectUpdated: onProjectChange,
      });
    },
    [onProjectChange],
  );

  const runEvaluationPhase = useCallback(
    async (
      startingProject: PBLProjectV2,
      kind: 'task' | 'milestone' | 'final',
      body: Record<string, unknown>,
    ) => runWorkspaceStream(startingProject, streamStatusForEvaluationKind(kind), body),
    [runWorkspaceStream],
  );

  const runTaskOpenerPhase = useCallback(
    async (startingProject: PBLProjectV2) =>
      runWorkspaceStream(startingProject, 'instructor', {
        project: startingProject,
        phase: 'setup',
      }),
    [runWorkspaceStream],
  );

  const handleCompleteTask = useCallback(async () => {
    if (taskBusy || instructorStreaming || submissionEvaluationStatus) return;
    setTaskBusy(true);
    onInstructorStreamingChange(true);
    try {
      const res = await fetch('/api/pbl/v2/task/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, action: 'complete_pending_task' }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as CompleteTaskPayload & { data?: CompleteTaskPayload };
      const payload: CompleteTaskPayload = data.data ?? data;
      let nextProject = payload.project;
      if (!nextProject) return;
      onProjectChange(nextProject);

      if (payload.milestoneCompleted && payload.milestoneId) {
        nextProject = await runEvaluationPhase(nextProject, 'milestone', {
          project: nextProject,
          kind: 'milestone',
          milestoneId: payload.milestoneId,
        });
      }
      if (payload.projectCompleted) {
        nextProject = await runEvaluationPhase(nextProject, 'final', {
          project: nextProject,
          kind: 'final',
        });
      }
      if (!payload.milestoneCompleted && payload.nextMicrotaskId) {
        await runTaskOpenerPhase(nextProject);
      }
    } catch {
      /* transient; the button stays available for retry */
    } finally {
      setTaskBusy(false);
      setWorkspaceStream(null);
      onInstructorStreamingChange(false);
    }
  }, [
    taskBusy,
    instructorStreaming,
    submissionEvaluationStatus,
    onProjectChange,
    onInstructorStreamingChange,
    project,
    runEvaluationPhase,
    runTaskOpenerPhase,
  ]);
  const handleResizeStart = useCallback(
    (event: ReactMouseEvent, side: ResizeHandleSide) => {
      event.preventDefault();
      const root = rootRef.current;
      if (!root) return;

      const rect = root.getBoundingClientRect();
      if (rect.width <= 0) return;
      const startWidths = panelWidths;
      setResizingHandle(side);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const pointerPercent = ((moveEvent.clientX - rect.left) / rect.width) * 100;

        setPanelWidths(() => {
          if (side === 'left') {
            const pairTotal = startWidths.sidebar + startWidths.chat;
            const nextSidebar = clamp(
              pointerPercent,
              PANEL_LIMITS.sidebarMin,
              Math.min(PANEL_LIMITS.sidebarMax, pairTotal - PANEL_LIMITS.chatMin),
            );
            return {
              sidebar: nextSidebar,
              chat: pairTotal - nextSidebar,
              submission: startWidths.submission,
            };
          }

          const pairTotal = startWidths.chat + startWidths.submission;
          const nextSubmission = clamp(
            100 - pointerPercent,
            PANEL_LIMITS.submissionMin,
            Math.min(PANEL_LIMITS.submissionMax, pairTotal - PANEL_LIMITS.chatMin),
          );
          return {
            sidebar: startWidths.sidebar,
            chat: pairTotal - nextSubmission,
            submission: nextSubmission,
          };
        });
      };

      const handleMouseUp = () => {
        setResizingHandle(null);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [panelWidths],
  );

  return (
    <div
      ref={rootRef}
      className={cn(
        'grid h-full w-full overflow-hidden bg-background text-foreground ring-1 ring-indigo-100/[0.16]',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_24px_72px_rgba(42,50,95,0.20)]',
        'bg-[radial-gradient(circle_at_18%_5%,rgba(119,102,255,0.20),transparent_31%),radial-gradient(circle_at_86%_10%,rgba(20,184,166,0.17),transparent_29%),radial-gradient(circle_at_52%_105%,rgba(96,165,250,0.10),transparent_34%),linear-gradient(180deg,#182542_0%,#111c34_48%,#162743_100%)]',
      )}
      data-pbl-workspace="true"
      style={{
        ...PBL_WORKSPACE_THEME,
        gridTemplateRows: '58px minmax(0, 1fr)',
        gridTemplateColumns: `${panelWidths.sidebar}fr 6px ${panelWidths.chat}fr 6px ${panelWidths.submission}fr`,
      }}
    >
      <WorkspaceTopBar
        project={project}
        activeMilestoneIndex={activeMilestoneIndex}
        panelWidths={panelWidths}
        onReturnToHero={onReturnToHero}
        onExpand={onExpand}
      />
      <Panel slot="sidebar">
        {/* Scene controls ("finish this act" / enter / continue) are disabled
            while ANYTHING is generating: character speaking, narrator,
            evaluation, submission analysis and opener streams all flip
            `instructorStreaming` (ref-counted across remounts). It is never the
            learner's turn to advance the scene mid-generation, so gating here
            stops a click from racing an in-flight stream and corrupting state. */}
        <PBLV2Sidebar
          project={project}
          onEnterScenario={handleEnterScenario}
          onContinueHandover={handleContinueHandover}
          onCompleteAct={handleCompleteAct}
          onCompleteTask={handleCompleteTask}
          sceneBusy={sceneBusy || instructorStreaming}
          taskBusy={taskBusy}
        />
      </Panel>
      <WorkspaceResizeHandle
        side="left"
        active={resizingHandle === 'left'}
        onMouseDown={handleResizeStart}
      />
      <Panel slot="chat">
        <PBLV2AgentTabs
          project={project}
          onProjectChange={onProjectChange}
          submissionEvaluationStatus={submissionEvaluationStatus}
          instructorStreaming={instructorStreaming}
          onInstructorStreamingChange={onInstructorStreamingChange}
          externalStream={workspaceStream}
        />
      </Panel>
      <WorkspaceResizeHandle
        side="right"
        active={resizingHandle === 'right'}
        onMouseDown={handleResizeStart}
      />
      <Panel slot="submission">
        {showScenarioBriefing ? (
          <PBLV2RightPanelTabs
            project={project}
            onProjectChange={onProjectChange}
            onEvaluationStatusChange={setSubmissionEvaluationStatus}
            onInstructorStreamingChange={onInstructorStreamingChange}
            instructorStreaming={instructorStreaming}
          />
        ) : (
          <PBLV2SubmissionPanel
            project={project}
            onProjectChange={onProjectChange}
            onEvaluationStatusChange={setSubmissionEvaluationStatus}
            onInstructorStreamingChange={onInstructorStreamingChange}
            instructorStreaming={instructorStreaming}
          />
        )}
      </Panel>
    </div>
  );
}

function WorkspaceTopBar({
  project,
  activeMilestoneIndex,
  panelWidths,
  onReturnToHero,
  onExpand,
}: {
  readonly project: PBLProjectV2;
  readonly activeMilestoneIndex: number;
  readonly panelWidths: typeof DEFAULT_PANEL_WIDTHS;
  readonly onReturnToHero: () => void;
  readonly onExpand?: () => void;
}) {
  const { t } = useI18n();
  return (
    <header
      className="relative z-40 col-span-full grid min-w-0 items-center overflow-hidden border-b border-cyan-100/[0.12] bg-[#111d35]/88 px-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.09),0_14px_42px_rgba(5,12,28,0.24)] backdrop-blur-xl"
      style={{
        gridTemplateColumns: `${panelWidths.sidebar}fr 6px ${panelWidths.chat}fr 6px ${panelWidths.submission}fr`,
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(157,140,255,0.20),transparent_30%),radial-gradient(circle_at_78%_0%,rgba(34,211,238,0.13),transparent_26%),linear-gradient(90deg,rgba(255,255,255,0.05),transparent_34%,rgba(255,255,255,0.035))]" />
      <div className="relative flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-violet-200/25 bg-violet-100/[0.08] shadow-[0_0_24px_rgba(157,140,255,0.18)]">
          <Image
            src="/openmaic-mark.png"
            alt="OpenMAIC"
            width={28}
            height={28}
            className="h-6 w-6"
          />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="line-clamp-1 text-base font-semibold tracking-tight text-white">
              {project.title}
            </h2>
          </div>
          {/* Breadcrumb doubles as the "back to Hero" affordance: the brand
              (logo + project name) stays pinned top-left, and the "up" nav lives
              in the breadcrumb per standard SaaS practice (directional back is
              not placed in the top-right utility zone). */}
          <nav
            className="mt-0.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide"
            aria-label={t('pbl.v2.workspace.returnToHero')}
          >
            <button
              type="button"
              onClick={onReturnToHero}
              title={t('pbl.v2.workspace.returnToHero')}
              className="rounded bg-gradient-to-r from-violet-200 via-cyan-200 to-sky-200 bg-clip-text text-transparent transition-opacity hover:opacity-80 focus-visible:underline focus-visible:outline-none"
            >
              {t('pbl.v2.workspace.breadcrumbOverview')}
            </button>
            <span aria-hidden className="text-indigo-100/40">
              ›
            </span>
            <span className="text-indigo-100/55">{t('pbl.v2.workspace.breadcrumbCurrent')}</span>
          </nav>
        </div>
      </div>

      <div className="relative col-start-3 hidden min-w-0 items-center gap-2 lg:flex">
        <div className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-indigo-100/[0.14] bg-white/[0.045] px-2.5 text-[11px] font-medium text-indigo-100/82">
          <Workflow className="h-3.5 w-3.5 text-violet-200/90" />
          {t('pbl.v2.workspace.progressLabel')}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {project.milestones.map((milestone, index) => {
            const active = index === activeMilestoneIndex;
            const completed = milestone.status === 'completed';
            return (
              <div
                key={milestone.id}
                className="group relative flex min-w-0 flex-1 items-center"
                title={milestone.title}
              >
                <div
                  className={cn(
                    'h-1.5 min-w-4 flex-1 rounded-full transition-colors',
                    completed && 'bg-cyan-300/70 shadow-[0_0_12px_rgba(103,232,249,0.30)]',
                    active && 'bg-violet-300 shadow-[0_0_16px_rgba(167,139,250,0.42)]',
                    !active && !completed && 'bg-slate-500/35',
                  )}
                />
                {active && (
                  <div
                    className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/50 bg-violet-300 shadow-[0_0_18px_rgba(167,139,250,0.58)] transition-[left] duration-500 ease-out"
                    style={{ left: `${milestoneProgressFraction(milestone) * 100}%` }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {onExpand && (
        <button
          type="button"
          onClick={onExpand}
          className="absolute right-3 top-1/2 z-50 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md border border-cyan-100/[0.18] bg-white/[0.06] text-indigo-100/85 shadow-sm backdrop-blur transition-colors hover:bg-white/[0.12]"
          aria-label={t('pbl.v2.workspace.enterFullscreen')}
          title={t('pbl.v2.workspace.enterFullscreen')}
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      )}
    </header>
  );
}

/** Horizontal position (0..1) of the progress dot WITHIN the active
 *  milestone's bar segment, derived from how far the learner is through
 *  that milestone's own microtasks. The first task sits near the head,
 *  the last near the tail (a small margin keeps the dot off the very
 *  edges), evenly spaced in between. A single-task milestone centers the
 *  dot. The count is read off the milestone's OWN `microtasks`, so each
 *  stage uses its own task total — stage A's 2 tasks never get mixed with
 *  stage B's 3. */
function milestoneProgressFraction(milestone: PBLMilestone): number {
  const EDGE_MARGIN = 0.12;
  const total = milestone.microtasks.length;
  if (total <= 1) return 0.5;
  let index = milestone.microtasks.findIndex(
    (task) => task.status === 'todo' || task.status === 'in_progress',
  );
  // No open task left (all completed/skipped) → the learner is at the end
  // of this milestone, so pin the dot to the tail.
  if (index < 0) index = total - 1;
  return EDGE_MARGIN + (index / (total - 1)) * (1 - 2 * EDGE_MARGIN);
}

export function workspaceActiveMilestoneIndex(project: PBLProjectV2): number {
  const activeIndex = project.milestones.findIndex((milestone) => milestone.status === 'active');
  if (activeIndex >= 0) return activeIndex;
  if (project.status === 'completed') return -1;
  return project.milestones.length > 0 ? 0 : -1;
}

function WorkspaceResizeHandle({
  side,
  active,
  onMouseDown,
}: {
  readonly side: ResizeHandleSide;
  readonly active: boolean;
  readonly onMouseDown: (event: ReactMouseEvent, side: ResizeHandleSide) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={
        side === 'left'
          ? t('pbl.v2.workspace.resizeSidebar')
          : t('pbl.v2.workspace.resizeSubmission')
      }
      className={cn(
        'group relative z-30 row-start-2 h-full cursor-col-resize select-none bg-transparent',
        active && 'bg-primary/[0.04]',
      )}
      onMouseDown={(event) => onMouseDown(event, side)}
    >
      <div
        className={cn(
          'absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-cyan-100/[0.18] transition-colors',
          'group-hover:bg-primary/55',
          active && 'bg-primary/75',
        )}
      />
      <div
        className={cn(
          'absolute left-1/2 top-1/2 h-10 w-px -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/60 opacity-0 shadow-[0_0_14px_rgba(157,140,255,0.28)] transition-all',
          'group-hover:h-14 group-hover:opacity-100',
          active && 'h-16 opacity-100',
        )}
      />
    </div>
  );
}

function Panel({ slot, children }: { readonly slot: PanelSlot; readonly children: ReactNode }) {
  return (
    <div
      className={cn(
        'relative row-start-2 h-full min-w-0 overflow-hidden backdrop-blur-[2px]',
        slot === 'sidebar' &&
          'bg-[linear-gradient(180deg,rgba(28,39,71,0.96)_0%,rgba(22,34,62,0.94)_100%)] shadow-[inset_-18px_0_38px_rgba(5,12,28,0.10)]',
        slot === 'chat' &&
          'bg-[radial-gradient(circle_at_50%_0%,rgba(99,102,241,0.10),transparent_34%),linear-gradient(180deg,rgba(15,27,51,0.78)_0%,rgba(11,23,43,0.82)_100%)]',
        slot === 'submission' &&
          'bg-[linear-gradient(180deg,rgba(18,43,65,0.94)_0%,rgba(18,32,58,0.94)_100%)] shadow-[inset_18px_0_38px_rgba(5,12,28,0.10)]',
      )}
    >
      <div className="relative z-10 h-full">{children}</div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
