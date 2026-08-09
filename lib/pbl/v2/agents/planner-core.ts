/**
 * PBL v2 — shared planner core.
 *
 * Pure project construction, prompt assembly, completion validation, and
 * deterministic normalization shared by both planner call strategies. This
 * module deliberately has no AI SDK, schema-library, or app LLM entry import.
 */

import { createLogger } from '@/lib/logger';
import { loadPBLV2Prompt } from '../prompts/loader';
import { computeInitialAssessment, reseatAssessmentTier } from '../operations/kernel/proficiency';
import { trimmedPBLText } from '../readers';

import type { PBLProjectV2, PBLPlannerV2Input, PBLProficiency, PBLRole } from '../types';

const log = createLogger('PBL v2 Planner');

/** SCENARIO ONLY. Packaged-format version stamped on scenario projects
 *  (`project.schemaVersion`). Absent on ordinary projects (baseline).
 *  Bump when the packaged scenario format changes so loaders can
 *  migrate. */
export const SCENARIO_SCHEMA_VERSION = 1;

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
// Empty / starter shape
// ---------------------------------------------------------------------------

export function emptyProject(input: PBLPlannerV2Input): PBLProjectV2 {
  const now = new Date().toISOString();

  // Compute the planner-time initial proficiency assessment from
  // static signals (outline keywords + prior-scene difficulty + user
  // bio). Quiz accuracy is not yet available — that's folded in at
  // Hero entry by the pre-play recalibration path.
  //
  // See `lib/pbl/v2/operations/kernel/proficiency.ts` for the full algorithm
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

function formatCourseContext(input: PBLPlannerV2Input): string {
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

function ordinaryPBLTextOnlyGaps(project: PBLProjectV2): string[] {
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

// ---------------------------------------------------------------------------
// Completion validation
// ---------------------------------------------------------------------------

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
          if (
            !trimmedPBLText(c?.name) ||
            !trimmedPBLText(c?.persona) ||
            !trimmedPBLText(c?.situation)
          ) {
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
    if (!trimmedPBLText(sv?.caption) || (sv?.motifs?.length ?? 0) === 0) {
      errors.push(
        'scenario project: call set_scene_visual once (a project-wide caption + 2–4 fitting emoji motifs + colours) AFTER authoring the roleplay stages',
      );
    }
  }
  return errors;
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
        trimmedPBLText(project.learningObjective) ||
        trimmedPBLText(pick.description) ||
        trimmedPBLText(pick.title)
      ).slice(0, 120);
      pick.synthesisCheck = { coreConcept };
    }
  }
}
