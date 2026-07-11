/**
 * PBL v2 — Microtask / milestone progress operations.
 *
 * Pure functions that mutate `PBLProjectV2`. Called from:
 *   - the Instructor agent's `advance_micro_task` tool path
 *   - the `/api/pbl/v2/task/update` route (when the learner clicks
 *     Continue on a milestone handover card, or skips a task)
 *
 * Cross-milestone advance does NOT auto-open the next milestone.
 * That gate is intentional: when a microtask is the last of its
 * milestone, we mark the milestone completed and stage a
 * `pendingHandover` payload that the workspace UI renders as a
 * "Continue to Stage N+1" card. The next milestone stays LOCKED
 * until the learner clicks Continue, at which point the API call
 * sets the next milestone to ACTIVE and its first microtask to
 * IN_PROGRESS.
 */

import type {
  PBLChatMessage,
  PBLProjectV2,
  PBLMilestone,
  PBLMicrotask,
  PBLInternalAssessment,
  PBLHandover,
} from '../types';
import { microtaskEngagement, recordEvent } from './engagement';
import { clearPendingTaskCompletion } from './task-completion';
import {
  appendRuntimeEvent,
  appendStatusChangedRuntimeEvent,
  milestoneIdForMicrotask,
  mintRuntimeEventId,
  normalizationRepairEventId,
  patchStatusChangedRuntimeEventId,
} from './runtime-events';

export const MILESTONE_DIVIDER_PREFIX = '[MILESTONE_DIVIDER]';
export const TASK_DIVIDER_PREFIX = '[TASK_DIVIDER]';

/** SCENARIO ONLY. Synthetic agent id for the Simulator's own chat
 *  thread. It is NOT a `roles[]` record — the cast lives as data on
 *  `project.scenario.characters`. A dedicated thread keeps the
 *  role-play conversation isolated from the Instructor's teaching
 *  history (so neither prompt pollutes the other). Absent on all
 *  ordinary projects. */
export const PBL_SIMULATOR_AGENT_ID = 'simulator';

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function currentMilestone(project: PBLProjectV2): PBLMilestone | undefined {
  return project.milestones.find((m) => m.status === 'active');
}

export function currentMicrotask(
  project: PBLProjectV2,
): { milestone: PBLMilestone; microtask: PBLMicrotask } | undefined {
  const ms = currentMilestone(project);
  if (!ms) return undefined;
  const mt = ms.microtasks.find((t) => t.status === 'todo' || t.status === 'in_progress');
  if (!mt) return undefined;
  return { milestone: ms, microtask: mt };
}

/**
 * Normalize runtime-only state that the UI and Instructor API both
 * require after a project is generated or reloaded. Planner tools
 * build the project structure, but the runtime contract is stricter:
 * there must be one Instructor thread, one active milestone, and one
 * current microtask. Keep this small and deterministic so normal
 * generation and local test generation share the same behavior.
 */
export function normalizeProjectRuntime(project: PBLProjectV2): boolean {
  let changed = false;

  // Run the scenario skeleton repair on EVERY load (not just at generation):
  // it deterministically fixes any milestone whose `scenarioStage` the planner
  // left missing/invalid — which otherwise makes a middle act render as the
  // Instructor (prep) thread instead of the live scene. Idempotent + a no-op
  // for ordinary (non-scenario) projects, so it is safe to call here.
  if (normalizeScenario(project)) changed = true;

  const instructor = project.roles.find((r) => r.type === 'instructor');
  if (instructor && !project.threads.some((t) => t.agentId === instructor.id)) {
    project.threads.push({ agentId: instructor.id, messages: [] });
    changed = true;
  }

  // SCENARIO ONLY. Role-play projects get an extra Simulator thread so
  // the in-character conversation is stored apart from the Instructor's
  // prep/wrapup teaching thread. Gated on `project.scenario`; ordinary
  // projects never grow this thread and their runtime is byte-identical.
  if (project.scenario && !project.threads.some((t) => t.agentId === PBL_SIMULATOR_AGENT_ID)) {
    project.threads.push({ agentId: PBL_SIMULATOR_AGENT_ID, messages: [] });
    changed = true;
  }

  if (project.pendingHandover && !project.pendingHandover.consumed) {
    if (changed) {
      project.updatedAt = new Date().toISOString();
    }
    return changed;
  }

  if (project.status !== 'completed' && project.milestones.length > 0) {
    let active = project.milestones.find((m) => m.status === 'active');
    if (!active) {
      active =
        project.milestones.find((m) => m.status !== 'completed') ??
        project.milestones[project.milestones.length - 1];
      if (active && active.status !== 'active') {
        const from = active.status;
        active.status = 'active';
        appendStatusChangedRuntimeEvent(project, {
          id: normalizationRepairEventId(project, 'milestone', active.id, from, active.status),
          entityType: 'milestone',
          entityId: active.id,
          from,
          to: active.status,
          milestoneId: active.id,
        });
        changed = true;
      }
    }

    const current = active?.microtasks.find(
      (t) => t.status === 'todo' || t.status === 'in_progress',
    );
    const taskToOpen =
      current ?? active?.microtasks.find((t) => t.status !== 'completed' && t.status !== 'skipped');
    if (taskToOpen && taskToOpen.status !== 'in_progress') {
      const from = taskToOpen.status;
      taskToOpen.status = 'in_progress';
      appendStatusChangedRuntimeEvent(project, {
        id: normalizationRepairEventId(
          project,
          'microtask',
          taskToOpen.id,
          from,
          taskToOpen.status,
        ),
        entityType: 'microtask',
        entityId: taskToOpen.id,
        from,
        to: taskToOpen.status,
        microtaskId: taskToOpen.id,
        milestoneId: active?.id,
      });
      changed = true;
    }
  }

  if (changed) {
    project.updatedAt = new Date().toISOString();
  }
  return changed;
}

/**
 * Whether the learner has actually entered the project at least once.
 * Drives the Hero's "Start project" vs "Continue project" button.
 *
 * NOTE: an `in_progress` microtask does NOT count — `normalizeProjectRuntime`
 * opens the first task on a brand-new project too. The reliable signals
 * are learner-produced or Instructor-delivered: a thread message (the
 * GREETING opener), a submission / evaluation / engagement event, a
 * terminal microtask, a completed milestone, a pending handover, or a
 * finished project.
 */
export function hasStartedProject(project: PBLProjectV2): boolean {
  if (project.uiPhase === 'completed' || project.status === 'completed') return true;
  if (project.submissions.length > 0) return true;
  if (project.evaluations.length > 0) return true;
  if (project.engagementEvents.length > 0) return true;
  if (project.pendingHandover) return true;
  if (project.threads.some((thread) => thread.messages.length > 0)) return true;
  return project.milestones.some(
    (milestone) =>
      milestone.status === 'completed' ||
      milestone.microtasks.some(
        (microtask) => microtask.status === 'completed' || microtask.status === 'skipped',
      ),
  );
}

/**
 * Wipe all learner PBL progress and return a fresh `hero`-phase project,
 * equivalent to one that was just generated and never played. The
 * project STRUCTURE (roles, milestone / microtask definitions, title,
 * language, …) is preserved; only the runtime learning state is reset.
 *
 * Proficiency state (`proficiency` / `proficiencyAssessment`) is NOT
 * touched: it belongs to the learner model, not PBL progress, and is
 * owned by a separate runtime layer (PBL content vs learner runtime are
 * being decoupled). Clearing it here would couple reset to profile /
 * proficiency re-initialization and regress an intermediate/advanced
 * learner back to the beginner tier on restart.
 *
 * Pure: returns a new project, does not mutate the input.
 */
export function resetProjectProgress(project: PBLProjectV2): PBLProjectV2 {
  const reset: PBLProjectV2 = {
    ...project,
    runtimeEvents: project.runtimeEvents ? [...project.runtimeEvents] : undefined,
    runtimeResetEpoch: (project.runtimeResetEpoch ?? 0) + 1,
    uiPhase: 'hero',
    status: 'active',
    submissions: [],
    evaluations: [],
    engagementEvents: [],
    pendingHandover: undefined,
    pendingTaskCompletion: undefined,
    threads: project.threads.map((thread) => ({ agentId: thread.agentId, messages: [] })),
    milestones: project.milestones.map((milestone, index) => ({
      ...milestone,
      status: index === 0 ? 'active' : 'locked',
      internalAssessment: undefined,
      microtasks: milestone.microtasks.map((microtask) => ({
        ...microtask,
        status: 'todo',
        internalAssessment: undefined,
        completionReason: undefined,
        engagement: undefined,
      })),
    })),
    updatedAt: new Date().toISOString(),
  };
  appendRuntimeEvent(reset, {
    id: mintRuntimeEventId(),
    kind: 'project_reset',
    actorType: 'user',
    ts: reset.updatedAt,
  });
  appendStatusChangedRuntimeEvent(reset, {
    actorType: 'user',
    entityType: 'ui_phase',
    entityId: 'project',
    from: project.uiPhase,
    to: reset.uiPhase,
  });
  appendStatusChangedRuntimeEvent(reset, {
    actorType: 'user',
    entityType: 'project',
    entityId: 'project',
    from: project.status,
    to: reset.status,
  });
  project.milestones.forEach((milestone, milestoneIndex) => {
    const resetMilestone = reset.milestones[milestoneIndex];
    if (!resetMilestone) return;
    appendStatusChangedRuntimeEvent(reset, {
      actorType: 'user',
      entityType: 'milestone',
      entityId: resetMilestone.id,
      from: milestone.status,
      to: resetMilestone.status,
      milestoneId: resetMilestone.id,
    });
    milestone.microtasks.forEach((microtask, microtaskIndex) => {
      const resetMicrotask = resetMilestone.microtasks[microtaskIndex];
      if (!resetMicrotask) return;
      appendStatusChangedRuntimeEvent(reset, {
        actorType: 'user',
        entityType: 'microtask',
        entityId: resetMicrotask.id,
        from: microtask.status,
        to: resetMicrotask.status,
        microtaskId: resetMicrotask.id,
        milestoneId: resetMilestone.id,
      });
    });
  });
  return reset;
}

export function findMicrotask(
  project: PBLProjectV2,
  microtaskId: string,
): { milestone: PBLMilestone; microtask: PBLMicrotask } | undefined {
  for (const ms of project.milestones) {
    const mt = ms.microtasks.find((t) => t.id === microtaskId);
    if (mt) return { milestone: ms, microtask: mt };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Scenario (role-play) normalization — SCENARIO ONLY safety net
// ---------------------------------------------------------------------------

function genScenarioCharId(): string {
  return 'char_' + Math.random().toString(16).slice(2, 8) + Math.random().toString(16).slice(2, 8);
}

/**
 * SCENARIO ONLY. Idempotent safety net that keeps the role-play
 * scenario data structurally coherent, degrading to a plain project
 * (never crashing) when persisted / legacy / hand-edited data is
 * incoherent. No-op for ordinary projects (no `scenario`, no `scene`).
 *
 * A scenario is *runnable* only when BOTH a cast (`project.scenario`
 * with ≥1 valid character) AND ≥1 roleplay stage (`milestone.scenarioStage === 'roleplay'`)
 * are present — the two must come as a pair. When that pairing is
 * broken we restore consistency so the single gate
 * "`project.scenario` present = scenario project" never lies:
 *
 *   - No cast (`scenario` absent) but `scene` flags exist
 *       → clear the orphan `scene` flags (a scene with no cast can't
 *         run); the milestones become ordinary Instructor milestones.
 *   - `scenario` present but every character is structurally broken
 *     (missing `name` / `persona`)
 *       → the cast is unusable → drop `scenario` + `schemaVersion` and
 *         clear `scene` flags → clean ordinary project.
 *   - `scenario` + valid cast but NO scene milestone to host it
 *       → drop `scenario` + `schemaVersion` (cast has nowhere to
 *         appear) → clean ordinary project.
 *   - Coherent scenario → assign any missing character ids and keep it.
 *
 * On the happy path (Planner generated a coherent scenario, enforced by
 * the completion gate + validation) this only assigns ids / is a no-op.
 * Degradation therefore essentially never fires for freshly generated
 * projects — it exists purely to make corrupt / legacy packages safe.
 *
 * Returns true if it mutated the project.
 */
export function normalizeScenario(project: PBLProjectV2): boolean {
  let changed = false;
  const stagedMilestones = project.milestones.filter((m) => m.scenarioStage !== undefined);

  // No cast → any `scenarioStage` marker is an orphan. Clear it so the
  // project is a clean ordinary project. (Also covers ordinary projects
  // with no stage markers at all: the loop simply does nothing.)
  if (!project.scenario) {
    for (const m of stagedMilestones) {
      delete m.scenarioStage;
      changed = true;
    }
    if (changed) project.updatedAt = new Date().toISOString();
    return changed;
  }

  const scenario = project.scenario;

  // Drop structurally-broken characters (need name + persona); assign
  // missing ids to the survivors.
  const validChars = (scenario.characters ?? []).filter(
    (c) =>
      !!c &&
      typeof c.name === 'string' &&
      c.name.trim().length > 0 &&
      typeof c.persona === 'string' &&
      c.persona.trim().length > 0,
  );
  if (validChars.length !== (scenario.characters?.length ?? 0)) {
    scenario.characters = validChars;
    changed = true;
  }
  for (const c of scenario.characters) {
    if (!c.id) {
      c.id = genScenarioCharId();
      changed = true;
    }
  }

  const degradeToPlainProject = () => {
    delete project.scenario;
    delete project.schemaVersion;
    for (const m of stagedMilestones) delete m.scenarioStage;
    changed = true;
  };

  // Cast unusable (no valid characters) → degrade.
  if (scenario.characters.length === 0) {
    degradeToPlainProject();
    if (changed) project.updatedAt = new Date().toISOString();
    return changed;
  }

  // SCENARIO SKELETON REPAIR (deterministic; runs on every load → fixes new
  // AND already-generated projects). The skeleton is FIXED: prep → roleplay(s)
  // → wrapup. The planner occasionally omits or mangles a MIDDLE milestone's
  // `scenarioStage`, leaving it undefined. At runtime an undefined-stage
  // milestone is treated as non-roleplay (Instructor thread), so entering it
  // mid-scene wrongly shows the prep briefing instead of the live scene (the
  // act-transition bug). Coerce any milestone with a missing/invalid stage by
  // position: first → prep, last → wrapup, everything in between → roleplay.
  const allMs = project.milestones;
  allMs.forEach((m, i) => {
    if (
      m.scenarioStage === 'prep' ||
      m.scenarioStage === 'roleplay' ||
      m.scenarioStage === 'wrapup'
    ) {
      return;
    }
    m.scenarioStage = i === 0 ? 'prep' : i === allMs.length - 1 ? 'wrapup' : 'roleplay';
    changed = true;
  });

  // Need at least one immersive roleplay stage to host the cast; otherwise
  // the cast has nowhere to appear → degrade (keeps the single gate
  // "`project.scenario` present = scenario project" honest). Read fresh after
  // the skeleton repair above.
  const hasRoleplay = allMs.some((m) => m.scenarioStage === 'roleplay');
  if (!hasRoleplay) {
    degradeToPlainProject();
    if (changed) project.updatedAt = new Date().toISOString();
    return changed;
  }

  // Coherent scenario. (Creating the Simulator thread + routing is wired
  // in the increment that introduces the Simulator; nothing to do here.)
  if (changed) project.updatedAt = new Date().toISOString();
  return changed;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/** Mark a microtask `in_progress` (idempotent). */
export function startMicrotask(project: PBLProjectV2, microtaskId: string): void {
  const found = findMicrotask(project, microtaskId);
  if (!found) return;
  const { milestone, microtask } = found;
  // Activate parent milestone if it was LOCKED — happens after a
  // milestone handover click.
  if (milestone.status === 'locked') {
    const from = milestone.status;
    milestone.status = 'active';
    appendStatusChangedRuntimeEvent(project, {
      entityType: 'milestone',
      entityId: milestone.id,
      from,
      to: milestone.status,
      milestoneId: milestone.id,
    });
  }
  if (microtask.status === 'todo') {
    const from = microtask.status;
    microtask.status = 'in_progress';
    appendStatusChangedRuntimeEvent(project, {
      entityType: 'microtask',
      entityId: microtask.id,
      from,
      to: microtask.status,
      microtaskId,
      milestoneId: milestone.id,
    });
    recordEvent(project, 'microtask_opened', {
      microtaskId,
      milestoneId: milestone.id,
    });
  }
  project.updatedAt = new Date().toISOString();
}

/** Advance the current microtask to `completed`. If this was the
 *  last microtask of the milestone, complete the milestone too and
 *  stage a `pendingHandover` for the workspace UI. */
export function advanceMicrotask(
  project: PBLProjectV2,
  microtaskId: string,
  reason: string,
  assessment: PBLInternalAssessment,
):
  | {
      ok: true;
      milestoneCompleted: boolean;
      projectCompleted: boolean;
      nextMicrotaskId?: string;
    }
  | {
      ok: false;
      error: string;
    } {
  const found = findMicrotask(project, microtaskId);
  if (!found) return { ok: false, error: 'microtask_not_found' };
  const { milestone, microtask } = found;

  if (microtask.status === 'completed' || microtask.status === 'skipped') {
    return { ok: false, error: 'already_terminal' };
  }

  clearPendingTaskCompletion(project, microtaskId);

  const microtaskStatusFrom = microtask.status;
  microtask.status = 'completed';
  appendStatusChangedRuntimeEvent(project, {
    id: patchStatusChangedRuntimeEventId(
      project,
      'microtask',
      microtask.id,
      microtaskStatusFrom,
      microtask.status,
    ),
    entityType: 'microtask',
    entityId: microtask.id,
    from: microtaskStatusFrom,
    to: microtask.status,
    microtaskId,
    milestoneId: milestone.id,
  });
  microtask.completionReason = reason;
  microtask.internalAssessment = assessment;

  recordEvent(project, 'microtask_completed', {
    microtaskId,
    milestoneId: milestone.id,
    payload: { reason },
  });

  // Freeze the engagement summary onto the microtask itself once it's
  // done. The engagement events ledger is a ring buffer (500-entry cap
  // in engagement.ts) and a long project can roll its early task
  // events off the back. By caching the summary at completion time we
  // guarantee the milestone evaluator still has telemetry to feed the
  // LLM, even when the underlying ledger has overflowed. This is the
  // PR 6 evaluator's lifeline — without it, long projects evaluate
  // against partial data and the LLM falls back to generic praise.
  // We call microtaskEngagement AFTER recording the completion event
  // so the snapshot includes a populated `completedAt` (used to
  // derive `durationSeconds`).
  microtask.engagement = microtaskEngagement(project, microtaskId);

  // Find next not-yet-terminal microtask in the same milestone.
  const next = milestone.microtasks.find((t) => t.status === 'todo' || t.status === 'in_progress');
  if (next) {
    const nextStatusFrom = next.status;
    next.status = 'in_progress';
    appendStatusChangedRuntimeEvent(project, {
      id: patchStatusChangedRuntimeEventId(
        project,
        'microtask',
        next.id,
        nextStatusFrom,
        next.status,
      ),
      entityType: 'microtask',
      entityId: next.id,
      from: nextStatusFrom,
      to: next.status,
      microtaskId: next.id,
      milestoneId: milestone.id,
    });
    recordEvent(project, 'microtask_opened', {
      microtaskId: next.id,
      milestoneId: milestone.id,
    });
    project.updatedAt = new Date().toISOString();
    return {
      ok: true,
      milestoneCompleted: false,
      projectCompleted: false,
      nextMicrotaskId: next.id,
    };
  }

  // No next microtask in this milestone — complete the milestone.
  const milestoneStatusFrom = milestone.status;
  milestone.status = 'completed';
  appendStatusChangedRuntimeEvent(project, {
    id: patchStatusChangedRuntimeEventId(
      project,
      'milestone',
      milestone.id,
      milestoneStatusFrom,
      milestone.status,
    ),
    entityType: 'milestone',
    entityId: milestone.id,
    from: milestoneStatusFrom,
    to: milestone.status,
    milestoneId: milestone.id,
    microtaskId,
  });
  milestone.internalAssessment = assessment;

  // Look for the next milestone in order.
  const nextMs = project.milestones
    .filter((m) => m.status === 'locked')
    .sort((a, b) => a.order - b.order)[0];

  if (nextMs) {
    const firstTodo = nextMs.microtasks.find((t) => t.status === 'todo');
    const handover: PBLHandover = {
      completedMilestoneId: milestone.id,
      completedMilestoneTitle: milestone.title,
      nextMilestoneId: nextMs.id,
      nextMilestoneTitle: nextMs.title,
      nextTaskId: firstTodo?.id,
      nextTaskTitle: firstTodo?.title,
      consumed: false,
    };
    project.pendingHandover = handover;
    appendRuntimeEvent(project, {
      id: mintRuntimeEventId(),
      kind: 'handover_staged',
      actorType: 'system',
      completedMilestoneId: handover.completedMilestoneId,
      nextMilestoneId: handover.nextMilestoneId,
      nextMicrotaskId: handover.nextTaskId,
      ts: new Date().toISOString(),
      milestoneId: milestone.id,
      microtaskId,
    });
    project.updatedAt = new Date().toISOString();
    return { ok: true, milestoneCompleted: true, projectCompleted: false };
  }

  // No next milestone — project is complete. Keep the UI in the
  // workspace so the chained milestone/final evaluators can render
  // their cards in chat. The learner enters the completion report
  // explicitly via the final-evaluation CTA.
  const projectStatusFrom = project.status;
  project.status = 'completed';
  appendStatusChangedRuntimeEvent(project, {
    id: patchStatusChangedRuntimeEventId(
      project,
      'project',
      'project',
      projectStatusFrom,
      project.status,
    ),
    entityType: 'project',
    entityId: 'project',
    from: projectStatusFrom,
    to: project.status,
    milestoneId: milestone.id,
    microtaskId,
  });
  project.updatedAt = new Date().toISOString();
  return { ok: true, milestoneCompleted: true, projectCompleted: true };
}

/** SCENARIO ONLY. Complete an ENTIRE roleplay act (milestone) in one
 *  deterministic step, when the learner clicks "finish this act".
 *
 *  The act model treats a roleplay milestone as ONE continuous scene whose
 *  beats are background checkpoints, NOT sequentially-advanced units — so the
 *  learner is never auto-advanced mid-scene. Progression is fully
 *  deterministic and user-driven: this marks every not-yet-terminal beat of
 *  the active roleplay milestone `completed`, then seals the milestone and
 *  stages the handover (reusing the exact same path `advanceMicrotask` uses
 *  for a milestone's last beat — so the existing "next stage" button picks it
 *  up unchanged). No LLM, no per-beat judgement: which checkpoints were
 *  actually met is judged later by the final evaluator for SCORING only, never
 *  for progression. Caller must have verified the active milestone is a
 *  roleplay stage; returns the same shape as `advanceMicrotask`. */
export function completeRoleplayAct(
  project: PBLProjectV2,
  reason: string,
):
  | { ok: true; milestoneCompleted: boolean; projectCompleted: boolean }
  | { ok: false; error: string } {
  const milestone = currentMilestone(project);
  if (!milestone || milestone.scenarioStage !== 'roleplay') {
    return { ok: false, error: 'not_in_roleplay_act' };
  }
  const open = milestone.microtasks.filter(
    (t) => t.status === 'todo' || t.status === 'in_progress',
  );
  if (open.length === 0) return { ok: false, error: 'already_terminal' };

  // Server-side engagement gate: the learner must have actually played THIS act
  // (≥1 learner message tagged to one of its beats) before it can be finished.
  // The simulator thread is shared across all roleplay acts, so we scope by the
  // act's beat ids — otherwise a later act could be completed without playing
  // it (earlier acts' messages would satisfy a thread-wide check). This mirrors
  // the sidebar's per-act button gate; it is the authoritative server check.
  const beatIds = new Set(milestone.microtasks.map((b) => b.id));
  const simThread = project.threads.find((t) => t.agentId === PBL_SIMULATOR_AGENT_ID);
  const engagedThisAct = (simThread?.messages ?? []).some(
    (m) => m.roleType === 'user' && !!m.microtaskId && beatIds.has(m.microtaskId),
  );
  if (!engagedThisAct) return { ok: false, error: 'act_not_engaged' };

  // Complete every remaining beat deterministically (checkpoints, not gates).
  // Freeze each beat's engagement snapshot exactly like advanceMicrotask, so
  // the scenario final evaluator still has per-beat telemetry to score against.
  for (const beat of open) {
    const from = beat.status;
    beat.status = 'completed';
    appendStatusChangedRuntimeEvent(project, {
      entityType: 'microtask',
      entityId: beat.id,
      from,
      to: beat.status,
      microtaskId: beat.id,
      milestoneId: milestone.id,
    });
    beat.completionReason = reason;
    recordEvent(project, 'microtask_completed', {
      microtaskId: beat.id,
      milestoneId: milestone.id,
      payload: { reason },
    });
    beat.engagement = microtaskEngagement(project, beat.id);
  }

  // Seal the milestone, then advance to the next stage in ONE step. The act
  // model treats a roleplay milestone as a self-contained scene, so finishing
  // it should go straight to the next stage — no separate "continue" click.
  // We stage the handover and immediately consume it (activating the next
  // milestone's first task), exactly as if the learner had clicked Continue.
  const milestoneStatusFrom = milestone.status;
  milestone.status = 'completed';
  appendStatusChangedRuntimeEvent(project, {
    entityType: 'milestone',
    entityId: milestone.id,
    from: milestoneStatusFrom,
    to: milestone.status,
    milestoneId: milestone.id,
  });
  const nextMs = project.milestones
    .filter((m) => m.status === 'locked')
    .sort((a, b) => a.order - b.order)[0];
  if (nextMs) {
    const firstTodo = nextMs.microtasks.find((t) => t.status === 'todo');
    project.pendingHandover = {
      completedMilestoneId: milestone.id,
      completedMilestoneTitle: milestone.title,
      nextMilestoneId: nextMs.id,
      nextMilestoneTitle: nextMs.title,
      nextTaskId: firstTodo?.id,
      nextTaskTitle: firstTodo?.title,
      consumed: false,
    };
    appendRuntimeEvent(project, {
      id: mintRuntimeEventId(),
      kind: 'handover_staged',
      actorType: 'system',
      completedMilestoneId: milestone.id,
      nextMilestoneId: nextMs.id,
      nextMicrotaskId: firstTodo?.id,
      ts: new Date().toISOString(),
      milestoneId: milestone.id,
    });
    // One-step: consume the handover now so no "next stage" button is needed.
    continueAfterHandover(project);
    project.updatedAt = new Date().toISOString();
    return { ok: true, milestoneCompleted: true, projectCompleted: false };
  }
  // No next milestone (shouldn't happen — a coherent scenario ends in wrapup).
  const projectStatusFrom = project.status;
  project.status = 'completed';
  appendStatusChangedRuntimeEvent(project, {
    entityType: 'project',
    entityId: 'project',
    from: projectStatusFrom,
    to: project.status,
    milestoneId: milestone.id,
  });
  project.updatedAt = new Date().toISOString();
  return { ok: true, milestoneCompleted: true, projectCompleted: true };
}

/** Open the next milestone after the learner clicks Continue. */
export function continueAfterHandover(project: PBLProjectV2): {
  ok: boolean;
  activatedMicrotaskId?: string;
} {
  const h = project.pendingHandover;
  if (!h || h.consumed) return { ok: false };
  const nextMs = project.milestones.find((m) => m.id === h.nextMilestoneId);
  if (!nextMs) return { ok: false };
  const nextMilestoneStatusFrom = nextMs.status;
  nextMs.status = 'active';
  appendStatusChangedRuntimeEvent(project, {
    entityType: 'milestone',
    entityId: nextMs.id,
    from: nextMilestoneStatusFrom,
    to: nextMs.status,
    milestoneId: nextMs.id,
  });
  const first =
    (h.nextTaskId && nextMs.microtasks.find((t) => t.id === h.nextTaskId)) ||
    nextMs.microtasks.find((t) => t.status === 'todo');
  if (first) {
    const firstStatusFrom = first.status;
    first.status = 'in_progress';
    appendStatusChangedRuntimeEvent(project, {
      entityType: 'microtask',
      entityId: first.id,
      from: firstStatusFrom,
      to: first.status,
      microtaskId: first.id,
      milestoneId: nextMs.id,
    });
    recordEvent(project, 'microtask_opened', {
      microtaskId: first.id,
      milestoneId: nextMs.id,
    });
  }
  project.pendingHandover = { ...h, consumed: true };
  appendRuntimeEvent(project, {
    id: mintRuntimeEventId(),
    kind: 'handover_consumed',
    actorType: 'system',
    completedMilestoneId: h.completedMilestoneId,
    nextMilestoneId: h.nextMilestoneId,
    activatedMicrotaskId: first?.id,
    ts: new Date().toISOString(),
    milestoneId: nextMs.id,
    microtaskId: first?.id,
  });
  appendMilestoneDividerMessage(project, h, first?.id);
  project.updatedAt = new Date().toISOString();
  return { ok: true, activatedMicrotaskId: first?.id };
}

export function appendTaskDividerMessage(
  project: PBLProjectV2,
  args: {
    completedMicrotaskId: string;
    nextMicrotaskId?: string;
    completedTitle?: string;
    nextTitle?: string;
  },
): void {
  if (!args.nextMicrotaskId) return;
  const instructor = project.roles.find((r) => r.type === 'instructor');
  if (!instructor) return;
  const thread = project.threads.find((t) => t.agentId === instructor.id);
  if (!thread) return;

  const labels = taskDividerLabels(project.language);
  const left = args.completedTitle
    ? `${labels.completedPrefix}${args.completedTitle}`
    : labels.completedFallback;
  const right = args.nextTitle ? `${labels.nextPrefix}${args.nextTitle}` : labels.nextFallback;
  const content = `${TASK_DIVIDER_PREFIX}${left} ｜ ${right}`;
  if (thread.messages.some((m) => m.content === content)) return;

  const message: PBLChatMessage = {
    id: 'msg_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6),
    agentId: instructor.id,
    roleType: 'instructor',
    content,
    ts: new Date().toISOString(),
    microtaskId: args.nextMicrotaskId,
  };
  thread.messages.push(message);
  appendRuntimeEvent(project, {
    id: mintRuntimeEventId(),
    kind: 'message_created',
    actorType: 'agent',
    actorRoleId: instructor.id,
    messageId: message.id,
    threadId: thread.agentId,
    ts: message.ts,
    microtaskId: message.microtaskId,
    milestoneId: milestoneIdForMicrotask(project, message.microtaskId),
  });
}

function taskDividerLabels(language: string | undefined): {
  completedPrefix: string;
  completedFallback: string;
  nextPrefix: string;
  nextFallback: string;
} {
  switch (language) {
    case 'zh-CN':
      return {
        completedPrefix: '任务完成：',
        completedFallback: '当前任务已完成',
        nextPrefix: '开始下一任务：',
        nextFallback: '开始下一任务',
      };
    case 'zh-TW':
      return {
        completedPrefix: '任務完成：',
        completedFallback: '目前任務已完成',
        nextPrefix: '開始下一任務：',
        nextFallback: '開始下一任務',
      };
    case 'ja-JP':
      return {
        completedPrefix: 'タスク完了: ',
        completedFallback: '現在のタスクが完了しました',
        nextPrefix: '次のタスクへ: ',
        nextFallback: '次のタスクへ',
      };
    case 'ru-RU':
      return {
        completedPrefix: 'Задача завершена: ',
        completedFallback: 'Текущая задача завершена',
        nextPrefix: 'Следующая задача: ',
        nextFallback: 'Следующая задача',
      };
    case 'ar-SA':
      return {
        completedPrefix: 'اكتملت المهمة: ',
        completedFallback: 'اكتملت المهمة الحالية',
        nextPrefix: 'بدء المهمة التالية: ',
        nextFallback: 'بدء المهمة التالية',
      };
    default:
      return {
        completedPrefix: 'Task complete: ',
        completedFallback: 'Current task complete',
        nextPrefix: 'Next task: ',
        nextFallback: 'Next task',
      };
  }
}

function appendMilestoneDividerMessage(
  project: PBLProjectV2,
  handover: PBLHandover,
  microtaskId: string | undefined,
): void {
  // SCENARIO ONLY: never add an in-chat stage-advance divider for a role-play
  // project. The three acts (prep → roleplay → wrapup) are already made legible
  // by the left roadmap's stage labels and, on entering wrapup, by the
  // collapsible "role-play history" block embedded in the Instructor feed — so
  // a "[stage advance]" divider in the conversation is redundant noise (it used
  // to appear when crossing into wrapup). Ordinary projects keep their
  // Instructor-thread milestone divider exactly as before.
  if (project.scenario) return;

  const content = `${MILESTONE_DIVIDER_PREFIX}${milestoneDividerLabel(project.language, handover)}`;
  const instructor = project.roles.find((r) => r.type === 'instructor');
  if (!instructor) return;
  const thread = project.threads.find((t) => t.agentId === instructor.id);
  if (!thread) return;
  if (thread.messages.some((m) => m.content === content)) return;
  const message: PBLChatMessage = {
    id: 'msg_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 6),
    agentId: instructor.id,
    roleType: 'instructor',
    content,
    ts: new Date().toISOString(),
    microtaskId,
  };
  thread.messages.push(message);
  appendRuntimeEvent(project, {
    id: mintRuntimeEventId(),
    kind: 'message_created',
    actorType: 'agent',
    actorRoleId: instructor.id,
    messageId: message.id,
    threadId: thread.agentId,
    ts: message.ts,
    microtaskId: message.microtaskId,
    milestoneId: milestoneIdForMicrotask(project, message.microtaskId),
  });
}

function milestoneDividerLabel(language: string | undefined, handover: PBLHandover): string {
  const transition = `${handover.completedMilestoneTitle} → ${handover.nextMilestoneTitle}`;
  switch (language) {
    case 'zh-CN':
      return `阶段推进：${transition}`;
    case 'zh-TW':
      return `階段推進：${transition}`;
    case 'ja-JP':
      return `ステージ進行: ${transition}`;
    case 'ru-RU':
      return `Продвижение этапа: ${transition}`;
    case 'ar-SA':
      return `تقدم المرحلة: ${transition}`;
    default:
      return `Stage progression: ${transition}`;
  }
}
