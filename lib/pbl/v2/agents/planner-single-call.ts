/**
 * PBL v2 — Single-call Planner
 *
 * A single-shot alternative to the agentic tool-calling loop in
 * `./planner.ts`. The LLM is asked to emit ONE JSON object describing the
 * whole project (mirroring the slide-content generation pattern:
 * `callLLM` with no tools → `parseJsonResponse` → deterministic
 * post-processing). The same `PBLProjectV2` is produced, so this is a
 * drop-in replacement for `generatePBLV2Project`.
 *
 * Why: the loop needs ~20-40 ordered, mutually-gated tool calls to
 * succeed; any stall, stray narrative turn, or skipped
 * `mark_design_complete` aborts the whole run. A single structured
 * output collapses that failure surface to one call + one JSON parse.
 *
 * All the deterministic hydration (ids / status / order / assignee /
 * thread bootstrap / proficiency re-seat) and post-processing
 * (`normalizeProjectRuntime`, `normalizeSynthesisChecks`, completion
 * gate) is shared with the loop via exported helpers in `./planner.ts`.
 */

import type { LanguageModel } from 'ai';

import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { normalizeProjectRuntime, normalizeScenario } from '../operations/progress';
import type { ThinkingConfig } from '@/lib/types/provider';

import {
  PlannerV2Error,
  SCENARIO_SCHEMA_VERSION,
  emptyProject,
  buildPlannerSystemPrompt,
  newId,
  instructorProjectAnchor,
  applyPlannerProficiency,
  normalizeSynthesisChecks,
  plannerCompletionGaps,
  type PlannerV2Callbacks,
} from './planner';

import type {
  PBLProjectV2,
  PBLPlannerV2Input,
  PBLMilestone,
  PBLMicrotask,
  PBLRole,
  PBLScenarioConfig,
  PBLScenarioCharacter,
  PBLSceneVisual,
} from '../types';

const log = createLogger('PBL v2 Planner (single-call)');

const SINGLE_CALL_PROMPT = 'planner-single-call-system';
const SCENARIO_PROMPT = 'planner-scenario-single-call-system';

function buildSingleCallUserPrompt(scenarioRoleplay: boolean): string {
  const sharedChecklist = [
    'projectInfo has non-empty title, description, learningObjective, 3-5 gains, and the exact requested proficiency',
    'instructorRole.name is non-empty',
    'milestones is a non-empty array',
    'every milestone has title, briefing, completionCriteria, debrief, and at least one microtask',
    'every microtask has a non-empty title',
  ];
  const scenarioChecklist = scenarioRoleplay
    ? [
        'scenario exists with setting, at least one character (name/persona/situation), and sceneVisual.caption plus emoji motifs',
        'milestones follow the exact skeleton: first scenarioStage "prep", last "wrapup", and at least one middle "roleplay"',
        'every roleplay microtask has non-empty successWhen',
      ]
    : [];
  const checklist = [...sharedChecklist, ...scenarioChecklist]
    .map((item) => `- ${item}`)
    .join('\n');

  return [
    'Design the PBL project now. Output the single JSON object described in the system prompt — no prose, no code fences.',
    '',
    'Before output, verify it passes this exact structural validator:',
    checklist,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// LLM output shape
// ---------------------------------------------------------------------------

/** The JSON object the single LLM call must produce. Only the fields the
 *  model actually decides — ids / status / order / assignee / timestamps /
 *  threads are all assigned by code during hydration. Milestones nest
 *  their microtasks (no milestoneId references needed). */
interface PlannerLLMOutput {
  projectInfo?: {
    title?: string;
    description?: string;
    learningObjective?: string;
    gains?: string[];
    proficiency?: 'beginner' | 'intermediate' | 'advanced';
  };
  instructorRole?: {
    name?: string;
    description?: string;
    systemPrompt?: string;
  };
  /** SCENARIO ONLY. Present when the outline opted into role-play; hydrated
   *  onto `project.scenario`. Ordinary projects omit it. */
  scenario?: {
    setting?: string;
    goal?: string;
    rules?: string;
    learnerRole?: string;
    characters?: Array<{
      name?: string;
      persona?: string;
      situation?: string;
      boundaries?: string;
      openingLine?: string;
    }>;
    sceneVisual?: {
      caption?: string;
      bg1?: string;
      bg2?: string;
      accent?: string;
      motifs?: string[];
    };
  };
  milestones?: Array<{
    title?: string;
    description?: string;
    briefing?: string;
    completionCriteria?: string;
    debrief?: string;
    coreConcept?: string;
    /** SCENARIO ONLY. Stage role in the prep → roleplay → wrapup skeleton. */
    scenarioStage?: 'prep' | 'roleplay' | 'wrapup';
    microtasks?: Array<{
      title?: string;
      description?: string;
      hints?: string[];
      // SCENARIO ONLY beat fields (roleplay milestones).
      successWhen?: string;
      characterObjective?: string;
      skillFocus?: string;
      learnerBrief?: string;
      narration?: string;
      completionCriteria?: string;
    }>;
  }>;
}

/** LLM JSON has no runtime type guarantees (`parseJsonResponse` only
 *  confirms it parsed). Trim a parsed value ONLY if it is actually a string;
 *  a non-string scalar (e.g. `title: 123`) becomes '' instead of throwing a
 *  raw `TypeError` from `.trim()` — which would escape the PlannerV2Error /
 *  retry contract. */
function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Coerce an unknown value to a clean `string[]`: non-array → `[]`,
 *  non-string entries dropped, trimmed, empties removed. */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(toText).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Validation (post-parse, pre-hydrate)
// ---------------------------------------------------------------------------

/** Structural + topic + language checks on the parsed LLM output. Returns
 *  a list of human-readable gaps (empty == valid). Mirrors the per-tool
 *  guards the loop applied inline. */
function validateLLMOutput(
  parsed: PlannerLLMOutput | null,
  project: PBLProjectV2,
  scenarioRoleplay: boolean,
): string[] {
  const gaps: string[] = [];
  if (!parsed || typeof parsed !== 'object') {
    return ['response was not a JSON object'];
  }

  const info = parsed.projectInfo;
  const title = toText(info?.title);
  const description = toText(info?.description);
  const learningObjective = toText(info?.learningObjective);
  if (!title) gaps.push('projectInfo.title is empty');
  if (!description) gaps.push('projectInfo.description is empty');
  if (!learningObjective) gaps.push('projectInfo.learningObjective is empty');
  // Parity with the loop's set_project_info schema (`gains` is `.min(3).max(5)`):
  // gains render on the Hero and feed the topic/language guards below, so a
  // missing/short list is a real regression, not a cosmetic gap.
  const gains = toStringList(info?.gains);
  if (gains.length < 3 || gains.length > 5) {
    gaps.push('projectInfo.gains must be a list of 3-5 non-empty learner-facing statements');
  }
  if (
    info?.proficiency != null &&
    !['beginner', 'intermediate', 'advanced'].includes(info.proficiency as string)
  ) {
    gaps.push('projectInfo.proficiency must be beginner | intermediate | advanced');
  }
  // Parity with the loop's set_project_info: when the learner explicitly
  // self-reported their level, that tier is authoritative. A different
  // `proficiency` means the milestones were authored for the wrong
  // difficulty — `applyPlannerProficiency` would only relabel the tier, not
  // regenerate the tasks — so reject and let the retry rebuild at the locked
  // tier (the loop returns ok:false here for the same reason).
  const assessment = project.proficiencyAssessment;
  const explicitTierLocked = assessment?.signals[0]?.kind === 'user_level_explicit';
  if (explicitTierLocked && info?.proficiency && info.proficiency !== assessment!.tier) {
    gaps.push(
      `The learner explicitly stated their level as ${assessment!.tier}; set projectInfo.proficiency="${assessment!.tier}" and design the milestones for that tier.`,
    );
  }

  if (!toText(parsed.instructorRole?.name)) {
    gaps.push('instructorRole.name is empty');
  }

  // `parseJsonResponse` does not type-check: a non-array `milestones`
  // (object / string from schema drift) would make `.forEach` throw a raw
  // TypeError, escaping the PlannerV2Error contract and skipping the retry.
  const milestones = Array.isArray(parsed.milestones) ? parsed.milestones : [];
  if (milestones.length === 0) {
    gaps.push('milestones must be a non-empty array');
  }
  milestones.forEach((m, i) => {
    const label = toText(m?.title) || `#${i + 1}`;
    if (!toText(m?.title)) gaps.push(`milestone ${label}: title is empty`);
    if (!toText(m?.briefing)) gaps.push(`milestone ${label}: briefing is empty`);
    if (!toText(m?.completionCriteria))
      gaps.push(`milestone ${label}: completionCriteria is empty`);
    if (!toText(m?.debrief)) gaps.push(`milestone ${label}: debrief is empty`);
    const tasks = Array.isArray(m?.microtasks) ? m.microtasks : [];
    if (tasks.length === 0) {
      gaps.push(`milestone ${label}: has no microtasks`);
    }
    tasks.forEach((t, j) => {
      if (!toText(t?.title)) gaps.push(`milestone ${label}: microtask #${j + 1} title is empty`);
    });
  });

  // NOTE: topic-alignment and content-language are NOT policed here. Those
  // are semantic "does the content match the outline" checks, and a lexical /
  // character-scan heuristic is an unreliable proxy for them (faithful
  // rephrases of sentence-like Chinese topics false-positive). Forcing a
  // retry on a brittle heuristic does more harm than good — topic fidelity and
  // content language are carried by the system prompt's hard rules instead.
  // Only structural contracts the renderer needs are gated below.

  // SCENARIO ONLY. Structural completeness checks that mirror the loop's
  // scenario completion gate (cast + sceneVisual + prep→roleplay→wrapup
  // skeleton + a successWhen on every roleplay beat) so the renderer always
  // gets a coherent scenario.
  if (scenarioRoleplay) {
    const sc = parsed.scenario;
    if (!sc || typeof sc !== 'object') {
      gaps.push('scenario block is missing (a role-play project must include a `scenario`)');
    } else {
      if (!toText(sc.setting)) gaps.push('scenario.setting is empty');
      const chars = Array.isArray(sc.characters) ? sc.characters : [];
      if (chars.length === 0) gaps.push('scenario.characters must have at least one character');
      chars.forEach((c, i) => {
        if (!toText(c?.name) || !toText(c?.persona) || !toText(c?.situation)) {
          gaps.push(`scenario character #${i + 1} needs name, persona, and situation`);
        }
      });
      const sv = sc.sceneVisual;
      if (!toText(sv?.caption) || toStringList(sv?.motifs).length === 0) {
        gaps.push('scenario.sceneVisual needs a caption and at least one emoji motif');
      }
    }
    const stages = milestones.map((m) => m?.scenarioStage);
    if (milestones.length < 3) {
      gaps.push(
        'scenario needs the three-stage skeleton: prep + ≥1 roleplay + wrapup (≥3 milestones)',
      );
    }
    if (stages[0] !== 'prep') {
      gaps.push('scenario: the FIRST milestone must have scenarioStage:"prep"');
    }
    if (stages[stages.length - 1] !== 'wrapup') {
      gaps.push('scenario: the LAST milestone must have scenarioStage:"wrapup"');
    }
    if (!stages.some((s) => s === 'roleplay')) {
      gaps.push('scenario: needs at least one scenarioStage:"roleplay" milestone');
    }
    milestones.forEach((m, i) => {
      if (m?.scenarioStage !== 'roleplay') return;
      const tasks = Array.isArray(m?.microtasks) ? m.microtasks : [];
      tasks.forEach((t, j) => {
        if (!toText(t?.successWhen)) {
          gaps.push(`roleplay milestone #${i + 1} beat #${j + 1}: successWhen is required`);
        }
      });
    });
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Hydration (parity with the loop's six tools + mark_design_complete)
// ---------------------------------------------------------------------------

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

type LLMScenario = NonNullable<PlannerLLMOutput['scenario']>;

/** Build the frozen `scenario` block from the LLM output: assign character
 *  ids, keep only valid hex colours, clamp motifs to 4. `normalizeScenario`
 *  later drops invalid characters / degrades to a plain project if needed. */
function hydrateScenario(raw: LLMScenario): PBLScenarioConfig {
  const characters: PBLScenarioCharacter[] = (Array.isArray(raw.characters) ? raw.characters : [])
    .filter((c) => toText(c?.name) && toText(c?.persona))
    .map((c) => ({
      id: newId('char'),
      name: toText(c.name),
      persona: toText(c.persona),
      ...(toText(c.situation) ? { situation: toText(c.situation) } : {}),
      ...(toText(c.boundaries) ? { boundaries: toText(c.boundaries) } : {}),
      ...(toText(c.openingLine) ? { openingLine: toText(c.openingLine) } : {}),
    }))
    // HARD CONSTRAINT: this version voices a SINGLE character (runtime
    // `speakingCharacter` only ever uses characters[0]). Deterministically keep
    // just the first, so a model that over-produces a cast can never leak extra
    // characters into the package (dead data / wrong-name bubbles). The prompt
    // also asks for exactly one; this guarantees it regardless.
    .slice(0, 1);

  const scenario: PBLScenarioConfig = { setting: toText(raw.setting), characters };
  if (toText(raw.goal)) scenario.goal = toText(raw.goal);
  if (toText(raw.rules)) scenario.rules = toText(raw.rules);
  if (toText(raw.learnerRole)) scenario.learnerRole = toText(raw.learnerRole);

  const sv = raw.sceneVisual;
  if (sv && (toText(sv.caption) || toStringList(sv.motifs).length > 0)) {
    const visual: PBLSceneVisual = {
      caption: toText(sv.caption),
      motifs: toStringList(sv.motifs).slice(0, 4),
    };
    if (typeof sv.bg1 === 'string' && HEX_RE.test(sv.bg1.trim())) visual.bg1 = sv.bg1.trim();
    if (typeof sv.bg2 === 'string' && HEX_RE.test(sv.bg2.trim())) visual.bg2 = sv.bg2.trim();
    if (typeof sv.accent === 'string' && HEX_RE.test(sv.accent.trim()))
      visual.accent = sv.accent.trim();
    scenario.sceneVisual = visual;
  }
  return scenario;
}

function hydrateProject(project: PBLProjectV2, parsed: PlannerLLMOutput): void {
  const info = parsed.projectInfo!;
  const isScenario = !!parsed.scenario;

  // Project info — set title/description/objective BEFORE building the
  // instructor anchor (which reads them) and before proficiency re-seat.
  // All text reads go through `toText` (validation guarantees the required
  // ones are non-empty strings; the coercion keeps optional / unvalidated
  // fields type-safe too).
  project.title = toText(info.title);
  project.description = toText(info.description);
  project.learningObjective = toText(info.learningObjective) || undefined;
  project.gains = toStringList(info.gains);
  const fallbackTier = project.proficiency === '' ? 'intermediate' : project.proficiency;
  applyPlannerProficiency(project, info.proficiency ?? fallbackTier);

  // Instructor role.
  const llmRole = parsed.instructorRole!;
  const anchoredSystemPrompt = [toText(llmRole.systemPrompt), instructorProjectAnchor(project)]
    .filter(Boolean)
    .join('\n\n');
  const role: PBLRole = {
    id: newId('role'),
    type: 'instructor',
    name: toText(llmRole.name),
    description: toText(llmRole.description) || undefined,
    systemPrompt: anchoredSystemPrompt,
  };
  project.roles.push(role);

  // Milestones (+ nested microtasks). Array shapes are coerced defensively
  // (hints are not pre-validated, and the LLM JSON carries no runtime type
  // guarantees).
  project.milestones = (Array.isArray(parsed.milestones) ? parsed.milestones : []).map(
    (m, i): PBLMilestone => {
      const microtasks: PBLMicrotask[] = (Array.isArray(m.microtasks) ? m.microtasks : []).map(
        (t, j): PBLMicrotask => {
          const mt: PBLMicrotask = {
            id: newId('mt'),
            title: toText(t.title),
            description: toText(t.description) || undefined,
            status: 'todo',
            assignee: 'user',
            hints: toStringList(t.hints),
            order: j,
          };
          // SCENARIO ONLY beat fields — attached only when present (ordinary
          // microtasks carry none). normalizeScenario degrades the project if
          // the scenario turns out invalid, dropping these along with it.
          const successWhen = toText(t.successWhen);
          if (successWhen) mt.successWhen = successWhen;
          const characterObjective = toText(t.characterObjective);
          if (characterObjective) mt.characterObjective = characterObjective;
          const skillFocus = toText(t.skillFocus);
          if (skillFocus) mt.skillFocus = skillFocus;
          const learnerBrief = toText(t.learnerBrief);
          if (learnerBrief) mt.learnerBrief = learnerBrief;
          const narration = toText(t.narration);
          if (narration) mt.narration = narration;
          const beatCriteria = toText(t.completionCriteria);
          if (beatCriteria) mt.completionCriteria = beatCriteria;
          return mt;
        },
      );
      const coreConcept = toText(m.coreConcept);
      const scenarioStage = (['prep', 'roleplay', 'wrapup'] as const).includes(
        m.scenarioStage as never,
      )
        ? m.scenarioStage
        : undefined;
      return {
        id: newId('ms'),
        title: toText(m.title),
        description: toText(m.description) || undefined,
        status: i === 0 ? 'active' : 'locked',
        order: i,
        microtasks,
        briefing: toText(m.briefing),
        completionCriteria: toText(m.completionCriteria),
        debrief: toText(m.debrief),
        // Scenario stages never carry a synthesisCheck (the wrapup stage is
        // the integrative reflection) — guard even if the LLM leaks a
        // coreConcept onto a scenario milestone.
        ...(coreConcept && !isScenario ? { synthesisCheck: { coreConcept } } : {}),
        ...(scenarioStage ? { scenarioStage } : {}),
      };
    },
  );

  // SCENARIO ONLY. Freeze the cast/premise/visual onto the project and stamp
  // the scenario schema version (parity with the loop's set_scenario).
  // normalizeScenario (run by the caller) assigns any gaps + degrades to a
  // plain project if the cast/roleplay turn out invalid.
  if (parsed.scenario) {
    project.scenario = hydrateScenario(parsed.scenario);
    project.schemaVersion = SCENARIO_SCHEMA_VERSION;
  }

  // Bootstrap the Instructor thread + flip lifecycle (= mark_design_complete).
  const instructor = project.roles.find((r) => r.type === 'instructor');
  if (instructor && !project.threads.some((t) => t.agentId === instructor.id)) {
    project.threads.push({ agentId: instructor.id, messages: [] });
  }
  project.status = 'active';
  project.uiPhase = 'hero';
  project.updatedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Single-call variant of `generatePBLV2Project`. Same signature and same
 * `PBLProjectV2` output / `PlannerV2Error` failure contract.
 *
 * Strategy: one `callLLM` (no tools) → `parseJsonResponse` → validate
 * (structure + topic + language) with at most one targeted retry → hydrate
 * → deterministic post-processing → completion-gate. Throws
 * `PlannerV2Error` if the model never produces a usable project; the
 * caller falls back (to the loop, then v1).
 */
export async function generatePBLV2ProjectSingleCall(
  input: PBLPlannerV2Input,
  model: LanguageModel,
  callbacks?: PlannerV2Callbacks,
  thinkingConfig?: ThinkingConfig,
): Promise<PBLProjectV2> {
  const pblConfig = input.outline.pblConfig;
  if (!pblConfig) {
    throw new PlannerV2Error(
      'Planner v2 (single-call) invoked on an outline without pblConfig — this is a generation pipeline bug.',
      emptyProject(input),
    );
  }

  const scenarioRoleplay = pblConfig.scenarioRoleplay === true;
  const project = emptyProject(input);
  const contentLanguage =
    project.languageDirective || 'Match the language of the outline content above.';
  const systemPrompt = await buildPlannerSystemPrompt(
    input,
    project.proficiency,
    contentLanguage,
    scenarioRoleplay,
    // Two prompts, one single-call path: scenario-roleplay outlines get the
    // scenario authoring spec + scenario-augmented schema; everything else
    // gets the ordinary project prompt.
    scenarioRoleplay ? SCENARIO_PROMPT : SINGLE_CALL_PROMPT,
  );

  const basePrompt = buildSingleCallUserPrompt(scenarioRoleplay);

  const callModel = async (prompt: string): Promise<PlannerLLMOutput | null> => {
    const result = await callLLM(
      { model, system: systemPrompt, prompt },
      'pbl-v2-planner-single',
      undefined,
      thinkingConfig,
    );
    return parseJsonResponse<PlannerLLMOutput>(result.text);
  };

  // First attempt.
  let parsed = await callModel(basePrompt);
  let gaps = validateLLMOutput(parsed, project, scenarioRoleplay);

  // One targeted retry: hand the model its concrete problems back.
  if (gaps.length > 0) {
    log.warn(
      `Single-call planner first attempt had ${gaps.length} gap(s); retrying once: ${gaps.join('; ')}`,
    );
    const retryPrompt = `${basePrompt}\n\nYour previous output had these problems:\n${gaps
      .map((g) => `- ${g}`)
      .join('\n')}\n\nFix every one of them and output the corrected single JSON object.`;
    parsed = await callModel(retryPrompt);
    gaps = validateLLMOutput(parsed, project, scenarioRoleplay);
  }

  if (!parsed || gaps.length > 0) {
    throw new PlannerV2Error(
      `Planner v2 (single-call) failed to produce a valid project: ${gaps.join('; ')}`,
      project,
    );
  }

  hydrateProject(project, parsed);

  callbacks?.onProgress?.({ kind: 'project_info', title: project.title });
  for (const milestone of project.milestones) {
    callbacks?.onProgress?.({ kind: 'milestone', title: milestone.title, index: milestone.order });
    for (const task of milestone.microtasks) {
      callbacks?.onProgress?.({
        kind: 'microtask',
        milestoneTitle: milestone.title,
        title: task.title,
        index: task.order,
      });
    }
  }

  // Shared deterministic post-processing (identical order to the loop path).
  normalizeProjectRuntime(project);
  normalizeSynthesisChecks(project);
  // SCENARIO ONLY safety net: assign any missing character ids, or degrade to
  // a plain project if the cast / roleplay stage turned out invalid. No-op for
  // ordinary projects.
  normalizeScenario(project);

  const finalGaps = plannerCompletionGaps(project, { scenarioRoleplay });
  if (finalGaps.length > 0) {
    throw new PlannerV2Error(
      `Planner v2 (single-call) output failed validation: ${finalGaps.join('; ')}`,
      project,
    );
  }

  const microtaskCount = project.milestones.reduce((acc, m) => acc + m.microtasks.length, 0);
  callbacks?.onProgress?.({
    kind: 'complete',
    milestoneCount: project.milestones.length,
    microtaskCount,
  });
  log.info(
    `Planner v2 (single-call) done: ${project.milestones.length} milestones, ${microtaskCount} microtasks, ${project.roles.length} roles.`,
  );

  return project;
}
