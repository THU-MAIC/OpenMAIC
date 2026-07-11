/**
 * PBL v2 — Planner Agent
 *
 * Designs a complete PBLProjectV2 from an outline-stage `pblConfig`
 * plus the wider course context. Replaces v1's `lib/pbl/generate-pbl.ts`
 * agentic loop (4 modes / 22 tools / role-selection model) with a
 * single-pass, single-mode agentic loop that emits the v2 schema
 * (milestones / microtasks / single Instructor role / structured
 * scripts).
 *
 * The Planner does not ask the user about intent and does not pause
 * for skeleton confirmation. By the time it runs, the outline stage
 * has already inferred the project topic into `outline.pblConfig` and
 * the student is not in the loop.
 *
 * Technology: Vercel AI SDK `generateText` + `tool` + `stopWhen` —
 * the same range v1 uses, kept identical so the upgrade path is
 * incremental.
 */

import type { LanguageModel, StepResult, StopCondition, ToolSet } from 'ai';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';

import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { loadPBLV2Prompt } from '../prompts/loader';
import { computeInitialAssessment, reseatAssessmentTier } from '../operations/proficiency';
import { normalizeProjectRuntime, normalizeScenario } from '../operations/progress';
import type { ThinkingConfig } from '@/lib/types/provider';

import type {
  PBLProjectV2,
  PBLPlannerV2Input,
  PBLProficiency,
  PBLMilestone,
  PBLMicrotask,
  PBLRole,
  PBLScenarioConfig,
} from '../types';

const log = createLogger('PBL v2 Planner');

/** SCENARIO ONLY. Packaged-format version stamped on scenario projects
 *  (`project.schemaVersion`). Absent on ordinary projects (baseline).
 *  Bump when the packaged scenario format changes so loaders can
 *  migrate. */
export const SCENARIO_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Loop budgets
// ---------------------------------------------------------------------------

/** Max tool-call steps in one Planner run. Generous so the LLM can
 *  emit set-info + role + ~4 milestones × (1 milestone + 4 microtasks)
 *  + done, with headroom for retries on validation
 *  errors. */
const MAX_PLANNER_STEPS = 80;

// ---------------------------------------------------------------------------
// Callbacks (so the caller can stream progress to a UI later)
// ---------------------------------------------------------------------------

export interface PlannerV2Callbacks {
  /** Fired on each successful tool call. Used by the future Generating
   *  page to show "Adding milestone: X" etc. */
  onProgress?: (event: PlannerV2ProgressEvent) => void;
}

export type PlannerV2ProgressEvent =
  | { kind: 'project_info'; title: string }
  | { kind: 'role'; roleType: PBLRole['type']; name: string }
  | { kind: 'milestone'; title: string; index: number }
  | { kind: 'microtask'; milestoneTitle: string; title: string; index: number }
  | { kind: 'complete'; milestoneCount: number; microtaskCount: number };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the Planner finishes but the result is unusable (no
 *  Instructor, no milestones, etc.). The caller should fall back to v1
 *  or to a slide so the student is never stranded on an empty PBL. */
export class PlannerV2Error extends Error {
  constructor(
    message: string,
    public readonly partial: PBLProjectV2,
  ) {
    super(message);
    this.name = 'PlannerV2Error';
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the v2 Planner agentic loop and return a complete `PBLProjectV2`.
 *
 * Caller responsibility: pass a `LanguageModel` instance and (for
 * thinking-capable models) a `ThinkingConfig`. The Planner does not
 * choose models or providers — it inherits whatever the course
 * generation pipeline already resolved.
 *
 * Throws `PlannerV2Error` if the model finished without producing a
 * usable project (no Instructor role or no milestones with
 * microtasks). The caller should treat that as a fatal v2 failure and
 * fall back.
 */
export async function generatePBLV2Project(
  input: PBLPlannerV2Input,
  model: LanguageModel,
  callbacks?: PlannerV2Callbacks,
  thinkingConfig?: ThinkingConfig,
): Promise<PBLProjectV2> {
  // Pull all the fields the prompt needs out of the input bundle so the
  // template substitution is explicit rather than passing `input` as a
  // big object — the prompt is reviewed by humans, every variable name
  // matters.
  const pblConfig = input.outline.pblConfig;
  if (!pblConfig) {
    throw new PlannerV2Error(
      'Planner v2 invoked on an outline without pblConfig — this is a generation pipeline bug.',
      emptyProject(input),
    );
  }

  // Mutable shared state. Tools mutate this; we hand the final value
  // back at the end. Avoids the "tool returns partial JSON" pattern
  // which is harder to validate. `emptyProject` also computes the
  // initial proficiency assessment from static signals.
  const project = emptyProject(input);

  // SCENARIO ONLY opt-in. When the outline marks this PBL as a role-play
  // scenario (`pblConfig.scenarioRoleplay === true`), the Planner
  // additionally designs a cast (`set_scenario`), a scene milestone
  // (`add_milestone({ scene: true })`), and per-beat fields
  // (`add_microtask({ completionCriteria, successWhen, ... })`). When
  // absent / false this is an ordinary PBL project and every prompt /
  // tool surface below is byte-identical to before.
  const scenarioRoleplay = pblConfig.scenarioRoleplay === true;

  // Content language comes solely from `languageDirective` (the outline's
  // natural-language language policy). No code-side locale guessing or guard —
  // the prompt's Hard rule 1 carries it. Falls back to a neutral instruction
  // only when the outline gave no directive at all.
  const contentLanguage =
    project.languageDirective || 'Match the language of the outline content above.';
  const systemPrompt = await buildPlannerSystemPrompt(
    input,
    project.proficiency,
    contentLanguage,
    scenarioRoleplay,
  );

  // Tool implementations. Each one validates its inputs, mutates
  // `project`, fires a progress event, and returns a small result the
  // LLM uses to continue (the result is what's serialized into the
  // tool-call message that the LLM sees on the next turn).
  const tools = buildTools(project, input, scenarioRoleplay, callbacks);

  log.info(
    `Starting Planner v2: topic="${pblConfig.projectTopic}", proficiency="${input.outline.pblConfig?.issueCount ?? '?'} milestones suggested"`,
  );

  // The agentic loop. The Planner emits tool calls until
  // `mark_design_complete` is accepted by the completion gate, or
  // until the defensive step budget is hit.
  try {
    await callLLM(
      {
        model,
        system: systemPrompt,
        prompt:
          'Design the PBL project now. Call the tools in the documented order; do not write narrative text.',
        tools,
        stopWhen: [plannerDesignAccepted(), stepCountIs(MAX_PLANNER_STEPS)],
        onStepFinish: ({ toolCalls }) => {
          // Optional verbose log. Keep at debug-level so production
          // logs don't drown in tool noise.
          if (toolCalls?.length) {
            for (const tc of toolCalls) {
              log.debug(`tool call: ${tc.toolName}`);
            }
          }
        },
      },
      'pbl-v2-planner',
      undefined,
      thinkingConfig,
    );
  } catch (err) {
    throw err;
  }

  normalizeProjectRuntime(project);
  normalizeSynthesisChecks(project);
  // Scenario-aware validation: when scenario mode was requested, require
  // a coherent cast + scene milestone (throws → existing fallback). For
  // ordinary projects this is byte-identical to before.
  validateProject(project, scenarioRoleplay);
  // SCENARIO ONLY safety net. After validation the scenario is coherent,
  // so this only assigns any missing character ids / is a no-op; it's
  // kept here for idempotency with the load path.
  normalizeScenario(project);
  log.info(
    `Planner v2 done: ${project.milestones.length} milestones, ${project.milestones.reduce(
      (acc, m) => acc + m.microtasks.length,
      0,
    )} microtasks, ${project.roles.length} roles.`,
  );

  return project;
}

// ---------------------------------------------------------------------------
// Empty / starter shape
// ---------------------------------------------------------------------------

export function emptyProject(input: PBLPlannerV2Input): PBLProjectV2 {
  const now = new Date().toISOString();

  // Compute the planner-time initial proficiency assessment from
  // static signals (outline keywords + prior-scene difficulty + user
  // bio). Quiz accuracy is not yet available — that's folded in at
  // Hero entry by the pre-play recalibration path.
  //
  // See `lib/pbl/v2/operations/proficiency.ts` for the full algorithm
  // and the calibration table. The Planner LLM does NOT decide this
  // value: it consumes `assessment.tier` as a directive when
  // dimensioning microtasks.
  const assessment = computeInitialAssessment({
    outline: input.outline,
    priorScenes: input.courseContext.allOutlines,
    userBio: input.user?.bio,
    userRequirement: input.user?.requirement,
    priorQuizResults: input.priorQuizResults,
    source: 'planner',
  });
  const proficiency: PBLProficiency = assessment.tier;
  // `languageDirective` is the SINGLE source of truth for content language —
  // a free natural-language directive from the outline stage (e.g. "Reply in
  // Simplified Chinese" / "中文为主，英文技术术语保留原文"). The Planner feeds it
  // straight to the system prompt; there is no content-based locale guessing.
  //
  // `language` is only the BCP-47 locale the RUNTIME uses for deterministic
  // platform strings (synthetic openers, divider labels). It is seeded from
  // the authoritative UI locale (`targetLanguage`) when known and otherwise
  // left blank for the Hero locale-sync (hero.tsx) to fill on entry — it is
  // NEVER inferred from content here.
  const languageDirective = input.courseContext.languageDirective?.trim();
  const language = input.targetLanguage?.trim() ?? '';

  log.info(
    `Planner v2 initial assessment: tier=${assessment.tier} score=${assessment.score.toFixed(
      2,
    )} confidence=${assessment.confidence.toFixed(2)} signals=${assessment.signals.length} language=${language}`,
  );

  return {
    uiPhase: 'hero',
    title: '',
    description: '',
    learningObjective: '',
    gains: [],
    proficiency,
    proficiencyAssessment: assessment,
    language,
    languageDirective: languageDirective || undefined,
    tags: [],
    status: 'designing',
    roles: [],
    milestones: [],
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function formatCourseContext(input: PBLPlannerV2Input): string {
  const lines: string[] = [];
  for (const o of input.courseContext.allOutlines) {
    const marker = o.id === input.outline.id ? ' ← this PBL scene' : '';
    lines.push(`- [${o.order}] ${o.type.toUpperCase()}: ${o.title}${marker}`);
    if (o.description) {
      lines.push(`    ${o.description}`);
    }
  }
  return lines.join('\n');
}

export async function buildPlannerSystemPrompt(
  input: PBLPlannerV2Input,
  proficiency: PBLProficiency,
  contentLanguage: string,
  scenarioRoleplay: boolean,
  promptName: string = 'planner-system',
): Promise<string> {
  const pblConfig = input.outline.pblConfig!;

  // The adaptive engine decided the tier in `emptyProject`; pass it
  // through as a directive so the LLM dimensions microtasks
  // accordingly. The Planner is expected to mirror this value when it
  // calls `set_project_info`; if it picks a different tier the tool
  // accepts the value (it's a hint, not a hard contract) but the
  // engine logs the divergence.
  //
  // `contentLanguage` is resolved by the caller from
  // `project.languageDirective || project.language` (single source). It may be
  // a BCP-47 locale or a nuanced directive like "中文为主，英文技术术语保留原文".
  return loadPBLV2Prompt(promptName, {
    projectTopic: pblConfig.projectTopic,
    projectDescription: pblConfig.projectDescription,
    targetSkills: (pblConfig.targetSkills ?? []).join(', '),
    milestoneCount: pblConfig.issueCount ?? 3,
    proficiency: proficiency === '' ? 'intermediate' : proficiency,
    language: contentLanguage,
    courseContext: formatCourseContext(input),
    languageDirective: input.courseContext.languageDirective,
    // Optional free-form scenario brief from the outline stage. Empty for
    // ordinary projects / non-scenario prompts (the slot collapses).
    scenarioBrief: input.outline.pblConfig?.scenarioBrief ?? '',
    // SCENARIO ONLY. Empty string for ordinary PBL projects → the
    // `{{scenarioDesign}}` slot collapses to nothing and the prompt is
    // byte-identical to before. The slot must always be provided (the
    // interpolator leaves unknown placeholders literal).
    scenarioDesign: buildScenarioDesignBlock(pblConfig, scenarioRoleplay),
  });
}

/** SCENARIO ONLY. Build the role-play scenario-design instruction block
 *  injected into the Planner system prompt. Returns '' for ordinary PBL
 *  projects (so the prompt is byte-identical to before). When the
 *  outline opted into `scenarioRoleplay`, it instructs the Planner to
 *  fully author the scenario AND lay it out as the fixed three-stage
 *  skeleton: prep → roleplay(×1..N) → wrapup. */
export function buildScenarioDesignBlock(
  pblConfig: NonNullable<PBLPlannerV2Input['outline']['pblConfig']>,
  scenarioRoleplay: boolean,
): string {
  if (!scenarioRoleplay) return '';
  const brief = pblConfig.scenarioBrief?.trim();
  return [
    '## SCENARIO MODE — role-play scenario (this project only)',
    '',
    'This PBL is a **role-play scenario**: the learner will step into a concrete situation and interact in-character with character(s) played by a separate Simulator agent. You author the WHOLE scenario now (it is frozen into the package); the runtime only produces the live dialogue. Two rules above all: (a) the premise is **given and concrete**, introduced to the learner by the Instructor — the learner must NEVER be asked to guess it; (b) every task must serve the real learning goal (how to do the thing well), not meta-guessing.',
    '',
    brief ? `Scenario brief from the platform: ${brief}\n` : '',
    '### Step A — fully author the scenario with `set_scenario(...)`',
    'Call **exactly once, right after `set_project_info` and before any `add_milestone`**:',
    '- `setting`: the concrete overall premise / what is going on (in the project language).',
    '- `goal` (optional): what the learner is practising.',
    "- `rules` (optional but REQUIRED whenever the scenario has any defined rule-set — games / interviews / debates / structured negotiations / etc.): write the CONCRETE rules a newcomer needs to actually take part, specific enough that the Instructor can teach them verbatim in prep. Not a vague label — include the real mechanics (e.g. a card game: hand ranking, betting rounds, blinds, what terms like Pot Odds / Fold / Call / Raise / Check mean; a debate: the motion, each side's stance, the speaking format; an interview: the rounds and what each assesses). Omit ONLY for free scenarios with no special rules (e.g. comforting a friend).",
    '- `learnerRole` (optional): the learner\'s OWN role/position (e.g. "you are their close friend" / "you are the 5th player, on the button").',
    '- `characters`: **EXACTLY ONE character** — this version plays a single counterpart throughout (the runtime only ever voices one). It needs `name`, `persona` (stable identity / relationship / personality / speaking style), **`situation`** (their CONCRETE current circumstance the learner faces — e.g. "just broke up last week, low mood, says they\'re fine but aren\'t"). `situation` is shown to the learner up front (prep intro + the always-visible scenario briefing), so it must hold ONLY what the learner can see/know at the start — keep any fact a later beat is meant to make them uncover OUT of it (see the No-spoilers rule below). Plus strongly-recommended `boundaries` (hard safety rails), and optional `openingLine`.',
    '',
    '### Step B — lay out the FIXED three-stage skeleton (milestones in this exact order)',
    '1. **Prep stage** — `add_milestone({ ..., scenarioStage: "prep" })` as the FIRST milestone. Its `briefing` is the Instructor intro that **introduces the concrete premise to the learner**: the situation, each character\'s `situation`, what the learner is there to do, plus `rules` / `learnerRole` when present. The intro MUST match the roleplay stages you design next. Give prep **exactly ONE light microtask** (e.g. "了解背景，准备开始" / "Understand the setup, ready to begin") — NO assessment; the learner just confirms and advances. **Do NOT set `coreConcept`.**',
    '2. **Roleplay stage(s)** — one or MORE `add_milestone({ ..., scenarioStage: "roleplay" })` in the middle (split a long scenario into several roleplay stages by round/phase to avoid one giant stage). Each roleplay milestone\'s `briefing` brings the learner into the scene. **Design the beats as a DRAMATIC ARC, not a flat checklist**: an opening hook → rising stakes/complication → a turning point or decision → a resolution. Each beat should be a MEANINGFUL decision/action unit (something the learner can actually DO), never empty filler. For **each microtask (beat)** under a roleplay milestone, provide:',
    '   - `description`: the CONCRETE situation of this beat as the SYSTEM narrator states it to the learner — positions / cards / what just happened / whose turn (e.g. "你在 Button 位拿到 A♠ J♦；前面都 Fold，老周在 Cutoff 加注到 6 个筹码；轮到你决定 preflop"). The character NEVER states these facts — the system does; the character only reacts. Keep it factual scene-setting, not coaching.',
    '   - `successWhen` (REQUIRED for every roleplay beat): the CONCRETE, OBSERVABLE in-scene action the learner must SAY or DO for this beat to count as done — the scenario\'s "deliverable" (e.g. "做出 preflop 决定：跟注、加注或弃牌" / "对对方说出的感受做出共情回应，并问一个跟进问题"). State it in plain SCENE terms (what they do in the fiction), NOT as a teaching goal. This is exactly what the advance detector watches, so a crisp `successWhen` is what stops off-topic / small-talk turns from advancing the scene. Make it a real decision/action, not "they chatted a bit".',
    '   - `completionCriteria` (optional, legacy): a teaching-side note on what this beat is about; `successWhen` is preferred and takes precedence for advancing.',
    '   - `characterObjective` (recommended): what the character PRIVATELY wants — and privately KNOWS — this beat: their in-scene drive (e.g. "试探你是否在虚张声势" / "想确认你是否真的在乎"), plus any fact the learner is meant to UNCOVER this beat (the hidden cause / secret / backstory the character only reveals when probed — e.g. "你昨天在空调房待了很久才着凉，但只有被仔细询问才说出来"). It makes the character pursue a goal and hold its secrets in character; it is private to the character — NEVER narrated, shown in the briefing, evaluated, or coached.',
    '   - `skillFocus` (recommended): the single skill this beat practises (e.g. "底池赔率判断" / "积极倾听"). Surfaced to the learner (current-task panel + end-of-project per-act review); never spoken by the character.',
    '   - The scene is FREE-FIRST: the learner always speaks/types their OWN response to the character, which is how a real interaction is practised. (Some beats may instead ask the learner to hand in a real artefact, e.g. "write them a letter".)',
    '   - `narration` (optional): a short neutral scene-setting line the SYSTEM reads when this beat opens (e.g. "你们走进了一家安静的咖啡厅"). NEVER spoken by a character or the Instructor. All scene/state facts come from the system (narration + description), never from the character\'s mouth.',
    '   - `hints` (recommended for roleplay beats): 1–2 SHORT, learner-facing coaching tips for THIS beat — what skill to focus on or how to handle it well (e.g. "先共情、再问问题，别急着给建议" / "注意你的位置和底池赔率，再决定下注"). They appear in the "hints" card of the learner\'s current-task side panel, are NEVER spoken by the character, and are the learner\'s in-the-moment guidance. Keep them concrete to this beat, not generic.',
    '   - **Do NOT set `coreConcept`** on roleplay milestones.',
    '3. **Wrapup stage** — `add_milestone({ ..., scenarioStage: "wrapup" })` as the LAST milestone. Its `debrief` holds the Instructor\'s light, encouraging feedback points (highlights / one thing to improve); the detailed report lives on the completion page. Give wrapup **exactly ONE light microtask** (e.g. "听取反馈，收尾" / "Hear the feedback, wrap up"). **Do NOT set `coreConcept`.**',
    '',
    '### Rules for scenario design',
    '- The premise (situation / rules / positions) is GIVEN and introduced in prep — **never make a task that asks the learner to guess/invent it**.',
    "- **No spoilers — never give away in learner-VISIBLE text what a beat is designed to make the learner discover.** The premise the learner can see up front — `setting`, each character's `situation` / `persona`, the prep `briefing`, and each beat's `description` / `narration` (and the always-visible scenario briefing built from these) — must contain ONLY what the learner already knows or can plainly observe at the outset. If any roleplay beat's `successWhen` requires the learner to UNCOVER something through the interaction (a hidden cause, a motive, a secret, the diagnosis, a backstory fact), that information MUST NOT appear in any learner-visible field. Put it ONLY in that beat's private `characterObjective`, where the character holds it and reveals it solely when the learner actually probes for it — never up front. E.g. a \"find out why\" beat: the real cause lives in `characterObjective`; `situation` states only the visible symptoms / where the character is right now.",
    '- All scenario text (`setting`/`persona`/`situation`/`briefing`/narration/options…) follows the same content-language policy as Hard rule 1.',
    '- Scene beats should feel like a real interaction unfolding, not a checklist; 2-4 beats per roleplay stage is plenty.',
    '- **The roleplay character is a pure in-world participant, NEVER a coach.** When you write `persona` / `situation` / `openingLine` (and any character-facing text), the character must have its OWN motives and react like a real person in the scene. It must NEVER: ask the learner to explain/justify their reasoning ("说说你为什么这么选" / "一句话给我理由"), evaluate or grade the learner\'s moves ("这步打得对"), give strategy/meta hints ("想想我的范围里哪些牌会付钱"), or tell the learner it\'s their turn / what to decide. That is all out-of-scene/teaching content and it does NOT belong in the character\'s mouth.',
    '- **Out-of-scene content has its own channels — never the character:** (a) the "this is a training table / I\'ll test you" framing and any rule teaching belong to the **prep Instructor** (`briefing`); (b) "it\'s your turn to act / a decision point has arrived" belongs to the **system `narration`** of that beat, stated neutrally; (c) strategy / what-to-watch-for hints belong to the microtask **`hints`** (side panel). Route each of these to its channel; the character only ever lives the scene.',
    '',
    '',
    '### Step C — author ONE project-wide scene visual with `set_scene_visual(...)`',
    'After ALL roleplay milestones/beats exist, call `set_scene_visual` exactly once. Read back over EVERY roleplay stage/task you just wrote and distil the ONE shared place/atmosphere they all happen in, then describe it: a `caption` (a short phrase in the project language fitting all stages — derived from the real tasks, e.g. "深夜，各自房间隔着手机聊到天亮" / "决赛辩论赛场" / "牌桌现金局"), a 3-colour `palette` (`bg1`/`bg2`/`accent` hex matching the mood), and 2–4 `motifs` (emoji that evoke this exact scene). Make it specific to THIS project — never a generic placeholder.',
    '',
    '### Scenario tool workflow (supersedes the order above for this project)',
    '1. `set_project_info(...)`',
    '2. `set_scenario({ setting, goal?, rules?, learnerRole?, characters })`',
    '3. `add_role({ type: "instructor", ... })`',
    '4. `add_milestone({ scenarioStage: "prep" })` + its one light microtask',
    '5. one or more `add_milestone({ scenarioStage: "roleplay" })` + their beats as a dramatic arc (successWhen [required] / characterObjective / skillFocus / narration?)',
    '6. `add_milestone({ scenarioStage: "wrapup" })` + its one light microtask',
    '7. `set_scene_visual({ caption, bg1, bg2, accent, motifs })` — based on all the roleplay stages above',
    '8. `mark_design_complete()`',
  ].join('\n');
}

export function ordinaryPBLTextOnlyGaps(project: PBLProjectV2): string[] {
  const gaps: string[] = [];
  for (const milestone of project.milestones) {
    if ((milestone.documents ?? []).length > 0) {
      gaps.push(
        `ordinary PBL milestone "${milestone.title}" has hidden documents; inline any required primer, sample data, or starter content in visible milestone/microtask text instead`,
      );
    }
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Tools (Zod-validated, share the same mutable `project`)
// ---------------------------------------------------------------------------

export function newId(prefix: string): string {
  // Short, collision-resistant (12 hex chars). Avoids pulling in
  // `nanoid` here so the planner stays dependency-free.
  return (
    prefix + '_' + Math.random().toString(16).slice(2, 8) + Math.random().toString(16).slice(2, 8)
  );
}

export function instructorProjectAnchor(project: PBLProjectV2): string {
  // Internal meta-instruction appended to the Instructor's system prompt. It is
  // written in English (the model follows it regardless of content language);
  // the embedded title / description are already in the project's content
  // language, and the Instructor answers the learner in that language per its
  // own language rule. No locale branching here.
  return [
    `You are the Instructor for THIS PBL project.`,
    `Project title: ${project.title}`,
    `Project description: ${project.description}`,
    project.learningObjective ? `Learning objective: ${project.learningObjective}` : '',
    'If the learner asks what project they are doing, answer directly from this information, in the project content language. Never say you do not know the project, and never ask them what project they want to do unless the project title and description are empty.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Apply the Planner's chosen proficiency tier onto the project, honoring
 * the explicit-self-report lock and re-seating the adaptive assessment so
 * score/counters stay consistent. Mirrors the decision logic inside the
 * loop's `set_project_info` tool, factored out for the single-call planner.
 *
 * When the learner explicitly stated their level, that lock wins: the
 * project is coerced to the locked tier regardless of the LLM's pick.
 */
export function applyPlannerProficiency(
  project: PBLProjectV2,
  proficiency: 'beginner' | 'intermediate' | 'advanced',
): void {
  const assessment = project.proficiencyAssessment;
  const explicitTierLocked = assessment?.signals[0]?.kind === 'user_level_explicit';
  const effectiveProficiency: PBLProficiency =
    explicitTierLocked && assessment ? assessment.tier : proficiency;

  if (assessment && assessment.tier !== effectiveProficiency) {
    log.info(
      `Planner LLM overrode initial proficiency: engine=${assessment.tier} → llm=${effectiveProficiency}`,
    );
    project.proficiencyAssessment = reseatAssessmentTier(
      assessment,
      effectiveProficiency,
      'planner',
    );
  }
  project.proficiency = effectiveProficiency;
}

function buildTools(
  project: PBLProjectV2,
  input: PBLPlannerV2Input,
  scenarioRoleplay: boolean,
  callbacks?: PlannerV2Callbacks,
) {
  // Track whether `set_project_info` has fired so we can require it
  // before downstream tools. The LLM should call them in order
  // anyway (the prompt says so), but we enforce server-side for
  // robustness.
  let projectInfoSet = false;
  let instructorRoleAdded = false;
  let milestoneIndex = 0;
  // SCENARIO ONLY. Whether `set_scenario` has fired. Always false for
  // ordinary PBL projects (the tool isn't even registered).
  let scenarioSet = false;

  // SCENARIO ONLY schema extensions. For ordinary PBL projects the
  // milestone / microtask input schemas below are byte-identical to
  // before (none of these params are exposed to the model).
  const milestoneScenarioStageField = scenarioRoleplay
    ? {
        scenarioStage: z
          .enum(['prep', 'roleplay', 'wrapup'])
          .optional()
          .describe(
            "SCENARIO ONLY. The milestone's role in the fixed three-stage skeleton: 'prep' = FIRST milestone (Instructor introduces the premise + cast, no assessment); 'roleplay' = an immersive role-play stage (one or more, in the middle); 'wrapup' = LAST milestone (Instructor light feedback). Order MUST be prep → roleplay(s) → wrapup.",
          ),
      }
    : {};
  const microtaskSceneFields = scenarioRoleplay
    ? {
        completionCriteria: z
          .string()
          .optional()
          .describe(
            "SCENARIO ONLY (scene beats). A concrete, observable condition that advances this beat. Only for microtasks under a `scenarioStage:'roleplay'` milestone.",
          ),
        successWhen: z
          .string()
          .optional()
          .describe(
            'SCENARIO ONLY (scene beats). The CONCRETE, OBSERVABLE in-scene action the learner must SAY or DO for this beat to count as done — the scenario\'s "deliverable" (e.g. "下注、加注或弃牌" / "对对方的感受做出共情回应，并问一个跟进问题"). Plain scene terms, NOT a teaching goal. This is what the advance detector watches, so small-talk / off-topic turns do NOT advance. Author one for EVERY roleplay beat.',
          ),
        characterObjective: z
          .string()
          .optional()
          .describe(
            'SCENARIO ONLY (scene beats). What the character PRIVATELY wants this beat — their in-scene drive (e.g. "试探对方是否在虚张声势" / "想知道你是否真的在乎"). Gives the character a goal to pursue in character. NEVER narrated, evaluated, or coached. Recommended for every roleplay beat.',
          ),
        skillFocus: z
          .string()
          .optional()
          .describe(
            'SCENARIO ONLY (scene beats). The single skill this beat practises (e.g. "底池赔率判断" / "积极倾听"). Surfaced to the learner (current-task panel + end-of-project per-act review); never spoken by the character.',
          ),
        narration: z
          .string()
          .optional()
          .describe(
            'SCENARIO ONLY (scene beats). Neutral system narration shown when this beat opens (e.g. "you walk into a quiet café"). Not spoken by a character or the Instructor. Omit if no narration.',
          ),
      }
    : {};

  const baseTools = {
    /** Set the top-level project info. Must be called exactly once
     *  before any other tool. */
    set_project_info: tool({
      description:
        'Set the project title, description, learning objective, learner gains, and proficiency tier. Call this exactly once, before any other tool. ALL TEXT FIELDS must be written in the project language declared in the system prompt (Hard rule 1), and title/description/learningObjective/gains must derive directly from the outline\'s project topic — do NOT substitute a different "common teaching project" from your training data.',
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .describe(
            'Concise, memorable project title — IN THE PROJECT LANGUAGE; must match the outline.pblConfig.projectTopic theme exactly (no topic substitution).',
          ),
        description: z
          .string()
          .min(1)
          .describe(
            '2-4 sentence description of what the student will build — IN THE PROJECT LANGUAGE; must be about the outline.pblConfig.projectTopic, not a different example project.',
          ),
        learningObjective: z
          .string()
          .describe(
            'The specific verb/skill the student will master, IN THE PROJECT LANGUAGE. Distinct from `description` (which is what they BUILD).',
          ),
        gains: z
          .array(z.string().min(1))
          .min(3)
          .max(5)
          .describe(
            'A SHORT list (3-5) of learner-facing "what you\'ll gain" statements shown on the project Hero, IN THE PROJECT LANGUAGE. Each names ONE ability, awareness, or piece of knowledge the learner BUILDS by working through the project — what they take away and can do afterwards — NOT the final deliverable/result the project produces (that is `description`). Write each as a readable competency phrase, typically by expanding one terse outline targetSkill into plain language (e.g. for 博弈论: "理解纳什均衡的含义并能在具体场景中求解", "学会用收益矩阵刻画双方策略与收益", "培养把现实冲突抽象成博弈模型的建模意识"). NOT a task title, NOT a single terse keyword, NOT the project\'s end product. They must match THIS project.',
          ),
        proficiency: z
          .enum(['beginner', 'intermediate', 'advanced'])
          .describe('Inferred from outline context: how much prior knowledge to assume.'),
      }),
      execute: async ({ title, description, learningObjective, gains, proficiency }) => {
        if (projectInfoSet) {
          return {
            ok: false,
            error: 'set_project_info was already called; it must only fire once.',
          };
        }
        project.title = title;
        project.description = description;
        project.learningObjective = learningObjective;
        project.gains = gains;
        // If the learner explicitly stated their level in the course
        // request/profile ("我是零基础", "I'm advanced", etc.), the
        // deterministic detector is authoritative. The Planner may
        // adapt project shape, but it cannot override that explicit
        // self-report.
        const explicitTierLocked =
          project.proficiencyAssessment?.signals[0]?.kind === 'user_level_explicit';
        if (explicitTierLocked && proficiency !== project.proficiencyAssessment!.tier) {
          return {
            ok: false,
            error: `The learner explicitly stated their level as ${project.proficiencyAssessment!.tier}. Call set_project_info again with proficiency="${project.proficiencyAssessment!.tier}".`,
          };
        }
        const effectiveProficiency = explicitTierLocked
          ? project.proficiencyAssessment!.tier
          : proficiency;

        // Log divergence from the platform's adaptive engine but
        // accept the LLM's choice when there was no explicit learner
        // self-report. Re-seat the whole assessment onto the chosen tier
        // (not just `tier`) so score/counters stay consistent — otherwise a
        // stale score later rebounds the learner back toward the engine's
        // estimate once the dynamic retier gates clear (see reseatAssessmentTier).
        if (
          project.proficiencyAssessment &&
          project.proficiencyAssessment.tier !== effectiveProficiency
        ) {
          log.info(
            `Planner LLM overrode initial proficiency: engine=${project.proficiencyAssessment.tier} → llm=${effectiveProficiency}`,
          );
          project.proficiencyAssessment = reseatAssessmentTier(
            project.proficiencyAssessment,
            effectiveProficiency,
            'planner',
          );
        }
        project.proficiency = effectiveProficiency;
        project.updatedAt = new Date().toISOString();
        projectInfoSet = true;
        callbacks?.onProgress?.({ kind: 'project_info', title });
        return { ok: true, title };
      },
    }),

    /** Add a role. The product currently ships a single Instructor.
     *  The tool refuses any other role type at the boundary so the v2
     *  project never gets half-populated with un-wired roles. */
    add_role: tool({
      description:
        'Add a role for the project. Call exactly once with type=instructor. Do not create any other role type.',
      inputSchema: z.object({
        type: z.enum(['instructor', 'user']),
        name: z.string().min(1),
        description: z
          .string()
          .optional()
          .describe(
            "SHORT learner-facing intro shown as a hover tooltip on the instructor's avatar. 2-3 short sentences MAX, in the project language, written TO the learner: who the guide is (use the name), that they accompany you through the whole project and each task, that you can ask them anything anytime, and that they give feedback / check your understanding along the way. Keep it warm and specific to THIS project. Do NOT expose internal mechanics (reading history, tool calls, evaluation / scoring, advancing tasks) — only what is meaningful and reassuring to a learner.",
          ),
        systemPrompt: z.string().optional(),
      }),
      execute: async ({ type, name, description, systemPrompt }) => {
        if (!projectInfoSet) {
          return {
            ok: false,
            error: 'Call set_project_info first.',
          };
        }
        if (type === 'instructor' && instructorRoleAdded) {
          return {
            ok: false,
            error: 'Instructor role already exists; only one Instructor allowed.',
          };
        }
        if (type !== 'instructor') {
          // Only the Instructor is wired. Refuse any other role type at
          // the boundary so the v2 project never gets a half-populated,
          // un-rendered role.
          return {
            ok: false,
            error: `Role type "${type}" is not supported. Only type=instructor is accepted.`,
          };
        }
        const anchoredSystemPrompt = [systemPrompt, instructorProjectAnchor(project)]
          .filter(Boolean)
          .join('\n\n');
        const role: PBLRole = {
          id: newId('role'),
          type,
          name,
          description,
          systemPrompt: anchoredSystemPrompt,
        };
        project.roles.push(role);
        project.updatedAt = new Date().toISOString();
        instructorRoleAdded = true;
        callbacks?.onProgress?.({ kind: 'role', roleType: type, name });
        return { ok: true, roleId: role.id };
      },
    }),

    /** Add a milestone. Returns its ID for use in add_microtask.
     *  The first milestone added becomes ACTIVE so the
     *  student lands in a runnable state. */
    add_milestone: tool({
      description:
        'Add a milestone (major phase). Provide a title, short description, and the three Instructor scripts: briefing, completionCriteria, debrief.',
      inputSchema: z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        briefing: z
          .string()
          .min(1)
          .describe(
            'Written in Instructor voice, second person — what the Instructor will say at the start of this milestone.',
          ),
        completionCriteria: z
          .string()
          .min(1)
          .describe('How the Instructor will know the student is done with this milestone.'),
        debrief: z
          .string()
          .min(1)
          .describe(
            'Written in Instructor voice — what the Instructor will say at the end of this milestone.',
          ),
        coreConcept: z
          .string()
          .optional()
          .describe(
            'Set this ONLY for the 1-2 stages that carry the project\'s CORE knowledge point. A short description (in the project language) of the central concept this stage teaches — e.g. "为什么循环能避免重复代码". When set, the Instructor runs ONE integrative reverse-question about this concept at the end of the stage. Leave UNSET for ordinary / setup / polish stages so learners are not over-questioned. (For SCENARIO projects, never set this — see scenario mode.)',
          ),
        ...milestoneScenarioStageField,
      }),
      execute: async (args) => {
        if (!instructorRoleAdded) {
          return {
            ok: false,
            error: 'Call add_role for the Instructor before adding milestones.',
          };
        }
        const coreConcept = args.coreConcept?.trim();
        // SCENARIO ONLY. Only honour `scenarioStage` for scenario
        // projects; the field isn't even exposed to ordinary projects'
        // Planner.
        const scenarioStage = scenarioRoleplay
          ? (args as { scenarioStage?: 'prep' | 'roleplay' | 'wrapup' }).scenarioStage
          : undefined;
        const milestone: PBLMilestone = {
          id: newId('ms'),
          title: args.title,
          description: args.description,
          status: project.milestones.length === 0 ? 'active' : 'locked',
          order: milestoneIndex++,
          microtasks: [],
          briefing: args.briefing,
          completionCriteria: args.completionCriteria,
          debrief: args.debrief,
          ...(coreConcept ? { synthesisCheck: { coreConcept } } : {}),
          ...(scenarioStage ? { scenarioStage } : {}),
        };
        project.milestones.push(milestone);
        project.updatedAt = new Date().toISOString();
        callbacks?.onProgress?.({
          kind: 'milestone',
          title: args.title,
          index: milestone.order,
        });
        return { ok: true, milestoneId: milestone.id };
      },
    }),

    /** Add a microtask under a milestone. Order is auto-assigned
     *  unless `order` is given. */
    add_microtask: tool({
      description:
        'Add a microtask under a milestone. Each microtask must be specific and actionable.',
      inputSchema: z.object({
        milestoneId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        hints: z
          .array(z.string())
          .max(5)
          .optional()
          .describe('1-3 concrete hints the Instructor can offer.'),
        order: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Position within the milestone. Auto-assigned if absent.'),
        ...microtaskSceneFields,
      }),
      execute: async (args) => {
        const milestone = project.milestones.find((m) => m.id === args.milestoneId);
        if (!milestone) {
          return {
            ok: false,
            error: `Milestone "${args.milestoneId}" not found. Call add_milestone first.`,
          };
        }
        const order = args.order ?? milestone.microtasks.length;
        // SCENARIO ONLY. Beat fields are only exposed/honoured for
        // scenario projects; ordinary microtasks never carry them.
        const sceneArgs = args as {
          completionCriteria?: string;
          successWhen?: string;
          characterObjective?: string;
          skillFocus?: string;
          narration?: string;
        };
        const beatCriteria = scenarioRoleplay ? sceneArgs.completionCriteria?.trim() : undefined;
        const beatSuccessWhen = scenarioRoleplay ? sceneArgs.successWhen?.trim() : undefined;
        const beatObjective = scenarioRoleplay ? sceneArgs.characterObjective?.trim() : undefined;
        const beatSkill = scenarioRoleplay ? sceneArgs.skillFocus?.trim() : undefined;
        const beatNarration = scenarioRoleplay ? sceneArgs.narration?.trim() : undefined;
        const microtask: PBLMicrotask = {
          id: newId('mt'),
          title: args.title,
          description: args.description,
          status: 'todo',
          // Collaborator was removed from the product — every microtask
          // is learner-owned.
          assignee: 'user',
          hints: args.hints ?? [],
          order,
          ...(beatCriteria ? { completionCriteria: beatCriteria } : {}),
          ...(beatSuccessWhen ? { successWhen: beatSuccessWhen } : {}),
          ...(beatObjective ? { characterObjective: beatObjective } : {}),
          ...(beatSkill ? { skillFocus: beatSkill } : {}),
          ...(beatNarration ? { narration: beatNarration } : {}),
        };
        milestone.microtasks.push(microtask);
        project.updatedAt = new Date().toISOString();
        callbacks?.onProgress?.({
          kind: 'microtask',
          milestoneTitle: milestone.title,
          title: args.title,
          index: order,
        });
        return { ok: true, microtaskId: microtask.id };
      },
    }),

    /** Signal that design is complete. The Planner *must* call this
     *  at the very end. We validate here before the SDK loop is
     *  allowed to stop, so an early / partial completion attempt is
     *  rejected and fed back to the model as concrete gaps instead of
     *  falling out to the v1 generator. */
    mark_design_complete: tool({
      description:
        'Call this exactly once at the very end, after every milestone, microtask, and role has been added. Signals the design is complete.',
      inputSchema: z.object({}),
      execute: async (): Promise<PlannerCompletionToolResult> => {
        const gaps = plannerCompletionGaps(project, { scenarioRoleplay });
        if (gaps.length > 0) {
          return {
            ok: false,
            gaps,
            nextAction: plannerCompletionNextAction(project, { scenarioRoleplay }),
          };
        }

        // Bootstrap a single Instructor thread so PR 4 (Workspace)
        // has a stable thread to render from. The Instructor's
        // opening message is added later, by /api/pbl/v2/open-task
        // GREETING — we just create the empty container here.
        const instructor = project.roles.find((r) => r.type === 'instructor');
        if (instructor && !project.threads.some((t) => t.agentId === instructor.id)) {
          project.threads.push({
            agentId: instructor.id,
            messages: [],
          });
        }
        project.status = 'active';
        project.uiPhase = 'hero';
        project.updatedAt = new Date().toISOString();

        const microtaskCount = project.milestones.reduce((acc, m) => acc + m.microtasks.length, 0);
        callbacks?.onProgress?.({
          kind: 'complete',
          milestoneCount: project.milestones.length,
          microtaskCount,
        });
        return { ok: true };
      },
    }),
  };

  // Ordinary PBL projects: tool surface is byte-identical to before.
  if (!scenarioRoleplay) return baseTools;

  // SCENARIO ONLY. Register the cast-authoring tool. Defines
  // `project.scenario` (the single gate) + stamps `schemaVersion`.
  const set_scenario = tool({
    description:
      'SCENARIO ONLY. Define the role-play scenario: the concrete premise (setting), optional learning goal, optional rules + learner role, and the cast. Call exactly once, right after set_project_info and before any add_milestone. Required for scenario projects.',
    inputSchema: z.object({
      setting: z
        .string()
        .min(1)
        .describe('The concrete overall premise / what is going on, in the project language.'),
      goal: z
        .string()
        .optional()
        .describe('What the learner is practising (used by wrapup / completion page).'),
      rules: z
        .string()
        .optional()
        .describe(
          'Rules / structure the learner must be told before the scene (games / interviews / debates). Omit for free emotional scenarios.',
        ),
      learnerRole: z
        .string()
        .optional()
        .describe(
          'The learner\'s OWN role / position (e.g. "you are their close friend" / "you are the 5th player, on the button").',
        ),
      characters: z
        .array(
          z.object({
            name: z.string().min(1).describe('Character name, in the project language.'),
            persona: z
              .string()
              .min(1)
              .describe(
                'Stable identity / relationship to the learner / personality / speaking style. In the project language.',
              ),
            situation: z
              .string()
              .min(1)
              .describe(
                'This character\'s CONCRETE current circumstance the learner faces (e.g. "just broke up, low mood, says they\'re fine but aren\'t"; game: "sits under-the-gun, plays tight"). In the project language. Required — it is the premise the Instructor introduces and is shown to the learner up front. Include ONLY what the learner knows/sees at the start; never put in here a fact a later roleplay beat is meant to make them discover (put that in that beat\'s characterObjective).',
              ),
            boundaries: z
              .string()
              .optional()
              .describe(
                'Hard safety rails: what the character must never say or do. Strongly recommended.',
              ),
            openingLine: z
              .string()
              .optional()
              .describe("The character's first line when the scene opens (optional)."),
          }),
        )
        .min(1)
        .describe(
          'The cast — EXACTLY ONE character (this version voices a single counterpart throughout).',
        ),
    }),
    execute: async (args) => {
      if (!projectInfoSet) {
        return { ok: false, error: 'Call set_project_info first.' };
      }
      if (scenarioSet) {
        return {
          ok: false,
          error: 'set_scenario was already called; it must only fire once.',
        };
      }
      const scenario: PBLScenarioConfig = {
        setting: args.setting,
        ...(args.goal?.trim() ? { goal: args.goal.trim() } : {}),
        ...(args.rules?.trim() ? { rules: args.rules.trim() } : {}),
        ...(args.learnerRole?.trim() ? { learnerRole: args.learnerRole.trim() } : {}),
        // HARD CONSTRAINT: single character only (runtime voices characters[0]).
        // Deterministically keep the first even if the model produced more.
        characters: args.characters.slice(0, 1).map((c) => ({
          id: newId('char'),
          name: c.name,
          persona: c.persona,
          ...(c.situation?.trim() ? { situation: c.situation.trim() } : {}),
          ...(c.boundaries?.trim() ? { boundaries: c.boundaries.trim() } : {}),
          ...(c.openingLine?.trim() ? { openingLine: c.openingLine.trim() } : {}),
        })),
      };
      project.scenario = scenario;
      // Stamp the packaged-format version so future migrations have a
      // marker (absent = baseline / non-scenario).
      project.schemaVersion = SCENARIO_SCHEMA_VERSION;
      project.updatedAt = new Date().toISOString();
      scenarioSet = true;
      return { ok: true, characterCount: scenario.characters.length };
    },
  });

  const set_scene_visual = tool({
    description:
      'SCENARIO ONLY. Define ONE project-wide scene VISUAL for the role-play entrance animation + banner. Call ONCE, AFTER you have authored every roleplay milestone/beat, basing it on an understanding of ALL of them so it fits the WHOLE project — a single shared place/atmosphere that suits every roleplay stage (never just one stage). Purely cosmetic.',
    inputSchema: z.object({
      caption: z
        .string()
        .min(1)
        .describe(
          'A short scene phrase IN THE PROJECT LANGUAGE that fits ALL roleplay stages — the shared place/atmosphere (e.g. "深夜，各自房间隔着手机聊到天亮" / "决赛辩论赛场" / "牌桌现金局"). Keep it under ~16 words. Derive it from the actual stages/tasks, not a guessed category.',
        ),
      bg1: z.string().describe('Background gradient TOP colour as a hex code (e.g. "#3a2740").'),
      bg2: z.string().describe('Background gradient BOTTOM colour as a hex code.'),
      accent: z
        .string()
        .describe('Accent colour (hex) for glows / motifs; must read clearly on the background.'),
      motifs: z
        .array(z.string())
        .min(1)
        .max(4)
        .describe(
          '2–4 EMOJI that evoke THIS exact scene (e.g. ["📱","🌙","🛏️"] for a late-night phone chat; ["🃏","♠️","🪙"] for poker; ["🎤","📣"] for a debate). Choose the ones that best fit this project, not a generic set.',
        ),
    }),
    execute: async (args) => {
      if (!project.scenario) {
        return { ok: false, error: 'Call set_scenario before set_scene_visual.' };
      }
      const hex = (s: string | undefined) =>
        s && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.trim()) ? s.trim() : undefined;
      const motifs = (args.motifs ?? [])
        .map((m) => m.trim())
        .filter(Boolean)
        .slice(0, 4);
      project.scenario.sceneVisual = {
        ...(args.caption?.trim() ? { caption: args.caption.trim() } : {}),
        ...(hex(args.bg1) ? { bg1: hex(args.bg1) } : {}),
        ...(hex(args.bg2) ? { bg2: hex(args.bg2) } : {}),
        ...(hex(args.accent) ? { accent: hex(args.accent) } : {}),
        ...(motifs.length ? { motifs } : {}),
      };
      project.updatedAt = new Date().toISOString();
      return { ok: true };
    },
  });

  return { ...baseTools, set_scenario, set_scene_visual };
}

// ---------------------------------------------------------------------------
// Post-loop validation
// ---------------------------------------------------------------------------

type PlannerCompletionToolResult = { ok: true } | { ok: false; gaps: string[]; nextAction: string };

export function plannerCompletionGaps(
  project: PBLProjectV2,
  opts?: { scenarioRoleplay?: boolean },
): string[] {
  const errors: string[] = [];
  if (!project.title) errors.push('title is empty');
  if (!project.description) errors.push('description is empty');
  if (!project.roles.some((r) => r.type === 'instructor')) {
    errors.push('no Instructor role');
  }
  if (project.milestones.length === 0) {
    errors.push('no milestones');
  }
  for (const m of project.milestones) {
    if (m.microtasks.length === 0) {
      errors.push(`milestone "${m.title}" has no microtasks`);
    }
  }
  if (!opts?.scenarioRoleplay) {
    errors.push(...ordinaryPBLTextOnlyGaps(project));
  }
  // SCENARIO ONLY. When scenario mode was requested, the design must be
  // a coherent role-play scenario: a full cast + the fixed three-stage
  // skeleton (prep → roleplay(s) → wrapup). These checks never fire for
  // ordinary projects (opts.scenarioRoleplay falsy).
  if (opts?.scenarioRoleplay) {
    if (!project.scenario) {
      errors.push('scenario project but set_scenario was never called');
    } else {
      const characters = project.scenario.characters ?? [];
      if (characters.length === 0) {
        errors.push('scenario has no characters (set_scenario needs at least one character)');
      } else {
        characters.forEach((c, i) => {
          if (!c?.name?.trim() || !c?.persona?.trim() || !c?.situation?.trim()) {
            errors.push(`scenario character #${i + 1} is missing name, persona, or situation`);
          }
        });
      }
    }
    // Fixed three-stage skeleton: first 'prep', last 'wrapup', ≥1 'roleplay'.
    const stages = project.milestones.map((m) => m.scenarioStage);
    const roleplayCount = stages.filter((s) => s === 'roleplay').length;
    if (project.milestones.length < 3) {
      errors.push(
        'scenario project needs the three-stage skeleton: a prep stage, at least one roleplay stage, and a wrapup stage',
      );
    }
    if (stages[0] !== 'prep') {
      errors.push('scenario project: the FIRST milestone must be scenarioStage:"prep"');
    }
    if (stages[stages.length - 1] !== 'wrapup') {
      errors.push('scenario project: the LAST milestone must be scenarioStage:"wrapup"');
    }
    if (roleplayCount === 0) {
      errors.push('scenario project: needs at least one scenarioStage:"roleplay" milestone');
    }
    // The project-wide scene visual must be authored (caption + ≥1 emoji
    // motif) so the entrance animation / banner fits this exact project.
    const sv = project.scenario?.sceneVisual;
    if (!sv?.caption?.trim() || (sv?.motifs?.length ?? 0) === 0) {
      errors.push(
        'scenario project: call set_scene_visual once (a project-wide caption + 2–4 fitting emoji motifs + colours) AFTER authoring the roleplay stages',
      );
    }
  }
  return errors;
}

function plannerCompletionNextAction(
  project: PBLProjectV2,
  opts?: { scenarioRoleplay?: boolean },
): string {
  if (!project.title || !project.description) {
    return 'Call set_project_info with the requested project topic, description, and learning objective.';
  }
  // SCENARIO ONLY. Steer the model to author the scenario before the
  // generic milestone gaps (set_scenario comes right after set_info).
  if (opts?.scenarioRoleplay && !project.scenario) {
    return 'Call set_scenario with the setting and at least one character (name + persona + situation) before adding milestones.';
  }
  if (!project.roles.some((r) => r.type === 'instructor')) {
    return 'Call add_role with type="instructor" before adding milestones.';
  }
  if (project.milestones.length === 0) {
    return 'Call add_milestone to create the first project phase.';
  }

  const milestoneWithoutTasks = project.milestones.find((m) => m.microtasks.length === 0);
  if (milestoneWithoutTasks) {
    return `Call add_microtask for milestoneId="${milestoneWithoutTasks.id}" before trying mark_design_complete again.`;
  }

  if (opts?.scenarioRoleplay) {
    const stages = project.milestones.map((m) => m.scenarioStage);
    if (stages[0] !== 'prep') {
      return 'Make the FIRST milestone scenarioStage:"prep" (Instructor introduces the premise + cast, one light microtask, no assessment).';
    }
    if (!stages.includes('roleplay')) {
      return 'Add at least one scenarioStage:"roleplay" milestone (the immersive role-play) before the wrapup.';
    }
    if (stages[stages.length - 1] !== 'wrapup') {
      return 'Make the LAST milestone scenarioStage:"wrapup" (Instructor light feedback, one light microtask).';
    }
  }

  return 'Fix the reported gaps, then call mark_design_complete again.';
}

function isAcceptedPlannerCompletion(output: unknown): output is { ok: true } {
  return (
    typeof output === 'object' &&
    output !== null &&
    'ok' in output &&
    (output as { ok?: unknown }).ok === true
  );
}

export function plannerStepHasAcceptedCompletion(step: StepResult<ToolSet>): boolean {
  return step.toolResults.some(
    (result) =>
      result.toolName === 'mark_design_complete' && isAcceptedPlannerCompletion(result.output),
  );
}

function plannerDesignAccepted(): StopCondition<ToolSet> {
  return ({ steps }) => steps.some(plannerStepHasAcceptedCompletion);
}

function validateProject(project: PBLProjectV2, scenarioRoleplay = false): void {
  const errors = plannerCompletionGaps(project, { scenarioRoleplay });
  if (errors.length > 0) {
    throw new PlannerV2Error(`Planner v2 output failed validation: ${errors.join('; ')}`, project);
  }
}

// ---------------------------------------------------------------------------
// Stage-synthesis normalization (deterministic "not too many / not too few")
// ---------------------------------------------------------------------------

/** Hard cap on how many stages may carry a `synthesisCheck`. The
 *  integrative stage-end reverse-question is meant for the 1-2 stages
 *  that hold the project's core knowledge; more than that re-introduces
 *  the over-questioning failure mode. */
export const MAX_SYNTHESIS_STAGES = 2;

/** Tokenize text into latin words (len ≥ 2) + CJK bigrams for a cheap,
 *  language-agnostic relevance overlap. Deterministic. */
function conceptTokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = (text ?? '').toLowerCase();
  for (const w of lower.match(/[a-z0-9]{2,}/g) ?? []) out.add(w);
  const cjk = lower.match(/[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk[i] + cjk[i + 1]);
  return out;
}

/** Count how many of `refTokens` appear in `text`. */
function overlapScore(text: string, refTokens: Set<string>): number {
  if (refTokens.size === 0) return 0;
  const t = conceptTokens(text);
  let score = 0;
  for (const tok of refTokens) if (t.has(tok)) score++;
  return score;
}

/**
 * Deterministically enforce "1-2 core stages get a synthesisCheck":
 *  - If the Planner over-flagged (> MAX), keep the MAX most relevant to
 *    the learning objective / project and drop `synthesisCheck` from
 *    the rest.
 *  - If the Planner flagged none, pick the single stage most aligned
 *    with the learning objective (avoiding the very first setup stage
 *    when there are ≥ 3 stages) and synthesise a `coreConcept` from the
 *    learning objective / that stage. This turns the "not too many /
 *    not too few" guarantee from a prompt hope into code.
 *
 * Exported for unit tests.
 */
export function normalizeSynthesisChecks(project: PBLProjectV2): void {
  // SCENARIO ONLY exemption. Role-play scenario projects never carry a
  // synthesisCheck on any stage (the integrative reflection is the light
  // wrapup stage, not a mid-scenario reverse-question). Skip entirely so
  // we never auto-attach one to a prep/roleplay/wrapup milestone.
  if (project.scenario) return;
  if (project.milestones.length === 0) return;
  const refTokens = conceptTokens(
    `${project.learningObjective ?? ''} ${project.title} ${project.description}`,
  );
  const flagged = project.milestones.filter((m) => m.synthesisCheck);

  if (flagged.length > MAX_SYNTHESIS_STAGES) {
    const ranked = flagged
      .map((m) => ({
        m,
        score: overlapScore(
          `${m.title} ${m.description ?? ''} ${m.synthesisCheck?.coreConcept ?? ''}`,
          refTokens,
        ),
      }))
      .sort((a, b) => b.score - a.score || a.m.order - b.m.order);
    for (const { m } of ranked.slice(MAX_SYNTHESIS_STAGES)) {
      delete m.synthesisCheck;
    }
    return;
  }

  if (flagged.length === 0) {
    const ordered = project.milestones.slice().sort((a, b) => a.order - b.order);
    const ranked = ordered
      .map((m) => ({ m, score: overlapScore(`${m.title} ${m.description ?? ''}`, refTokens) }))
      .sort((a, b) => b.score - a.score || a.m.order - b.m.order);
    let pick = ranked[0]?.m;
    // When nothing aligns (all-zero overlap), avoid the first stage
    // (usually setup) and the last (usually polish): take the median.
    if ((!pick || ranked[0].score === 0) && ordered.length >= 3) {
      pick = ordered[Math.floor(ordered.length / 2)];
    }
    if (pick) {
      const coreConcept = (
        project.learningObjective?.trim() ||
        pick.description?.trim() ||
        pick.title
      ).slice(0, 120);
      pick.synthesisCheck = { coreConcept };
    }
  }
}
