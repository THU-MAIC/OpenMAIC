/**
 * PBL v2 Planner — Isolation Harness (A/B + LLM-judge)
 *
 * Bypasses the UI pipeline and calls the planner(s) directly with a
 * configured language model. Answers two questions:
 *
 *   1. Success rate — what fraction of runs produce a structurally
 *      complete PBL project? (per variant)
 *   2. Completability — can a real learner finish it in the PBL v2 runtime?
 *      (independent LLM-judge rubric)
 *   3. Output quality — how good is the project? (LLM-judge rubric)
 *
 * It runs each test case through one or more VARIANTS:
 *   - `loop`        — the legacy agentic tool-calling planner
 *                     (`generatePBLV2Project`)
 *   - `single-call` — the single structured-output planner
 *                     (`generatePBLV2ProjectSingleCall`)
 *
 * Usage:
 *   EVAL_PBL_MODEL=anthropic:claude-sonnet-4-6 \
 *   EVAL_PBL_API_KEY=<key> \
 *   EVAL_PBL_THINKING=true \
 *   pnpm tsx eval/pbl-v2-planner/runner.ts
 *
 *   # Only one variant:
 *   EVAL_PBL_VARIANTS=single-call ... pnpm tsx eval/pbl-v2-planner/runner.ts
 *   # Disable the LLM-judge (success-rate only):
 *   EVAL_PBL_JUDGE=false ... pnpm tsx eval/pbl-v2-planner/runner.ts
 *   # First N cases only:
 *   EVAL_PBL_RUNS=4 ... pnpm tsx eval/pbl-v2-planner/runner.ts
 *
 * Output: prints tables to stdout and writes a markdown report under
 * eval/pbl-v2-planner/results/<model>/<timestamp>/.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, type LanguageModel } from 'ai';

import { generatePBLV2Project, PlannerV2Error } from '@/lib/pbl/v2/agents/planner';
import { generatePBLV2ProjectSingleCall } from '@/lib/pbl/v2/agents/planner-single-call';
import { parseJsonResponse } from '@/lib/generation/json-repair';
import { buildCompareHtml } from './compare-html';
import type { PBLPlannerV2Input, PBLProjectV2 } from '@/lib/pbl/v2/types';
import type { SceneOutline } from '@/lib/types/generation';
import type { ThinkingConfig } from '@/lib/types/provider';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Variant = 'loop' | 'single-call';

interface TestCase {
  id: string;
  requirement: string;
  pblConfig: NonNullable<SceneOutline['pblConfig']>;
  languageDirective: string;
}

interface JudgeScores {
  scores: {
    projectNotLecture: number;
    taskEvaluability: number;
    typeFit: number;
    granularity: number;
    coherence: number;
    topicFidelity: number;
    singleConcreteOutcome: number;
    difficultyProgressionAndFit: number;
    learnerAgency: number;
    authenticWorkflow: number;
    stageIntegrity: number;
    closureAndConsolidation: number;
  };
  redLines: string[];
  overall: number;
  rationale?: string;
}

interface CompletabilityJudge {
  score: number;
  pass: boolean;
  blockers: string[];
  riskLevel: 'low' | 'medium' | 'high';
  rationale?: string;
}

const JUDGE_DIMENSIONS: Array<keyof JudgeScores['scores']> = [
  'projectNotLecture',
  'taskEvaluability',
  'typeFit',
  'granularity',
  'coherence',
  'topicFidelity',
  'singleConcreteOutcome',
  'difficultyProgressionAndFit',
  'learnerAgency',
  'authenticWorkflow',
  'stageIntegrity',
  'closureAndConsolidation',
];

interface RunResult {
  caseId: string;
  variant: Variant;
  ok: boolean;
  milestoneCount: number;
  microtaskCount: number;
  roleCount: number;
  durationMs: number;
  error?: string;
  /** True if the project passed the completion gate (all milestones have microtasks). */
  passesCompletionGate: boolean;
  /** True for role-play scenario cases (graded by the scenario rubric). */
  isScenario: boolean;
  /** Runtime feasibility judge: can the learner actually complete it? */
  completability?: CompletabilityJudge;
  judge?: JudgeScores;
  /** Full generated project, dumped to disk for inspection. */
  project?: PBLProjectV2;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function parseModelString(raw: string): { provider: string; modelId: string } {
  const colon = raw.indexOf(':');
  if (colon === -1) throw new Error(`Invalid model string "${raw}" — expected provider:modelId`);
  return { provider: raw.slice(0, colon), modelId: raw.slice(colon + 1) };
}

function makeProvider(
  provider: string,
  apiKey: string,
  baseURL?: string,
): (id: string) => LanguageModel {
  switch (provider) {
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
      return (id) => google(id);
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
      return (id) => anthropic(id);
    }
    case 'openai': {
      // Use chat-completions (not the Responses API): OpenAI-compatible
      // gateways (DeepSeek, Qwen, etc.) only speak /v1/chat/completions.
      const openai = createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
      return (id) => openai.chat(id);
    }
    default:
      console.error(
        `Error: unsupported provider "${provider}". Supported: google, anthropic, openai.`,
      );
      process.exit(1);
  }
}

/** Build a model from a triple of env vars (model / api key / base url).
 *  Returns null when the model var is unset (used for the optional judge
 *  override). `required` exits the process on a missing model/key. */
function modelFromEnv(
  modelVar: string,
  keyVar: string,
  baseVar: string,
  fallbackKeyVar: string,
  fallbackBaseVar: string,
  required: boolean,
): LanguageModel | null {
  const raw = process.env[modelVar];
  if (!raw) {
    if (required) {
      console.error(
        `Error: ${modelVar} must be set. Example: ${modelVar}=google:gemini-3-flash-preview`,
      );
      process.exit(1);
    }
    return null;
  }
  const apiKey = process.env[keyVar] || process.env[fallbackKeyVar];
  if (!apiKey) {
    console.error(`Error: ${keyVar} (or ${fallbackKeyVar}) must be set.`);
    process.exit(1);
  }
  const baseURL = process.env[baseVar] || process.env[fallbackBaseVar] || undefined;
  const { provider, modelId } = parseModelString(raw);
  return makeProvider(provider, apiKey, baseURL)(modelId);
}

function createModel(): LanguageModel {
  return modelFromEnv(
    'EVAL_PBL_MODEL',
    'EVAL_PBL_API_KEY',
    'EVAL_PBL_BASE_URL',
    'EVAL_PBL_API_KEY',
    'EVAL_PBL_BASE_URL',
    true,
  )!;
}

/** Judge model. Defaults to the generation model unless EVAL_PBL_JUDGE_MODEL
 *  is set (recommended: a strong, independent model so a weak generator does
 *  not grade its own homework). */
function createJudgeModel(genModel: LanguageModel): LanguageModel {
  return (
    modelFromEnv(
      'EVAL_PBL_JUDGE_MODEL',
      'EVAL_PBL_JUDGE_API_KEY',
      'EVAL_PBL_JUDGE_BASE_URL',
      'EVAL_PBL_API_KEY',
      'EVAL_PBL_BASE_URL',
      false,
    ) ?? genModel
  );
}

function createThinkingConfig(): ThinkingConfig | undefined {
  const thinking = process.env.EVAL_PBL_THINKING;
  if (!thinking || thinking === 'false') return undefined;

  const budget = parseInt(process.env.EVAL_PBL_THINKING_BUDGET || '1024', 10);
  return {
    enabled: true,
    mode: 'enabled',
    budgetTokens: budget,
  };
}

function selectedVariants(): Variant[] {
  const raw = process.env.EVAL_PBL_VARIANTS;
  if (!raw) return ['loop', 'single-call'];
  const parsed = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is Variant => v === 'loop' || v === 'single-call');
  return parsed.length > 0 ? parsed : ['loop', 'single-call'];
}

function judgeEnabled(): boolean {
  return process.env.EVAL_PBL_JUDGE !== 'false';
}

function loadTestCases(): TestCase[] {
  const path = join(getCurrentDir(), 'scenarios', 'test-cases.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as TestCase[];
}

// ---------------------------------------------------------------------------
// Outline builder
// ---------------------------------------------------------------------------

function buildOutline(tc: TestCase, order: number): SceneOutline {
  return {
    id: `eval-pbl-${tc.id}`,
    type: 'pbl',
    title: tc.pblConfig.projectTopic,
    description: tc.pblConfig.projectDescription,
    keyPoints: tc.pblConfig.targetSkills.map((s) => `Learn ${s}`),
    teachingObjective: `完成 ${tc.pblConfig.projectTopic} 项目`,
    order,
    pblConfig: tc.pblConfig,
    languageNote: tc.languageDirective,
  };
}

function buildInput(tc: TestCase, outline: SceneOutline): PBLPlannerV2Input {
  return {
    outline,
    courseContext: {
      allOutlines: [outline],
      languageDirective: tc.languageDirective,
    },
    user: {
      requirement: tc.requirement,
    },
    targetLanguage: 'zh-CN',
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function checkCompletionGate(project: PBLProjectV2): boolean {
  if (!project.title || !project.description) return false;
  if (!project.roles.some((r) => r.type === 'instructor')) return false;
  if (project.milestones.length === 0) return false;
  return project.milestones.every((m) => m.microtasks.length > 0);
}

// ---------------------------------------------------------------------------
// LLM judge
// ---------------------------------------------------------------------------

/** Compact, judge-facing view of a project (drops ids/timestamps/runtime).
 *  Surfaces the scenario block + per-beat fields when the project is a
 *  role-play scenario, so the judge can apply its scenario-specific rules. */
function projectForJudge(project: PBLProjectV2): unknown {
  const instructor = project.roles.find((r) => r.type === 'instructor');
  const scenario = project.scenario
    ? {
        setting: project.scenario.setting,
        goal: project.scenario.goal,
        rules: project.scenario.rules,
        learnerRole: project.scenario.learnerRole,
        characters: project.scenario.characters.map((c) => ({
          name: c.name,
          persona: c.persona,
          situation: c.situation,
          boundaries: c.boundaries,
          openingLine: c.openingLine,
        })),
      }
    : undefined;
  return {
    title: project.title,
    description: project.description,
    learningObjective: project.learningObjective,
    proficiency: project.proficiency,
    ...(scenario ? { scenario } : {}),
    instructor: instructor ? { name: instructor.name, description: instructor.description } : null,
    milestones: project.milestones.map((m) => ({
      title: m.title,
      description: m.description,
      briefing: m.briefing,
      completionCriteria: m.completionCriteria,
      debrief: m.debrief,
      coreConcept: m.synthesisCheck?.coreConcept,
      ...(m.scenarioStage ? { scenarioStage: m.scenarioStage } : {}),
      microtasks: m.microtasks.map((t) => ({
        title: t.title,
        description: t.description,
        hints: t.hints,
        ...(t.successWhen ? { successWhen: t.successWhen } : {}),
        ...(t.characterObjective ? { characterObjective: t.characterObjective } : {}),
        ...(t.skillFocus ? { skillFocus: t.skillFocus } : {}),
        ...(t.learnerBrief ? { learnerBrief: t.learnerBrief } : {}),
        ...(t.narration ? { narration: t.narration } : {}),
      })),
      documents: (m.documents ?? []).map((d) => ({ title: d.title })),
    })),
  };
}

let _judgeTemplate: string | undefined;
let _judgeTemplateScenario: string | undefined;
let _completabilityJudgeTemplate: string | undefined;
/** Role-play scenario projects are graded by a separate rubric
 *  (`judge-prompt-scenario.md`); everything else uses `judge-prompt.md`. */
function judgeTemplate(isScenario: boolean): string {
  if (isScenario) {
    if (_judgeTemplateScenario === undefined) {
      _judgeTemplateScenario = readFileSync(
        join(getCurrentDir(), 'judge-prompt-scenario.md'),
        'utf-8',
      );
    }
    return _judgeTemplateScenario;
  }
  if (_judgeTemplate === undefined) {
    _judgeTemplate = readFileSync(join(getCurrentDir(), 'judge-prompt.md'), 'utf-8');
  }
  return _judgeTemplate;
}

function completabilityJudgeTemplate(): string {
  if (_completabilityJudgeTemplate === undefined) {
    _completabilityJudgeTemplate = readFileSync(
      join(getCurrentDir(), 'judge-prompt-completability.md'),
      'utf-8',
    );
  }
  return _completabilityJudgeTemplate;
}

async function judgeProject(
  project: PBLProjectV2,
  tc: TestCase,
  model: LanguageModel,
): Promise<JudgeScores | undefined> {
  try {
    const prompt = judgeTemplate(!!project.scenario)
      .replace('{{topic}}', tc.pblConfig.projectTopic)
      .replace('{{description}}', tc.pblConfig.projectDescription)
      .replace('{{targetSkills}}', tc.pblConfig.targetSkills.join(', '))
      .replace('{{proficiency}}', project.proficiency || 'intermediate')
      .replace('{{project}}', JSON.stringify(projectForJudge(project), null, 2));

    const { text } = await generateText({ model, prompt });
    const scores = parseJsonResponse<JudgeScores>(text);
    if (!scores || typeof scores.overall !== 'number' || typeof scores.scores !== 'object') {
      return undefined;
    }
    if (!Array.isArray(scores.redLines)) scores.redLines = [];
    return scores;
  } catch (err) {
    console.log(`       judge failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function judgeCompletability(
  project: PBLProjectV2,
  tc: TestCase,
  model: LanguageModel,
): Promise<CompletabilityJudge | undefined> {
  try {
    const prompt = completabilityJudgeTemplate()
      .replace('{{topic}}', tc.pblConfig.projectTopic)
      .replace('{{description}}', tc.pblConfig.projectDescription)
      .replace('{{targetSkills}}', tc.pblConfig.targetSkills.join(', '))
      .replace('{{proficiency}}', project.proficiency || 'intermediate')
      .replace('{{project}}', JSON.stringify(projectForJudge(project), null, 2));

    const { text } = await generateText({ model, prompt });
    const result = parseJsonResponse<CompletabilityJudge>(text);
    if (
      !result ||
      typeof result.score !== 'number' ||
      typeof result.pass !== 'boolean' ||
      !['low', 'medium', 'high'].includes(result.riskLevel)
    ) {
      return undefined;
    }
    if (!Array.isArray(result.blockers)) result.blockers = [];
    return result;
  } catch (err) {
    console.log(
      `       completability judge failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runVariant(
  variant: Variant,
  input: PBLPlannerV2Input,
  model: LanguageModel,
  thinkingConfig?: ThinkingConfig,
): Promise<PBLProjectV2> {
  return variant === 'single-call'
    ? generatePBLV2ProjectSingleCall(input, model, undefined, thinkingConfig)
    : generatePBLV2Project(input, model, undefined, thinkingConfig);
}

async function runOne(
  tc: TestCase,
  variant: Variant,
  outlineOrder: number,
  model: LanguageModel,
  judgeModel: LanguageModel,
  thinkingConfig?: ThinkingConfig,
): Promise<RunResult> {
  const outline = buildOutline(tc, outlineOrder);
  const input = buildInput(tc, outline);
  const isScenario = tc.pblConfig.scenarioRoleplay === true;
  const startedAt = performance.now();

  try {
    const project = await runVariant(variant, input, model, thinkingConfig);
    const durationMs = Math.round(performance.now() - startedAt);
    const microtaskCount = project.milestones.reduce((sum, m) => sum + m.microtasks.length, 0);
    const passesCompletionGate = checkCompletionGate(project);

    const [completability, judge] =
      judgeEnabled() && passesCompletionGate
        ? await Promise.all([
            judgeCompletability(project, tc, judgeModel),
            judgeProject(project, tc, judgeModel),
          ])
        : [undefined, undefined];

    return {
      caseId: tc.id,
      variant,
      ok: true,
      milestoneCount: project.milestones.length,
      microtaskCount,
      roleCount: project.roles.length,
      durationMs,
      passesCompletionGate,
      isScenario,
      completability,
      judge,
      project,
    };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startedAt);
    const msg =
      err instanceof PlannerV2Error
        ? `PlannerV2Error: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      caseId: tc.id,
      variant,
      ok: false,
      milestoneCount: 0,
      microtaskCount: 0,
      roleCount: 0,
      durationMs,
      error: msg,
      passesCompletionGate: false,
      isScenario,
    };
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function meanDims(j: JudgeScores): number {
  return avg(JUDGE_DIMENSIONS.map((d) => j.scores[d] ?? 0));
}

function completabilityBlockerList(j: CompletabilityJudge): string {
  return j.blockers.length > 0 ? j.blockers.join(',') : 'none';
}

function hasCompletabilityFailure(r: RunResult): boolean {
  return r.completability?.pass === false;
}

/** Split results into the two grading categories (normal / scenario),
 *  dropping any category with no cases so reports stay clean. */
function splitByCategory(results: RunResult[]): Array<{ label: string; results: RunResult[] }> {
  const normal = results.filter((r) => !r.isScenario);
  const scenario = results.filter((r) => r.isScenario);
  const out: Array<{ label: string; results: RunResult[] }> = [];
  if (normal.length) out.push({ label: 'normal', results: normal });
  if (scenario.length) out.push({ label: 'scenario', results: scenario });
  return out;
}

function variantSummary(results: RunResult[], variant: Variant): string {
  const rs = results.filter((r) => r.variant === variant);
  const total = rs.length;
  const ok = rs.filter((r) => r.ok).length;
  const gate = rs.filter((r) => r.passesCompletionGate).length;
  const completability = rs
    .map((r) => r.completability)
    .filter((j): j is CompletabilityJudge => !!j);
  const completable = completability.filter((j) => j.pass).length;
  const blockerRuns = completability.filter((j) => j.blockers.length > 0).length;
  const judged = rs.map((r) => r.judge).filter((j): j is JudgeScores => !!j);
  const redLineRuns = judged.filter((j) => j.redLines.length > 0).length;
  const completionLine =
    completability.length > 0
      ? `complete(pass=${completable}/${completability.length}, score=${avg(
          completability.map((j) => j.score),
        ).toFixed(2)}, blocker-runs=${blockerRuns}/${completability.length})`
      : 'complete(n/a)';
  const judgeLine =
    judged.length > 0
      ? `judge(overall=${avg(judged.map((j) => j.overall)).toFixed(2)}, dims=${avg(
          judged.map(meanDims),
        ).toFixed(2)}, redline-runs=${redLineRuns}/${judged.length})`
      : 'judge(n/a)';
  return `  ${variant.padEnd(12)} success ${ok}/${total} | gate ${gate}/${total} | avg ${formatDuration(
    Math.round(avg(rs.map((r) => r.durationMs))),
  )} | ${completionLine} | ${judgeLine}`;
}

function renderRows(results: RunResult[], variants: Variant[]): string {
  const header = [
    'Case',
    'Variant',
    'Status',
    'MS',
    'MT',
    'Dur',
    'Comp',
    'Blockers',
    'Overall',
    'RedLines',
  ].join('  |  ');
  const sep = '------|---------|--------|----|----|------|------|----------|--------|--------';
  const caseIds = [...new Set(results.map((r) => r.caseId))];
  const rows: string[] = [];
  for (const caseId of caseIds) {
    for (const variant of variants) {
      const r = results.find((x) => x.caseId === caseId && x.variant === variant);
      if (!r) continue;
      const status = r.ok ? (r.passesCompletionGate ? '✓ OK' : '⚠ gate') : '✗ FAIL';
      rows.push(
        [
          r.caseId.padEnd(26),
          variant.padEnd(11),
          status.padEnd(8),
          String(r.milestoneCount).padEnd(4),
          String(r.microtaskCount).padEnd(4),
          formatDuration(r.durationMs).padEnd(6),
          r.completability
            ? `${r.completability.pass ? 'PASS' : 'FAIL'} ${r.completability.score.toFixed(1)}`
            : '-',
          r.completability ? completabilityBlockerList(r.completability) : '-',
          r.judge ? r.judge.overall.toFixed(1) : '-',
          r.judge ? r.judge.redLines.join(',') || '—' : '-',
        ].join('  |  '),
      );
    }
  }
  return [header, sep, ...rows].join('\n');
}

function printReport(results: RunResult[], variants: Variant[], modelStr: string): void {
  console.log('');
  console.log('═'.repeat(96));
  console.log('  PBL v2 Planner — A/B Harness Report');
  console.log('═'.repeat(96));
  console.log(`  Model: ${modelStr}`);
  console.log('─'.repeat(96));
  for (const cat of splitByCategory(results)) {
    console.log(
      `  ── ${cat.label} (${[...new Set(cat.results.map((r) => r.caseId))].length} case(s)) ──`,
    );
    for (const variant of variants) console.log(variantSummary(cat.results, variant));
  }
  console.log('─'.repeat(96));
  console.log(renderRows(results, variants));
  console.log('─'.repeat(96));

  const failures = results.filter(
    (r) => !r.ok || !r.passesCompletionGate || hasCompletabilityFailure(r),
  );
  if (failures.length > 0) {
    console.log('  Failures:');
    for (const f of failures) {
      const reason = f.error
        ? f.error
        : !f.passesCompletionGate
          ? 'gate fail (incomplete project)'
          : f.completability
            ? `completability fail (${completabilityBlockerList(f.completability)})`
            : 'completability fail';
      console.log(`    ${f.caseId} [${f.variant}]: ${reason}`);
    }
  }
  console.log('═'.repeat(96));
  console.log('');
}

/** Summary table rows (one per variant) for a result subset. */
function summaryTableLines(results: RunResult[], variants: Variant[]): string[] {
  const lines: string[] = [
    '| Variant | Success | Gate | Completable | Comp score | Blocker runs | Avg dur | Overall | Dims avg | Red-line runs |',
    '|---------|---------|------|-------------|------------|--------------|---------|---------|----------|---------------|',
  ];
  for (const variant of variants) {
    const rs = results.filter((r) => r.variant === variant);
    const total = rs.length;
    if (total === 0) continue;
    const ok = rs.filter((r) => r.ok).length;
    const gate = rs.filter((r) => r.passesCompletionGate).length;
    const completability = rs
      .map((r) => r.completability)
      .filter((j): j is CompletabilityJudge => !!j);
    const completable = completability.filter((j) => j.pass).length;
    const blockerRuns = completability.filter((j) => j.blockers.length > 0).length;
    const judged = rs.map((r) => r.judge).filter((j): j is JudgeScores => !!j);
    const redLineRuns = judged.filter((j) => j.redLines.length > 0).length;
    lines.push(
      `| ${variant} | ${ok}/${total} | ${gate}/${total} | ${
        completability.length ? `${completable}/${completability.length}` : '-'
      } | ${completability.length ? avg(completability.map((j) => j.score)).toFixed(2) : '-'} | ${
        completability.length ? `${blockerRuns}/${completability.length}` : '-'
      } | ${formatDuration(
        Math.round(avg(rs.map((r) => r.durationMs))),
      )} | ${judged.length ? avg(judged.map((j) => j.overall)).toFixed(2) : '-'} | ${
        judged.length ? avg(judged.map(meanDims)).toFixed(2) : '-'
      } | ${judged.length ? `${redLineRuns}/${judged.length}` : '-'} |`,
    );
  }
  return lines;
}

/** Per-dimension averages table for a result subset. */
function perDimensionLines(results: RunResult[], variants: Variant[]): string[] {
  const lines: string[] = [
    `| Dimension | ${variants.join(' | ')} |`,
    `|-----------|${variants.map(() => '---').join('|')}|`,
  ];
  for (const dim of JUDGE_DIMENSIONS) {
    const cells = variants.map((variant) => {
      const judged = results
        .filter((r) => r.variant === variant)
        .map((r) => r.judge)
        .filter((j): j is JudgeScores => !!j);
      return judged.length ? avg(judged.map((j) => j.scores[dim] ?? 0)).toFixed(2) : '-';
    });
    lines.push(`| ${dim} | ${cells.join(' | ')} |`);
  }
  return lines;
}

function writeMarkdownReport(
  results: RunResult[],
  variants: Variant[],
  modelStr: string,
  judgeStr: string,
  thinkingConfig: ThinkingConfig | undefined,
  runDir: string,
): void {
  const categories = splitByCategory(results);
  const lines: string[] = [
    `# PBL v2 Planner — A/B Harness Report`,
    '',
    `- **Generation model**: ${modelStr}`,
    `- **Judge model**: ${judgeStr}`,
    `- **Thinking**: ${thinkingConfig?.enabled ? `on (budget: ${thinkingConfig.budgetTokens ?? 'default'})` : 'off'}`,
    `- **Variants**: ${variants.join(', ')}`,
    `- **Categories**: ${categories.map((c) => `${c.label} (${[...new Set(c.results.map((r) => r.caseId))].length})`).join(', ')}`,
    '',
    `> Runtime completability is graded first by \`judge-prompt-completability.md\`. Normal project quality is graded by \`judge-prompt.md\`; role-play scenario quality by \`judge-prompt-scenario.md\`. Quality scores share the same 12 dimension keys but are NOT directly comparable across categories.`,
  ];

  for (const cat of categories) {
    lines.push(
      '',
      `## ${cat.label === 'scenario' ? 'Scenario' : 'Normal'} projects`,
      '',
      '### Summary',
      '',
      ...summaryTableLines(cat.results, variants),
      '',
      '### Per-dimension averages (1-5)',
      '',
      ...perDimensionLines(cat.results, variants),
    );
  }

  lines.push('', '## Per-case', '');
  lines.push(
    '| Case | Cat | Variant | Status | MS | MT | Dur | Completability | Blockers | Overall | RedLines | Rationale / Error |',
  );
  lines.push(
    '|------|-----|---------|--------|----|----|-----|---------------|----------|---------|----------|-------------------|',
  );
  const caseIds = [...new Set(results.map((r) => r.caseId))];
  for (const caseId of caseIds) {
    for (const variant of variants) {
      const r = results.find((x) => x.caseId === caseId && x.variant === variant);
      if (!r) continue;
      const status = r.ok ? (r.passesCompletionGate ? '✓' : '⚠ gate') : '✗';
      const comp = r.completability
        ? `${r.completability.pass ? 'PASS' : 'FAIL'} ${r.completability.score.toFixed(1)}`
        : '-';
      const note = (r.error ? r.error : (r.completability?.rationale ?? r.judge?.rationale ?? ''))
        .slice(0, 120)
        .replace(/\|/g, '/');
      lines.push(
        `| ${r.caseId} | ${r.isScenario ? 'S' : 'N'} | ${variant} | ${status} | ${r.milestoneCount} | ${r.microtaskCount} | ${formatDuration(
          r.durationMs,
        )} | ${comp} | ${r.completability ? completabilityBlockerList(r.completability) : '-'} | ${
          r.judge ? r.judge.overall.toFixed(1) : '-'
        } | ${r.judge ? r.judge.redLines.join(',') || '—' : '-'} | ${note} |`,
      );
    }
  }
  writeFileSync(join(runDir, 'report.md'), lines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const modelStr = process.env.EVAL_PBL_MODEL!;
  const judgeStr = process.env.EVAL_PBL_JUDGE_MODEL || `${modelStr} (self)`;
  const model = createModel();
  const judgeModel = createJudgeModel(model);
  const thinkingConfig = createThinkingConfig();
  const variants = selectedVariants();

  const allCases = loadTestCases();
  const filter = process.env.EVAL_PBL_FILTER;
  const filtered = filter ? allCases.filter((c) => c.id.includes(filter)) : allCases;
  const maxRuns = parseInt(process.env.EVAL_PBL_RUNS || String(filtered.length), 10);
  const testCases = filtered.slice(0, maxRuns);

  // Compute the run dir up front so projects can be dumped as they finish
  // (partial results survive a crash on a long run).
  const sanitizedModel = modelStr.replace(/[:/]/g, '-');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = join(getCurrentDir(), 'results', sanitizedModel, timestamp);
  const projectsDir = join(runDir, 'projects');
  mkdirSync(projectsDir, { recursive: true });

  const concurrency = parseInt(process.env.EVAL_PBL_CONCURRENCY || '10', 10);
  const staggerMs = parseInt(process.env.EVAL_PBL_STAGGER_MS || '1000', 10);
  console.log(
    `\nHarness: ${testCases.length} case(s) × ${variants.length} variant(s) [${variants.join(', ')}]`,
  );
  console.log(`Generation model: ${modelStr}`);
  console.log(`Judge model:      ${judgeEnabled() ? judgeStr : 'off'}`);
  console.log(
    `Thinking: ${thinkingConfig?.enabled ? `on (budget: ${thinkingConfig.budgetTokens ?? 'default'})` : 'off'}`,
  );
  console.log(`Concurrency: ${concurrency} | stagger: ${staggerMs}ms`);
  console.log(`Output dir: ${runDir}`);
  console.log('');

  // Flat job list (case-major: both variants of a case adjacent).
  const jobs: Array<{ tc: TestCase; variant: Variant; n: number }> = [];
  for (let i = 0; i < testCases.length; i++) {
    for (const variant of variants) jobs.push({ tc: testCases[i], variant, n: i + 1 });
  }
  const total = jobs.length;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Run with a concurrency cap of `concurrency` and a `staggerMs` gap between
  // successive launches (so calls don't all hit the gateway at once).
  const results: RunResult[] = new Array(total);
  const executing = new Set<Promise<void>>();
  let done = 0;
  for (let j = 0; j < jobs.length; j++) {
    const { tc, variant, n } = jobs[j];
    if (j > 0) await sleep(staggerMs);
    const p = (async () => {
      const result = await runOne(tc, variant, n, model, judgeModel, thinkingConfig);
      results[j] = result;

      if (result.project) {
        writeFileSync(
          join(projectsDir, `${tc.id}__${variant}.json`),
          JSON.stringify(result.project, null, 2),
          'utf-8',
        );
      }

      done += 1;
      const tag = `[${done}/${total}] ${tc.id} [${variant}]`;
      if (result.ok && result.passesCompletionGate) {
        const completion = result.completability
          ? ` complete=${result.completability.pass ? 'PASS' : 'FAIL'}:${result.completability.score.toFixed(
              1,
            )}${
              result.completability.blockers.length > 0
                ? `:${result.completability.blockers.join(',')}`
                : ''
            }`
          : '';
        const redline =
          result.judge && result.judge.redLines.length > 0
            ? ` ⛔${result.judge.redLines.join(',')}`
            : '';
        process.stdout.write(
          `  ${tag} ✓ ${result.milestoneCount}ms ${result.microtaskCount}mt${completion}${result.judge ? ` judge=${result.judge.overall.toFixed(1)}${redline}` : ''} (${formatDuration(result.durationMs)})\n`,
        );
      } else if (result.ok) {
        process.stdout.write(`  ${tag} ⚠ gate fail (${formatDuration(result.durationMs)})\n`);
      } else {
        process.stdout.write(`  ${tag} ✗ FAIL (${formatDuration(result.durationMs)})\n`);
        if (result.error) console.log(`       ${result.error.slice(0, 120)}`);
      }
    })();
    const tracked = p.finally(() => executing.delete(tracked));
    executing.add(tracked);
    if (executing.size >= concurrency) await Promise.race(executing);
  }
  await Promise.all(executing);

  printReport(results, variants, modelStr);
  writeMarkdownReport(results, variants, modelStr, judgeStr, thinkingConfig, runDir);

  // Dump metrics (judge scores etc, minus the full project) for the
  // compare page, then build the self-contained side-by-side HTML.
  const slim = results.map(({ project: _project, ...rest }) => rest);
  writeFileSync(join(runDir, 'results.json'), JSON.stringify(slim, null, 2), 'utf-8');
  const compareHtml = buildCompareHtml(runDir);

  console.log(`Report saved:    ${runDir}/report.md`);
  console.log(`Projects dumped: ${projectsDir}/<case>__<variant>.json`);
  console.log(`Compare page:    file://${compareHtml}\n`);

  const allPassed = results.every(
    (r) =>
      r.ok &&
      r.passesCompletionGate &&
      (!judgeEnabled() || (r.completability !== undefined && r.completability.pass)),
  );
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(2);
});
