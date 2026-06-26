'use client';

/**
 * PBL v2 — Workspace sidebar.
 *
 * Renders the project roadmap as a milestone tree. Every milestone
 * can be expanded so learners can inspect the full route; completed
 * tasks stay crossed out, future tasks stay muted, and the active
 * task remains highlighted.
 *
 * State icons (Lock / Circle / Check / SkipForward) come from
 * lucide-react to match the rest of OpenMAIC's icon set.
 *
 * SCENARIO ONLY — the fixed three-act skeleton (prep → roleplay → wrapup)
 * is made legible in the roadmap: each act gets a small section label, and
 * the roleplay act(s) are visually set apart (indented + tinted + a drama
 * marker) so the learner can tell at a glance that the simulation stretch is
 * different from the bookend prep/debrief stages. Ordinary projects (no
 * `project.scenario`) render exactly as before — none of this applies.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Circle,
  CircleDot,
  Lock,
  SkipForward,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Drama,
} from 'lucide-react';
import type { PBLProjectV2, PBLMicrotask, PBLMilestone } from '@/lib/pbl/v2/types';
import { PBL_SIMULATOR_AGENT_ID } from '@/lib/pbl/v2/operations/progress';
import { cn } from '@/lib/utils/cn';
import { useI18n } from '@/lib/hooks/use-i18n';

/** SCENARIO ONLY. The contextual scene control rendered under a stage.
 *  prep → enter the scene; an active roleplay act → finish it (act model:
 *  the learner ends the continuous scene when ready); a finished stage with a
 *  staged handover → cross to the next stage. There is NO mid-act beat advance. */
type SceneActionKind = 'enter' | 'continue' | 'complete';

/** SCENARIO ONLY. The fixed three-act stage role. */
type ScenarioStage = NonNullable<PBLMilestone['scenarioStage']>;

interface Props {
  readonly project: PBLProjectV2;
  /** SCENARIO ONLY. prep → enter the scene (enter_scenario). */
  readonly onEnterScenario?: () => void;
  /** SCENARIO ONLY. A finished stage with a staged handover → next stage
   *  (continue_handover). Only ever shown once the current stage's tasks are
   *  all complete (a handover is staged); there is NO manual beat advance. */
  readonly onContinueHandover?: () => void;
  /** SCENARIO ONLY (act model). The active roleplay act → finish it
   *  (complete_act). Shown once the learner has actually engaged the scene. */
  readonly onCompleteAct?: () => void;
  /** Ordinary PBL. Confirms a task that reached B point and advances it. */
  readonly onCompleteTask?: () => void;
  /** A scene action is in flight (disables the button). */
  readonly sceneBusy?: boolean;
  readonly taskBusy?: boolean;
}

export function PBLV2Sidebar({
  project,
  onEnterScenario,
  onContinueHandover,
  onCompleteAct,
  onCompleteTask,
  sceneBusy,
  taskBusy,
}: Props) {
  const { t } = useI18n();
  const activeMilestoneId = useMemo(
    () => project.milestones.find((m) => m.status === 'active')?.id,
    [project.milestones],
  );
  const isScenario = !!project.scenario;
  const pendingHandover =
    project.pendingHandover && !project.pendingHandover.consumed
      ? project.pendingHandover
      : undefined;
  // ACT MODEL gate: has the learner actually engaged the CURRENT act? The
  // simulator thread is shared across all roleplay acts, so we must scope to
  // THIS act's beats — checking "any user message in the thread" would let a
  // later act be finished without playing it (the first act's messages already
  // satisfy a thread-wide check). Learner messages carry the beat `microtaskId`
  // they were sent under, so we match against this milestone's beat ids.
  const simUserMessages = useMemo(
    () =>
      project.threads
        ?.find((t) => t.agentId === PBL_SIMULATOR_AGENT_ID)
        ?.messages.filter((m) => m.roleType === 'user') ?? [],
    [project.threads],
  );
  const hasEngagedAct = useCallback(
    (milestone: PBLMilestone): boolean => {
      const beatIds = new Set(milestone.microtasks.map((b) => b.id));
      return simUserMessages.some((m) => !!m.microtaskId && beatIds.has(m.microtaskId));
    },
    [simUserMessages],
  );
  const defaultExpandedIds = useMemo(() => sidebarDefaultExpandedMilestoneIds(project), [project]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(defaultExpandedIds));

  // SCENARIO ONLY. Maps the milestone id that OPENS each three-act section to
  // its stage, so we render a single section label at every stage boundary
  // (prep → first roleplay → wrapup). Empty for ordinary projects.
  const stageSectionStarts = useMemo(() => {
    const starts = new Map<string, ScenarioStage>();
    if (!isScenario) return starts;
    let prev: ScenarioStage | undefined;
    for (const m of project.milestones) {
      const stage = m.scenarioStage;
      if (stage && stage !== prev) starts.set(m.id, stage);
      prev = stage;
    }
    return starts;
  }, [isScenario, project.milestones]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional derived-state sync on milestone changes
    setExpandedIds((prev) => {
      const validIds = new Set(project.milestones.map((milestone) => milestone.id));
      const next = new Set([...prev].filter((id) => validIds.has(id)));
      for (const id of defaultExpandedIds) next.add(id);
      return next;
    });
  }, [defaultExpandedIds, project.milestones]);

  const totalMicrotasks = useMemo(
    () => project.milestones.reduce((acc, m) => acc + m.microtasks.length, 0),
    [project.milestones],
  );
  const completedMicrotasks = useMemo(
    () =>
      project.milestones.reduce(
        (acc, m) => acc + m.microtasks.filter((t) => t.status === 'completed').length,
        0,
      ),
    [project.milestones],
  );

  return (
    <aside className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-cyan-100/[0.12] bg-[#1a2746]/86 px-4 py-3 shadow-[inset_0_-1px_0_rgba(125,211,252,0.05)]">
        <h2 className="line-clamp-1 text-sm font-semibold tracking-tight text-white">
          {t('pbl.v2.sidebar.title')}
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          {t('pbl.v2.sidebar.summary', {
            completed: completedMicrotasks,
            total: totalMicrotasks,
            stages: project.milestones.length,
          })}
        </p>
      </header>

      <div className="pbl-v2-scroll-fade flex-1 overflow-y-auto px-2 py-3 space-y-2">
        {project.milestones.map((milestone, idx) => {
          // SCENARIO ONLY — one contextual scene control per state; ordinary
          // projects (no scenario) never get any of these:
          //   - prep + active                              → enter the scene
          //   - a finished stage with a staged handover    → continue to next
          // There is intentionally NO manual beat-advance control: WITHIN a
          // roleplay stage, beats advance ONLY when the engine detects the
          // learner actually did them — the learner can never click past an
          // interaction. The stage hand-off appears here (left roadmap), never
          // in the chat, and ONLY once the stage's tasks are all complete (a
          // handover is staged). Prep/wrapup controls are untouched.
          let sceneAction: { kind: SceneActionKind; onClick: () => void } | undefined;
          if (isScenario) {
            if (
              pendingHandover &&
              milestone.id === pendingHandover.completedMilestoneId &&
              onContinueHandover
            ) {
              sceneAction = { kind: 'continue', onClick: onContinueHandover };
            } else if (
              milestone.scenarioStage === 'prep' &&
              milestone.id === activeMilestoneId &&
              onEnterScenario
            ) {
              sceneAction = { kind: 'enter', onClick: onEnterScenario };
            } else if (
              // ACT MODEL: the active roleplay act → "finish this act". Gated by
              // a DETERMINISTIC signal — the learner must have actually engaged
              // the scene (≥1 message in the simulator thread) — so they can't
              // skip an act without playing it. No LLM judgement.
              milestone.scenarioStage === 'roleplay' &&
              milestone.id === activeMilestoneId &&
              hasEngagedAct(milestone) &&
              onCompleteAct
            ) {
              sceneAction = { kind: 'complete', onClick: onCompleteAct };
            }
          }
          const sectionStage = stageSectionStarts.get(milestone.id);
          return (
            <Fragment key={milestone.id}>
              {sectionStage && <StageLabel stage={sectionStage} />}
              <MilestoneNode
                milestone={milestone}
                index={idx}
                scenarioStage={isScenario ? milestone.scenarioStage : undefined}
                active={milestone.id === activeMilestoneId}
                expanded={expandedIds.has(milestone.id)}
                onToggle={() => {
                  setExpandedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(milestone.id)) next.delete(milestone.id);
                    else next.add(milestone.id);
                    return next;
                  });
                }}
                sceneAction={sceneAction}
                sceneBusy={sceneBusy}
                pendingTaskCompletionId={project.pendingTaskCompletion?.microtaskId}
                onCompleteTask={onCompleteTask}
                taskBusy={taskBusy}
              />
            </Fragment>
          );
        })}
      </div>
    </aside>
  );
}

/** SCENARIO ONLY. A small section header marking a three-act boundary. The
 *  prep & wrapup labels share a neutral look; the roleplay label is set apart
 *  (indented + drama marker + violet) to telegraph the immersive stretch. */
function StageLabel({ stage }: { readonly stage: ScenarioStage }) {
  const { t } = useI18n();
  const labelKey =
    stage === 'prep'
      ? 'pbl.v2.sidebar.stagePrep'
      : stage === 'wrapup'
        ? 'pbl.v2.sidebar.stageWrapup'
        : 'pbl.v2.sidebar.stageRoleplay';

  if (stage === 'roleplay') {
    return (
      <div className="ml-3 mt-2 mb-0.5 flex items-center px-1">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-500/20 px-2.5 py-1 ring-1 ring-violet-400/35 shadow-[0_4px_14px_rgba(124,92,255,0.25)]">
          <Drama className="h-3 w-3 text-violet-100" />
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-violet-50">
            {t(labelKey)}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="mt-1.5 flex items-center gap-1.5 px-2 pb-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
        {t(labelKey)}
      </span>
    </div>
  );
}

function MilestoneNode({
  milestone,
  index,
  scenarioStage,
  active,
  expanded,
  onToggle,
  sceneAction,
  sceneBusy,
  pendingTaskCompletionId,
  onCompleteTask,
  taskBusy,
}: {
  readonly milestone: PBLMilestone;
  readonly index: number;
  /** SCENARIO ONLY — drives the set-apart roleplay treatment. Undefined for
   *  ordinary projects and for non-scenario milestones. */
  readonly scenarioStage?: ScenarioStage;
  readonly active: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly sceneAction?: { kind: SceneActionKind; onClick: () => void };
  readonly sceneBusy?: boolean;
  readonly pendingTaskCompletionId?: string;
  readonly onCompleteTask?: () => void;
  readonly taskBusy?: boolean;
}) {
  const { t } = useI18n();
  const isRoleplay = scenarioStage === 'roleplay';
  // SCENARIO ONLY — a scenario milestone is an "act"; the user only ever sees
  // the act, never its inner microtasks. prep/wrapup carry one trivial task; a
  // roleplay act's beats are HIDDEN CHECKPOINTS (judged in the background, not
  // shown — the learner is not asked to tick them off). So every scenario
  // milestone renders as a single flat, non-expandable row. DISPLAY-only: the
  // microtasks still exist in the data model and advancement is untouched.
  // Ordinary (non-scenario) projects keep the normal expandable task tree.
  const flat = scenarioStage !== undefined;
  const sceneActionLabel: Record<SceneActionKind, string> = {
    enter: t('pbl.v2.sidebar.enterScenario'),
    continue: t('pbl.v2.sidebar.continueScene'),
    complete: t('pbl.v2.sidebar.completeAct'),
  };
  const stateIcon = (() => {
    if (milestone.status === 'completed') return <Check className="w-3.5 h-3.5 text-emerald-600" />;
    if (milestone.status === 'active')
      return (
        <CircleDot className={cn('w-3.5 h-3.5', isRoleplay ? 'text-violet-200' : 'text-primary')} />
      );
    return (
      <Lock
        className={cn('w-3.5 h-3.5', isRoleplay ? 'text-violet-300/70' : 'text-muted-foreground')}
      />
    );
  })();

  return (
    <div
      className={cn(
        'rounded-lg border border-transparent transition-colors',
        // SCENARIO ONLY — the roleplay act(s) read as an immersive "scene card":
        // indented off the flush-left bookends, a left accent rail like a stage
        // edge, a violet→fuchsia gradient fill and a soft glow. The prep/wrapup
        // bookends stay deliberately plain so the contrast carries the meaning.
        isRoleplay && 'ml-3 rounded-xl border-l-[3px] border-l-violet-400/70',
        isRoleplay &&
          !active &&
          'border-violet-400/25 bg-gradient-to-br from-violet-500/[0.15] via-violet-500/[0.07] to-fuchsia-500/[0.05] shadow-[0_8px_24px_rgba(124,92,255,0.16)]',
        isRoleplay &&
          active &&
          'border-violet-300/45 bg-gradient-to-br from-violet-500/[0.24] to-fuchsia-500/[0.10] shadow-[0_12px_32px_rgba(124,92,255,0.34)] ring-1 ring-violet-300/45',
        // Bookends & ordinary projects keep the original primary active highlight.
        !isRoleplay &&
          active &&
          'border-primary/[0.28] bg-primary/[0.11] shadow-[0_10px_28px_rgba(6,16,34,0.20)] ring-1 ring-primary/20',
        milestone.status === 'locked' && 'opacity-60',
      )}
    >
      {flat ? (
        // Single flat row — no expand affordance, no nested task list.
        <div className="flex w-full items-center gap-2 px-2 py-1.5 text-left">
          <span className="text-[10px] font-bold text-muted-foreground w-4 text-center">
            {index + 1}
          </span>
          {stateIcon}
          <span className="text-xs font-medium line-clamp-1 flex-1 text-foreground">
            {milestone.title}
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className="text-[10px] font-bold text-muted-foreground w-4 text-center">
            {index + 1}
          </span>
          {stateIcon}
          <span className="text-xs font-medium line-clamp-1 flex-1 text-foreground">
            {milestone.title}
          </span>
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </button>
      )}

      {!flat && expanded && (
        <ul className="pl-9 pr-2 pb-2 space-y-0.5">
          {milestone.microtasks.map((task) => (
            <MicrotaskRow
              key={task.id}
              task={task}
              showComplete={pendingTaskCompletionId === task.id}
              onCompleteTask={onCompleteTask}
              taskBusy={taskBusy}
            />
          ))}
        </ul>
      )}

      {sceneAction && (
        <div className="px-2 pb-2 pt-0.5">
          <button
            type="button"
            onClick={sceneBusy ? undefined : sceneAction.onClick}
            disabled={sceneBusy}
            className={cn(
              'flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition-colors',
              'bg-gradient-to-r from-primary to-violet-400 text-primary-foreground shadow-[0_8px_22px_rgba(124,92,255,0.30)] hover:brightness-110',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            {sceneActionLabel[sceneAction.kind]}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export function sidebarDefaultExpandedMilestoneIds(project: PBLProjectV2): string[] {
  if (project.status === 'completed') {
    return project.milestones.map((milestone) => milestone.id);
  }
  const active = project.milestones.find((milestone) => milestone.status === 'active');
  return active ? [active.id] : project.milestones[0] ? [project.milestones[0].id] : [];
}

function MicrotaskRow({
  task,
  showComplete,
  onCompleteTask,
  taskBusy,
}: {
  readonly task: PBLMicrotask;
  readonly showComplete?: boolean;
  readonly onCompleteTask?: () => void;
  readonly taskBusy?: boolean;
}) {
  const { t } = useI18n();
  const icon = (() => {
    switch (task.status) {
      case 'completed':
        return <Check className="w-3 h-3 text-emerald-600 shrink-0" />;
      case 'in_progress':
        return <CircleDot className="w-3 h-3 text-primary shrink-0" />;
      case 'skipped':
        return <SkipForward className="w-3 h-3 text-muted-foreground shrink-0" />;
      default:
        return <Circle className="w-3 h-3 text-muted-foreground shrink-0" />;
    }
  })();

  return (
    <li
      className={cn(
        'rounded-md px-1.5 py-1 text-[11px] transition-colors',
        task.status === 'in_progress' &&
          'bg-cyan-100/[0.08] text-foreground font-medium shadow-[inset_2px_0_0_rgba(157,140,255,0.9)]',
        task.status === 'completed' && 'text-muted-foreground line-through',
        task.status === 'todo' && 'text-muted-foreground/72',
      )}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="line-clamp-1 min-w-0 flex-1">{task.title}</span>
      </div>
      {showComplete && onCompleteTask && (
        <button
          type="button"
          onClick={taskBusy ? undefined : onCompleteTask}
          disabled={taskBusy}
          className={cn(
            'ml-5 mt-1.5 inline-flex min-w-[64px] items-center justify-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold',
            'border border-violet-100/15 bg-primary/72 text-white shadow-[0_6px_16px_rgba(157,140,255,0.16)] transition-colors hover:bg-primary/88',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          <Check className="h-3 w-3" />
          {t('pbl.v2.sidebar.completeTask')}
        </button>
      )}
    </li>
  );
}
