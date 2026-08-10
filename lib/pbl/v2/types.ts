/**
 * PBL v2 — contract design types plus the app runtime overlay.
 *
 * The persisted design/skeleton belongs to `@openmaic/dsl`. This barrel keeps
 * the established app-facing names while adding learner/runtime state to the
 * nested contract shapes that carry it.
 */
import type {
  PBLMicrotask as ContractPBLMicrotask,
  PBLMilestone as ContractPBLMilestone,
  PBLProject as ContractPBLProject,
  PBLProficiency,
  PBLRoleType,
  PBLThreadSeat as ContractPBLThreadSeat,
} from '@openmaic/dsl';
import type { SceneOutline } from '@/lib/types/generation';

export type {
  PBLProject,
  PBLRole,
  PBLDocument,
  PBLScenarioConfig,
  PBLScenarioCharacter,
  PBLSceneVisual,
  PBLThreadSeat,
  PBLProjectStatus,
  PBLMilestoneStatus,
  PBLMicrotaskStatus,
  PBLRoleType,
  PBLProficiency,
  PBLAssignee,
  PBLUiPhase,
} from '@openmaic/dsl';

export type PBLSubmissionKind = 'text' | 'file' | 'link';

export type PBLEvaluationKind = 'task' | 'milestone' | 'final';

/** Closing-check answer quality. Recorded by Instructor via the
 *  `record_closing_check` tool before `advance_micro_task` is allowed. */
export type PBLClosingQuality = 'weak' | 'ok' | 'strong';

type RuntimeOverlay<Base, Overlay> = Omit<Base, keyof Overlay> & Overlay;

/** Set by Instructor when advancing a task via `advance_micro_task`.
 *  Never shown to the learner — internal teaching record. */
export interface PBLInternalAssessment {
  problems?: string;
  resolution?: string;
  performance?: string;
}

/** Rolled-up engagement summary cached on the microtask at completion
 *  time. The append-only `PBLEngagementEvent[]` ledger is the source
 *  of truth; this is a convenience cache so the frontend and evaluator
 *  can read engagement without replaying events. */
export interface PBLEngagementSummary {
  startedAt?: string;
  completedAt?: string;
  durationSeconds?: number;
  learnerTurnCount?: number;
  errorCount?: number;
  /** De-duplicated by signature to count "stuck on the same error". */
  repeatErrorCount?: number;
  errorSignatures?: string[];
  conceptsUnlocked?: string[];
  /** signature → human-readable concept name (in the learner's content
   *  language) captured from `record_observation`. Cached here so the
   *  end-of-project report can show readable, localised concept names even
   *  after the raw event ledger rolls over. Missing for older projects /
   *  observations recorded without a label. */
  conceptUnlockLabels?: Record<string, string>;
  struggles?: string[];
  questionsRaised?: number;
  closingQuestion?: string;
  closingAnswer?: string;
  closingQuality?: PBLClosingQuality;
}

/** Contract microtask plus learner-owned runtime state. */
export type PBLMicrotask = RuntimeOverlay<
  ContractPBLMicrotask,
  {
    /** Internal teaching record from `advance_micro_task`. */
    internalAssessment?: PBLInternalAssessment;
    completionReason?: string;
    /** Engagement summary cached on completion. */
    engagement?: PBLEngagementSummary;
  }
>;

/** Contract milestone with runtime-aware microtasks and assessment state. */
export type PBLMilestone = RuntimeOverlay<
  ContractPBLMilestone,
  {
    microtasks: PBLMicrotask[];
    /** Same idea as `PBLMicrotask.internalAssessment` — Instructor sets
     *  this when auto-completing the milestone via `advance_micro_task`
     *  on the last task. */
    internalAssessment?: PBLInternalAssessment;
  }
>;

/** A piece of learner-produced work attached to a microtask. */
export interface PBLSubmission {
  id: string;
  microtaskId: string;
  milestoneId?: string;
  kind: PBLSubmissionKind;
  content: string;
  filename?: string;
  mimeType?: string;
  /** Object-storage (or base64 data) URL of the original uploaded file,
   *  for non-text uploads (PDF / image). `content` still carries the
   *  evaluator-facing text (e.g. a PDF's parsed text); `fileUrl` is for
   *  display / download of the original and, for images, for feeding the
   *  picture to a vision-capable evaluator. Absent for plain text/paste. */
  fileUrl?: string;
  /** Optional LLM-generated summary, used to keep evaluator prompts
   *  small when the raw content is long. */
  summary?: string;
  /** ISO timestamp. */
  createdAt: string;
}

/** SCENARIO FINAL ONLY. How the learner covered ONE roleplay act's authored
 *  goals, judged by the final evaluator from the transcript. Beats are hidden
 *  checkpoints (`successWhen`) the learner never saw during play; here they are
 *  surfaced read-only on the completion report as "what this act was about".
 *
 *  IMPORTANT: this is a SCENARIO concept. Normal projects never produce it
 *  (their final evaluator prompt has no `act_goals` output), so
 *  `PBLEvaluation.actGoals` stays undefined for them. */
export interface PBLScenarioActGoals {
  /** The roleplay milestone (act) these goals belong to. */
  milestoneId: string;
  /** The act's title, surfaced on the completion report. */
  actTitle: string;
  goals: {
    /** The authored `successWhen` text — what this beat asked the learner to
     *  do, shown read-only ("this act's goal"). NOT the internal tag. */
    goal: string;
    /** The single skill this beat practised (from the beat's `skillFocus`),
     *  surfaced as a small label next to the goal. Undefined = none authored. */
    skillFocus?: string;
    /** The final evaluator's judgement of whether the learner covered this
     *  goal, read from the transcript. Three-state by design. */
    status: 'achieved' | 'partial' | 'missed';
    /** Optional one-line, transcript-grounded note from the evaluator. */
    note?: string;
  }[];
}

/** Instructor's structured feedback on a task / milestone / final
 *  project. */
export interface PBLEvaluation {
  id: string;
  kind: PBLEvaluationKind;
  microtaskId?: string;
  milestoneId?: string;
  feedback: string;
  strengths: string[];
  improvements: string[];
  /** Optional 0-100 numeric score (mostly used for task evals). */
  score?: number;
  /** 0–5 in 0.5 increments. Emitted on milestone AND final evaluations
   *  (rendered as half-star icons). Float so half stars round-trip
   *  cleanly. */
  stars?: number;
  /** Final-evaluation-only structured fields. Empty / undefined on
   *  task and milestone evals — the frontend keys off
   *  `kind === 'final'` before rendering them. */
  whatYouBuilt?: string[];
  whatYouLearned?: string[];
  whatsNext?: string;
  /** SCENARIO FINAL-evaluation-only. Per-act goal coverage (the hidden
   *  `successWhen` checkpoints, judged from the transcript) surfaced on the
   *  scenario completion report. Undefined on normal projects and on
   *  task/milestone evals — the scenario completion page keys off its presence
   *  and gracefully omits the act-review section when the model didn't emit it. */
  actGoals?: PBLScenarioActGoals[];
  /** ISO timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Analytics (append-only event ledger + cache)
// ---------------------------------------------------------------------------

/** Append-only engagement event kinds. */
export type PBLEngagementEventKind =
  | 'microtask_opened'
  | 'learner_turn'
  | 'observation_error'
  | 'observation_concept_unlocked'
  | 'observation_struggle'
  | 'observation_question'
  | 'closing_check'
  /** Milestone-scope integrative reverse-question recorded at the end
   *  of a `synthesisCheck` stage. Carried on both the milestone and
   *  the last microtask so it satisfies the per-microtask evidence
   *  gate (absorption) AND the milestone seal gate. Payload mirrors
   *  `closing_check`: `{ question, learner_answer, quality, coreConcept }`. */
  | 'stage_synthesis_check'
  | 'microtask_completed'
  | 'microtask_skipped'
  /** Emitted when the adaptive proficiency engine crosses a tier
   *  bucket. Payload: `{ from, to, reason, score, confidence }`.
   *  Not surfaced in the chat UI by design — proficiency is an
   *  internal-only concept the learner never sees. */
  | 'proficiency_changed';

/** One entry in the append-only engagement ledger. We keep a bounded
 *  ring buffer at the `PBLProjectV2` level (see analytics module) to
 *  avoid scene.content blowing up over long sessions. */
export interface PBLEngagementEvent {
  id: string;
  kind: PBLEngagementEventKind;
  microtaskId?: string;
  milestoneId?: string;
  /** ISO timestamp. */
  ts: string;
  /** Free-form payload — kind-specific extra data (e.g. char counts,
   *  error signatures, closing-question text). */
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runtime event ledger
// ---------------------------------------------------------------------------

/** Actors that can emit runtime events. `agent` points to a role record via
 *  `actorRoleId`; `user` is the implicit learner; `system` is deterministic
 *  product/runtime code. */
export type PBLRuntimeActorType = 'user' | 'agent' | 'system';

export interface PBLRuntimeEventBase {
  id: string;
  ts: string;
  actorType: PBLRuntimeActorType;
  actorRoleId?: string;
  microtaskId?: string;
  milestoneId?: string;
}

/** Tool calls are facts about what an actor did, not roles. The current
 *  product does not execute arbitrary agent tools yet; these event variants
 *  reserve a stable JSON shape so future tool execution does not get encoded
 *  as chat text or ad-hoc message fields. */
/** Fold baseline contract: folds initialize project status `active` and
 *  uiPhase `hero` from design-time defaults. Generation-time packaging
 *  deliberately emits no runtime events. */
export type PBLRuntimeEvent =
  | (PBLRuntimeEventBase & {
      kind: 'message_created';
      messageId: string;
      threadId: string;
    })
  | (PBLRuntimeEventBase & {
      kind: 'tool_call_started';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    })
  | (PBLRuntimeEventBase & {
      kind: 'tool_call_succeeded';
      toolCallId: string;
      result: Record<string, unknown>;
    })
  | (PBLRuntimeEventBase & {
      kind: 'tool_call_failed';
      toolCallId: string;
      error: string;
    })
  | (PBLRuntimeEventBase & {
      kind: 'submission_created';
      submissionId: string;
    })
  | (PBLRuntimeEventBase & {
      kind: 'evaluation_created';
      evaluationId: string;
    })
  | (PBLRuntimeEventBase & {
      kind: 'status_changed';
      entityType: 'project' | 'milestone' | 'microtask' | 'ui_phase';
      entityId: string;
      from: string;
      to: string;
    })
  /** Epoch marker emitted before reset status events. Folds MUST treat it as
   *  an epoch boundary: accumulated learner state from events before it is
   *  cleared. */
  | (PBLRuntimeEventBase & {
      kind: 'project_reset';
    })
  | (PBLRuntimeEventBase & {
      kind: 'handover_staged';
      completedMilestoneId: string;
      nextMilestoneId: string;
      nextMicrotaskId?: string;
    })
  | (PBLRuntimeEventBase & {
      kind: 'handover_consumed';
      completedMilestoneId: string;
      nextMilestoneId: string;
      activatedMicrotaskId?: string;
    })
  | (PBLRuntimeEventBase & {
      kind: 'task_completion_staged';
      reason: string;
    })
  | (PBLRuntimeEventBase & {
      kind: 'task_completion_cleared';
    })
  | (PBLRuntimeEventBase & {
      kind: 'proficiency_updated';
      tier: PBLProficiency;
      score: number;
      confidence: number;
    });

// ---------------------------------------------------------------------------
// Adaptive proficiency engine
// ---------------------------------------------------------------------------

/** What sort of signal drove a proficiency score update.
 *
 *  Static (pre-PBL) kinds derive from outline / scene / quiz / bio
 *  content; dynamic (in-PBL) kinds derive from learner behaviour
 *  during the project. The engine treats them uniformly — each is
 *  reduced to a `direction` + `weight` and folded into the EWMA
 *  score by `applySignal`.
 *
 *  Kept as a string literal union (not enum) so it round-trips
 *  through JSON without runtime cost. */
export type ProficiencySignalKind =
  // Pre-PBL (static)
  | 'outline_keyword'
  | 'prior_scene_difficulty'
  | 'user_bio'
  | 'user_level_explicit'
  | 'quiz_accuracy'
  // In-PBL (dynamic)
  | 'submission_score'
  | 'task_speed'
  | 'help_request'
  | 'concept_confusion'
  | 'self_correction'
  | 'force_advance'
  | 'closing_check_quality';

/** A single piece of evidence the engine has folded into the score.
 *
 *  - `direction` is on `[-1, +1]` — `-1` = strong beginner signal,
 *    `+1` = strong advanced signal.
 *  - `weight` is on `[0, 1]` — how much this signal is allowed to
 *    move the EWMA score. Static signals cap at ~0.5; the only
 *    high-weight pre-PBL signal is `quiz_accuracy` (cap 0.6).
 *  - `note` is free-form, used by tests and the dev badge. */
export interface ProficiencySignal {
  kind: ProficiencySignalKind;
  direction: number;
  weight: number;
  note?: string;
  /** ISO timestamp. */
  ts: string;
}

/** Where the most recent assessment update came from.
 *
 *  - `planner`  — computed at scene-generation time from outline +
 *                 prior-scene difficulty + bio. No quiz signal
 *                 (quizzes have not happened yet).
 *  - `pre-play` — recomputed at Hero entry, after folding in
 *                 `priorQuizResults` snapshot from `localStorage`.
 *  - `dynamic`  — updated by Instructor turns folding in
 *                 observation / closing-check / force-advance /
 *                 task-speed signals. */
export type ProficiencyAssessmentSource = 'planner' | 'pre-play' | 'dynamic' | 'self-report';

/** Tier-transition record kept for debugging + the future
 *  evaluator (so the final report can say "started at intermediate,
 *  finished at advanced"). Never shown in the chat. */
export interface ProficiencyTransition {
  from: PBLProficiency;
  to: PBLProficiency;
  /** ISO timestamp. */
  ts: string;
  /** Short machine-readable reason: `'crossed bucket boundary'`,
   *  `'pre-play quiz recalibration'`, etc. */
  reason: string;
}

/** Full proficiency state, attached to `PBLProjectV2`.
 *
 *  The simple `proficiency: PBLProficiency` field on the project
 *  is kept in sync with `assessment.tier` so legacy consumers
 *  (planner prompt, tier-guidance block) keep working. The richer
 *  state lives here. */
export interface PBLProficiencyAssessment {
  /** Current bucket — derives Instructor guidance block. */
  tier: PBLProficiency;
  /** Internal continuous score on `[-1, +1]`.
   *    `score < -0.33` → bucket `beginner`
   *    `-0.33 ≤ score ≤ +0.33` → bucket `intermediate`
   *    `score > +0.33` → bucket `advanced`
   *  Hysteresis: once a tier is entered, the score must move past
   *  the *opposite* boundary (±0.20) to leave. See
   *  `scoreToTier(score, currentTier)` in operations/kernel/proficiency. */
  score: number;
  /** `[0, 1]`. Accumulates as more signals arrive. Gates tier
   *  switches: cannot cross a boundary while confidence < 0.4. */
  confidence: number;
  source: ProficiencyAssessmentSource;
  /** Append-only signal history, bounded to the most recent 50. */
  signals: ProficiencySignal[];
  /** ISO timestamp. */
  lastUpdatedAt: string;
  /** Tier-change history. Empty until the first switch. */
  transitions: ProficiencyTransition[];
  /** Number of dynamic signals consumed since the last tier switch.
   *  Used by `shouldRetier` to enforce a minimum-signal gate so
   *  one anomalous observation can't flip a tier on its own. */
  dynamicSignalsSinceRetier: number;
  /** Number of learner turns consumed since the last tier switch.
   *  Used by `shouldRetier` to enforce a cooldown so the tier
   *  can't oscillate every other message. */
  turnsSinceRetier: number;
}

/** Snapshot of a single prior quiz scene the learner attempted.
 *  Aggregated by `lib/pbl/v2/operations/runtime/quiz-snapshot.ts` from
 *  `lib/quiz/persistence.ts` localStorage and piggybacked on the
 *  `/api/pbl/v2/open-task` request when the learner first enters
 *  the Hero. */
export interface PriorQuizResult {
  sceneId: string;
  sceneTitle: string;
  totalQuestions: number;
  correctCount: number;
  incorrectCount: number;
  /** Short-answer questions without `hasAnswer` cannot be auto-graded
   *  and are excluded from the accuracy ratio. */
  unscoredCount: number;
  /** `correctCount / (correctCount + incorrectCount)`, or null when
   *  no submitted result was auto-gradable. */
  accuracy: number | null;
}

// ---------------------------------------------------------------------------
// Multi-agent chat
// ---------------------------------------------------------------------------

/** One turn in an agent chat. */
export interface PBLChatMessage {
  id: string;
  /** Which agent emitted this. Undefined for learner messages. */
  agentId?: string;
  /** Quick role-type tag so the renderer can pick avatar/colour
   *  without looking up the role record. */
  roleType: PBLRoleType;
  content: string;
  /** ISO timestamp. */
  ts: string;
  /** When the message was emitted while a specific microtask was
   *  active. Used by the renderer to anchor messages visually. */
  microtaskId?: string;
  /** Surfaced tool calls (for a future "transparency" UI). Optional. */
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result?: Record<string, unknown>;
  }>;
  /** SCENARIO ONLY. For `roleType === 'simulator'` messages: which
   *  character (in `project.scenario.characters`) spoke, so the renderer
   *  can show that character's name/avatar. Undefined on all normal
   *  (instructor/user) messages. */
  characterId?: string;
}

/** Contract thread seat plus app-owned typed message history. */
export type PBLAgentThread = RuntimeOverlay<
  ContractPBLThreadSeat,
  {
    messages: PBLChatMessage[];
    /** When messages exceed a threshold, the older half is folded into
     *  a summary string so the context window stays bounded. */
    earlierSummary?: string;
  }
>;

// ---------------------------------------------------------------------------
// Milestone handover
// ---------------------------------------------------------------------------

/** Cross-milestone hand-off card. Set on the project when the
 *  Instructor completes the last microtask of a milestone; the
 *  learner sees a "Continue to Stage N+1" gate and must click before
 *  the next milestone flips from LOCKED → ACTIVE. */
export interface PBLHandover {
  completedMilestoneId: string;
  completedMilestoneTitle: string;
  nextMilestoneId: string;
  nextMilestoneTitle: string;
  nextTaskId?: string;
  nextTaskTitle?: string;
  /** Flipped to true once the learner clicks Continue. Keeps the card
   *  visible in history but hides the action button. */
  consumed?: boolean;
}

/** Task-level manual-completion gate. Present after the current microtask
 *  reaches the "ready to complete" point, but before the learner clicks the
 *  sidebar "Done" button that actually advances project state. */
export interface PBLPendingTaskCompletion {
  microtaskId: string;
  milestoneId: string;
  reason: string;
  assessment?: PBLInternalAssessment;
  evidence?: {
    path: 'concept_unlocked' | 'submission_passed';
    signature?: string;
    label?: string;
    note?: string;
  };
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Top-level v2 project
// ---------------------------------------------------------------------------

/**
 * Contract design/skeleton with app-owned learner and runtime state overlaid
 * onto the nested arrays. The property replacement is essential: intersecting
 * only the two top-level project types would leave contract microtasks and
 * thread messages untyped at app call sites.
 */
export type PBLProjectV2 = RuntimeOverlay<
  ContractPBLProject,
  {
    milestones: PBLMilestone[];
    submissions: PBLSubmission[];
    evaluations: PBLEvaluation[];
    threads: PBLAgentThread[];
    engagementEvents: PBLEngagementEvent[];
    proficiencyAssessment?: PBLProficiencyAssessment;
    runtimeEvents?: PBLRuntimeEvent[];
    runtimeResetEpoch?: number;
    pendingHandover?: PBLHandover;
    pendingTaskCompletion?: PBLPendingTaskCompletion;
    pendingOpenTaskPriorQuizResults?: PriorQuizResult[];
  }
>;

// ---------------------------------------------------------------------------
// Planner input (consumed by PR 2)
// ---------------------------------------------------------------------------

/** Input bundle the v2 Planner consumes to derive a `PBLProjectV2`.
 *
 * Reads from:
 *  - the PBL scene's outline (`pblConfig` + `keyPoints`,
 *    `description`, `teachingObjective`)
 *  - the wider course outlines (for "what learners studied before /
 *    after this PBL")
 *  - optional learner profile (used when available for slight
 *    personalisation of microtask wording)
 */
export interface PBLPlannerV2Input {
  outline: SceneOutline;
  courseContext: {
    /** All outlines in the course, in order. Includes this PBL's
     *  outline. */
    allOutlines: SceneOutline[];
    /** Language directive string (e.g. "Reply in Simplified Chinese").
     *  Inherited from the course generation context. */
    languageDirective: string;
  };
  /** Optional learner profile from `UserRequirements`. */
  user?: {
    nickname?: string;
    bio?: string;
    /** Original free-form course request. Used only for explicit
     *  learner-level signals such as "我是零基础" / "I'm advanced". */
    requirement?: string;
  };
  /** Optional snapshot of prior quizzes the learner has attempted in
   *  this course. Empty at Planner time (course generation runs
   *  before the learner plays the course); populated only by the
   *  Hero-time `pre-play` recalibration path. The Planner ignores
   *  this when present — quiz accuracy is folded in later. */
  priorQuizResults?: PriorQuizResult[];
  /** Target BCP-47 locale for the project, read from the user's UI
   *  locale switcher at course-generation time. Used as the BCP-47
   *  fallback for `project.language` (deterministic platform text).
   *  Does NOT override `courseContext.languageDirective` — the
   *  classroom's content-language policy is the authoritative source
   *  for Planner / Instructor / Evaluator content.
   *
   *  Format: BCP-47 (`zh-CN`, `zh-TW`, `en-US`, `ja-JP`, `ru-RU`,
   *  `ar-SA` — matches `lib/i18n/locales.ts`).
   *
   *  When absent, `detectProjectLanguage` falls back to scanning
   *  outline content. */
  targetLanguage?: string;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isNonArrayObject);
}

/** Whether a persisted v2 value has every container the renderer and runtime
 *  normalization path dereference on mount. Deliberately ignores leaf fields:
 *  old or hand-edited projects may have incomplete scalar metadata while still
 *  being safe to normalize and render. */
export function hasPBLProjectV2Containers(value: unknown): boolean {
  if (!isNonArrayObject(value)) return false;

  if (
    !isObjectArray(value.milestones) ||
    !isObjectArray(value.roles) ||
    !isObjectArray(value.submissions) ||
    !isObjectArray(value.evaluations) ||
    !isObjectArray(value.threads) ||
    !isObjectArray(value.engagementEvents)
  ) {
    return false;
  }

  if (value.milestones.some((milestone) => !isObjectArray(milestone.microtasks))) return false;
  if (value.threads.some((thread) => !isObjectArray(thread.messages))) return false;

  if (value.gains !== undefined && !Array.isArray(value.gains)) return false;
  if (value.runtimeEvents !== undefined && !isObjectArray(value.runtimeEvents)) return false;
  if (value.scenario !== undefined) {
    if (!isNonArrayObject(value.scenario)) return false;
    if (!isObjectArray(value.scenario.characters)) return false;
  }

  return true;
}

/** Whether a stored v2 payload has the minimum design structure the current
 * workspace can turn into learner progress. Runtime normalization can repair
 * status and create the Instructor thread, but it cannot synthesize the role
 * id used to bind that thread, the microtask ids used by lookup/update paths,
 * or the role/task labels rendered by the workspace and Instructor prompt.
 * Other scalar leaves remain deliberately outside this structural predicate. */
export function isRunnablePBLProjectV2(value: unknown): boolean {
  if (!hasPBLProjectV2Containers(value)) return false;

  const project = value as {
    roles: Record<string, unknown>[];
    milestones: Array<{ microtasks: Record<string, unknown>[] }>;
  };
  return (
    project.roles.some(
      (role) =>
        role.type === 'instructor' &&
        typeof role.id === 'string' &&
        role.id.trim().length > 0 &&
        typeof role.name === 'string',
    ) &&
    project.milestones.length > 0 &&
    project.milestones.every(
      (milestone) =>
        milestone.microtasks.length > 0 &&
        milestone.microtasks.every(
          (microtask) =>
            typeof microtask.id === 'string' &&
            microtask.id.trim().length > 0 &&
            typeof microtask.title === 'string',
        ),
    )
  );
}

/** Narrow `unknown` to `PBLProjectV2`. Cheap structural check — does not
 *  validate every field; intended as a safety net, not a full validator. */
export function isPBLProjectV2(value: unknown): value is PBLProjectV2 {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<PBLProjectV2>;
  return (
    typeof v.uiPhase === 'string' &&
    typeof v.title === 'string' &&
    Array.isArray(v.milestones) &&
    Array.isArray(v.roles) &&
    Array.isArray(v.threads)
  );
}
