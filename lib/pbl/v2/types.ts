/**
 * PBL v2 — Project Schema
 *
 * Replaces v1's role-selection + read-only issueboard + @question/@judge
 * model with a single-Instructor guided flow (Hero → Workspace → Completion).
 *
 * v1 (`PBLProjectConfig` in `./types.ts`) is **preserved** for backward
 * compatibility — both fields coexist on `PBLContent`, the renderer
 * branches on which one is populated.
 *
 * The product ships a single Instructor. The multi-agent chat-thread
 * structure is kept generic so additional roles can be introduced later
 * with their own design, but no other role type exists today.
 */
import type { SceneOutline } from '@/lib/types/generation';

// ---------------------------------------------------------------------------
// Enums (string-literal unions; no runtime enum cost)
// ---------------------------------------------------------------------------

/** Project lifecycle status. */
export type PBLProjectStatus = 'designing' | 'review' | 'active' | 'completed' | 'archived';

/** Milestone lifecycle. The LOCKED→ACTIVE transition is gated by the
 *  learner clicking "Continue" on a milestone handover card (see
 *  `PBLHandover`). */
export type PBLMilestoneStatus = 'locked' | 'active' | 'completed';

export type PBLMicrotaskStatus = 'todo' | 'in_progress' | 'completed' | 'skipped';

/** Role types. `user` is the implicit learner (a message/event actor, never
 *  created as a role record). The product currently ships a single Instructor;
 *  `evaluator` / `mentor` / `collaborator` are reserved role kinds. Tools are
 *  NOT roles — roles/agents call tools, recorded as runtime events.
 *  `simulator` is the in-scene role-play character voice and `system` is
 *  neutral scene narration (旁白) — neither a character nor the Instructor;
 *  both ONLY appear on scenario projects (`project.scenario` set) as message
 *  `roleType`s for rendering, NOT `roles[]` records. Normal projects never
 *  produce a `simulator` or `system` message. */
export type PBLRoleType =
  | 'user'
  | 'instructor'
  | 'evaluator'
  | 'mentor'
  | 'collaborator'
  | 'simulator'
  | 'system';

/** Self-reported skill tier; drives Instructor's three-tier guidance.
 *  Empty string means "not yet set" — Planner refuses to leave the
 *  initial phase without it (in v1 standalone; in v2 the value is
 *  derived from outline context, not asked from the user). */
export type PBLProficiency = '' | 'beginner' | 'intermediate' | 'advanced';

export type PBLSubmissionKind = 'text' | 'file' | 'link';

export type PBLEvaluationKind = 'task' | 'milestone' | 'final';

/** Who is responsible for a microtask. The AI-collaborator option was
 *  removed from the product, so every microtask is learner-owned. Kept
 *  as a named type (rather than inlining `'user'`) so the field stays
 *  self-documenting and a future re-introduction is a one-line change. */
export type PBLAssignee = 'user';

/** Closing-check answer quality. Recorded by Instructor via the
 *  `record_closing_check` tool before `advance_micro_task` is allowed. */
export type PBLClosingQuality = 'weak' | 'ok' | 'strong';

/** UI state machine for the in-scene PBL flow. */
export type PBLUiPhase = 'hero' | 'generating' | 'workspace' | 'completed';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** A participant in the project. The Instructor is always present; the
 *  learner ("user") is implicit and has no role record. */
export interface PBLRole {
  id: string;
  type: PBLRoleType;
  name: string;
  /** SHORT, learner-facing introduction shown as a hover tooltip on the
   *  instructor's avatar. Written TO the learner, in the project language.
   *  Curated to be meaningful/reassuring — must NOT expose internal mechanics
   *  (history, tools, evaluation/scoring, task-advancing). Optional: when
   *  absent the avatar hover falls back to showing the role name. */
  description?: string;
  /** Internal persona/voice that drives the agent's behaviour. NOT shown to
   *  the learner. */
  systemPrompt?: string;
}

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

/** A single actionable step within a milestone. */
export interface PBLMicrotask {
  id: string;
  title: string;
  description?: string;
  status: PBLMicrotaskStatus;
  /** Always "user" — the learner does this task. */
  assignee: PBLAssignee;
  hints: string[];
  order: number;
  /** Internal teaching record from `advance_micro_task`. */
  internalAssessment?: PBLInternalAssessment;
  completionReason?: string;
  /** Engagement summary cached on completion. */
  engagement?: PBLEngagementSummary;
  /** SCENARIO ONLY (design-time). Per-beat advance criteria for a SCENE
   *  beat. Normal microtasks / prep / wrapup leave this undefined and
   *  rely on the milestone-level gate. */
  completionCriteria?: string;
  /** SCENARIO ONLY (design-time, B1′). The CONCRETE, OBSERVABLE in-scene
   *  action the learner must say or do for THIS beat to count as done — the
   *  scenario equivalent of a "deliverable" (e.g. "下注、加注或弃牌" /
   *  "对对方的感受做出共情回应"). Authored in plain scene terms, NOT a
   *  teaching goal. The advance detector uses this (falling back to
   *  `completionCriteria`) so off-topic / small-talk turns do NOT advance.
   *  Undefined = fall back to `completionCriteria`. */
  successWhen?: string;
  /** SCENARIO ONLY (design-time, B1′). What the character PRIVATELY wants
   *  this beat (their in-scene drive, e.g. "试探对方是否在虚张声势"). Fed to
   *  the Simulator so the character pursues a goal in character — NEVER
   *  narrated, evaluated, or coached. Undefined = no explicit drive. */
  characterObjective?: string;
  /** SCENARIO ONLY (design-time, B1′). The single skill this beat practises
   *  (e.g. "底池赔率判断" / "积极倾听"). Consumed by the final evaluator's
   *  per-act goal scaffold and surfaced in the completion page's per-act
   *  review; never spoken by the character. Undefined = none. */
  skillFocus?: string;
  /** SCENARIO ONLY (design-time). Neutral system narration shown when
   *  this SCENE beat is entered (e.g. "you walk into a quiet café").
   *  Rendered as a `'system'` message — NOT a character, NOT the
   *  Instructor. Undefined = no narration. */
  narration?: string;
  /** SCENARIO ONLY (design-time). Learner-facing brief for the right-side
   *  "current task" panel — what this beat is about and WHY it matters, in
   *  the learner's own framing. May give orientation / things to think about,
   *  but NEVER names the exact action or answer (that is the hidden
   *  `successWhen`) and NEVER spoils a `characterObjective` fact. This is a
   *  PURE DISPLAY field: it is NOT fed to the character/narrator (so it can
   *  carry light teaching framing without polluting the role-play), unlike
   *  `description` which is the character's established-fact source. When
   *  absent, the panel falls back to `description`. */
  learnerBrief?: string;
}

/** A learning document or reference material attached to a milestone. */
export interface PBLDocument {
  id: string;
  title: string;
  content: string;
  docType: 'markdown' | 'reference' | 'starter_file';
}

/** A major phase of the project.
 *
 * The three "script" fields — `briefing`, `completionCriteria`,
 * `debrief` — are the Planner's hand-off to the Instructor. The
 * Instructor reads them off the milestone like a script: what to set
 * up, what counts as done, how to wrap.
 */
export interface PBLMilestone {
  id: string;
  title: string;
  description?: string;
  status: PBLMilestoneStatus;
  order: number;
  microtasks: PBLMicrotask[];
  /** Legacy / future resource slot. Current generators do not author this. */
  documents?: PBLDocument[];
  /** Short intro: why this milestone exists, what to expect. */
  briefing?: string;
  /** How to tell the learner is done. */
  completionCriteria?: string;
  /** What to say when wrapping up. */
  debrief?: string;
  /** Optional, authored by the Planner ONLY for the 1-2 stages that
   *  carry the project's core knowledge. When present, the Instructor
   *  runs a one-time integrative reverse-question about the whole
   *  stage's core concept before the stage is allowed to seal (see
   *  the milestone evidence gate in `agents/instructor.ts`). Leaving
   *  it undefined means "no stage-level synthesis check" — most
   *  stages. This is the deterministic knob that keeps stage-level
   *  reverse-questions from being asked on every stage (too many) or
   *  never (too few). */
  synthesisCheck?: {
    /** Short description of the core concept the integrative question
     *  should probe (e.g. "为什么循环能避免重复代码"). */
    coreConcept: string;
  };
  /** Same idea as `PBLMicrotask.internalAssessment` — Instructor sets
   *  this when auto-completing the milestone via `advance_micro_task`
   *  on the last task. */
  internalAssessment?: PBLInternalAssessment;
  /** SCENARIO ONLY (design-time). This milestone's role in the fixed
   *  three-stage scenario skeleton:
   *    - 'prep'   = first stage; Instructor introduces the concrete
   *                 premise + cast (no assessment, confirm-to-advance).
   *    - 'roleplay' = immersive role-play stage driven by the Simulator
   *                 (the cast in `project.scenario.characters`); there
   *                 may be MORE THAN ONE consecutive roleplay stage.
   *    - 'wrapup' = last stage; Instructor gives light, data-driven
   *                 feedback (detailed report lives on the completion page).
   *  Normal milestones leave this undefined and run the standard
   *  Instructor flow. (Named 'roleplay' — NOT 'scene' — to avoid
   *  collision with OpenMAIC's top-level "scene" type.) */
  scenarioStage?: 'prep' | 'roleplay' | 'wrapup';
}

/** SCENARIO ONLY. One character in the role-play cast. Authored at
 *  design time (Planner) and frozen into the packaged project. The
 *  character is data on `project.scenario`, NOT a `roles[]` record. */
export interface PBLScenarioCharacter {
  id: string;
  name: string;
  /** Persona: stable identity / relationship to the learner /
   *  personality / speaking style — injected into the Simulator system
   *  prompt. */
  persona: string;
  /** SCENARIO ONLY (design-time). This character's CONCRETE current
   *  circumstance / role in the scenario that the learner walks into —
   *  e.g. "just went through a breakup, low mood, says they're fine but
   *  aren't"; in a game: "sits at the under-the-gun position, plays
   *  tight". Distinct from `persona` (stable identity). Pinned at design
   *  time and introduced by the Instructor in the prep stage — the
   *  learner never has to guess it. */
  situation?: string;
  /** Hard safety boundaries (what the character must never say/do). */
  boundaries?: string;
  /** Avatar asset path or style seed; rendered distinct from the
   *  Instructor avatar. */
  avatar?: string;
  /** Optional design-time opening line so the packaged scene is
   *  reproducible; if absent the Simulator generates one at runtime. */
  openingLine?: string;
}

/** SCENARIO ONLY (design-time). ONE project-wide scene visual for the
 *  role-play entrance animation + banner. Authored by the Planner from an
 *  understanding of ALL roleplay stages, so it fits the whole project (not a
 *  guessed/enumerated category). Rendered deterministically; EVERY field is
 *  optional and sanitized at render time, so a missing / malformed value can
 *  never break the view. Purely cosmetic — never gates logic. */
export interface PBLSceneVisual {
  /** A short, project-wide scene phrase that fits every roleplay stage
   *  (e.g. "深夜，各自房间隔着手机聊到天亮" / "决赛辩论赛场" / "牌桌现金局"). */
  caption?: string;
  /** Background gradient top colour (hex, e.g. "#3a2740"). */
  bg1?: string;
  /** Background gradient bottom colour (hex). */
  bg2?: string;
  /** Accent colour for glows / motifs (hex). */
  accent?: string;
  /** 2–4 emoji that evoke the shared setting (e.g. ["📱","🌙","🛏️"]). */
  motifs?: string[];
}

/** SCENARIO ONLY. Presence of `project.scenario` is the single gate
 *  that marks a project as a role-play scenario project. Absent on all
 *  normal projects (the baseline). Authored at design time and frozen
 *  into the packaged project. */
export interface PBLScenarioConfig {
  /** The overall premise / situation (what is going on). Introduced by
   *  the Instructor in the prep stage. */
  setting: string;
  /** SCENARIO ONLY (design-time). The project-wide scene visual (entrance
   *  animation + banner backdrop), authored by the Planner to fit all
   *  roleplay stages. Cosmetic; absent → a neutral fallback is rendered. */
  sceneVisual?: PBLSceneVisual;
  /** What the learner is practicing (used by wrapup / completion page). */
  goal?: string;
  /** SCENARIO ONLY (design-time). Rules / structure the learner must be
   *  told before the scene (games / interviews / debates etc.). Omit for
   *  free-form emotional scenarios. Introduced by the Instructor in prep. */
  rules?: string;
  /** SCENARIO ONLY (design-time). The learner's OWN role / position in
   *  the scenario — e.g. "you are their close friend" / "you are the 5th
   *  player, on the button". Introduced by the Instructor in prep. */
  learnerRole?: string;
  /** The cast (1..N; first showcase ships a single character). */
  characters: PBLScenarioCharacter[];
}

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
      entityType: 'project' | 'milestone' | 'microtask';
      entityId: string;
      from: string;
      to: string;
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
   *  `scoreToTier(score, currentTier)` in operations/proficiency. */
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
 *  Aggregated by `lib/pbl/v2/operations/quiz-snapshot.ts` from
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

/** Per-agent chat thread. Currently only the Instructor thread is
 *  populated. */
export interface PBLAgentThread {
  /** Matches `PBLRole.id`. */
  agentId: string;
  messages: PBLChatMessage[];
  /** When messages exceed a threshold, the older half is folded into
   *  a summary string so the context window stays bounded. */
  earlierSummary?: string;
}

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
 * The v2 PBL project model. Lives at `scene.content.projectV2`.
 *
 * Key differences from v1 `PBLProjectConfig`:
 *  - Replaces "issueboard" with structured Milestones + Microtasks
 *  - Replaces the role-selection Landing with Hero → Workspace →
 *    Completion flow
 *  - Single Instructor agent (the `roles` / `threads` arrays are kept
 *    generic so additional roles could be introduced later)
 *  - First-class evaluations (task / milestone / final) with
 *    structured fields
 *  - First-class engagement analytics
 *  - Submission objects (paste-text / upload / link)
 *  - Milestone gating (LOCKED→ACTIVE explicit user gate via
 *    `pendingHandover`)
 *
 * Only the Instructor is wired: `roles` contains exactly one Instructor
 * record and `threads` contains its single thread.
 */
export interface PBLProjectV2 {
  /** UI state machine for the in-scene PBL flow. */
  uiPhase: PBLUiPhase;

  // --- Project metadata --------------------------------------------------

  title: string;
  description: string;
  /** What the learner wants to LEARN (distinct from `description` =
   *  what they will BUILD). Derived from outline context in v2 (in v1
   *  standalone this was captured by Planner's intent-convergence
   *  phase, which we drop in v2). */
  learningObjective?: string;
  /** Learner-facing "what you'll gain" statements shown on the Hero —
   *  3-5 concise, readable phrases for the abilities / awareness /
   *  knowledge the learner BUILDS by working through the project. These
   *  describe what the learner takes away (capabilities exercised), NOT
   *  the final deliverable/result the project produces (that is
   *  `description`). Authored by the Planner in the project language,
   *  typically by expanding each terse outline `targetSkills` entry into
   *  a readable competency. Distinct from `learningObjective`, the single
   *  internal skill sentence used by prompts. Optional only for backward
   *  compatibility with projects packaged before this field existed
   *  (legacy v1→v2 upgrades); new Planner runs always populate it. */
  gains?: string[];
  /** Skill tier — kept in sync with `proficiencyAssessment.tier` for
   *  legacy consumers (planner prompt, tier-guidance block, dev
   *  logs). The full adaptive state lives in `proficiencyAssessment`. */
  proficiency: PBLProficiency;
  /** Adaptive proficiency state — pre-play initial assessment + the
   *  in-PBL EWMA-updated score. Drives Instructor's tier guidance.
   *  See `lib/pbl/v2/operations/proficiency.ts` for the algorithm. */
  proficiencyAssessment?: PBLProficiencyAssessment;
  /** ISO 639 language code from outline language inference.
   *  BCP-47 fallback locale for deterministic platform text (e.g.
   *  syntheticPlatformOpener). For CONTENT language, prefer
   *  `languageDirective` — it carries the classroom's full language
   *  policy (e.g. "中文为主，英文技术术语保留原文") and is the
   *  authoritative source for Planner / Instructor / Evaluator. */
  language: string;
  /** Classroom-level content-language policy. Set by the Planner from
   *  `courseContext.languageDirective`. When present, it overrides
   *  `language` as the content-language rule. It may be a simple locale
   *  ("zh-CN") or a nuanced directive ("中文为主，英文技术术语保留原文").
   *  When undefined (legacy projects), `language` is the fallback. */
  languageDirective?: string;
  /** Free-form tags (e.g. ["python", "data-analysis"]). */
  tags: string[];

  /** SCENARIO ONLY. Role-play scenario configuration. Presence of this
   *  field is the single gate that marks the project as a scenario
   *  project; absent on all normal projects. Authored at design time
   *  (Planner) and frozen into the packaged project. */
  scenario?: PBLScenarioConfig;

  /** Packaged-format version. Absent = baseline (current). Reserved for
   *  future migrations once the project package format is frozen. */
  schemaVersion?: number;

  // --- Lifecycle ---------------------------------------------------------

  status: PBLProjectStatus;

  // --- Structure ---------------------------------------------------------

  /** Multi-agent participants. Stage A only populates the Instructor
   *  (one record with `type === 'instructor'`). The schema supports
   *  any number of additional agents for follow-up PRs. */
  roles: PBLRole[];

  milestones: PBLMilestone[];

  /** Learner deliverables attached to microtasks. */
  submissions: PBLSubmission[];

  /** Instructor's structured feedback at task / milestone / final
   *  levels. */
  evaluations: PBLEvaluation[];

  // --- Runtime state -----------------------------------------------------

  /** Per-agent chat threads. Stage A only contains an Instructor
   *  thread. */
  threads: PBLAgentThread[];

  /** Append-only event ledger (ring-buffer capped; see analytics
   *  module for the cap). */
  engagementEvents: PBLEngagementEvent[];

  /** Append-only runtime fact ledger. This is intentionally broader than
   *  engagement analytics: it records actor actions such as messages, tool
   *  calls, submissions, evaluations and state changes. It remains optional
   *  for old v2 projects; future runtime-split work can make it required. */
  runtimeEvents?: PBLRuntimeEvent[];

  /** Cross-milestone hand-off state. Present after Instructor
   *  completes a milestone's last microtask, until the learner clicks
   *  Continue. */
  pendingHandover?: PBLHandover;

  /** Task-level manual-completion state. Present after a microtask has
   *  reached B point; the task remains active until the learner clicks
   *  the sidebar "Done" button. */
  pendingTaskCompletion?: PBLPendingTaskCompletion;

  /** Transient client-only payload for the first Workspace greeting.
   *  The Hero computes the prior-quiz snapshot immediately before
   *  launch, then the Chat consumes and clears this field before it
   *  starts `/api/pbl/v2/open-task`. It should not remain on persisted
   *  project state after that first request begins. */
  pendingOpenTaskPriorQuizResults?: PriorQuizResult[];

  // --- Timestamps --------------------------------------------------------

  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

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

/** Narrow `unknown` to `PBLProjectV2`. Used by `pbl-renderer.tsx` to
 *  branch v1 vs v2 paths. Cheap structural check — does not validate
 *  every field; intended as a safety net, not a full validator. */
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
