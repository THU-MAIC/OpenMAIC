/**
 * Director Question-Answering Eval (#598 / #511 follow-up)
 *
 * Tests whether the director routes correctly when the conversation contains
 * an unanswered user question. The bug observed in production: when agents
 * have drifted off-topic — whether the user has expressed frustration yet
 * or not — the director keeps picking peer agents for "variety" instead of
 * routing to the teacher to actually answer the literal question.
 *
 * Scenarios cover both shapes:
 *   - first-turn drift, no frustration yet (the root case)
 *   - escalated frustration after multiple complaints (the recovery case)
 *
 * Per-decision classification (deterministic, no LLM judge):
 *   - TEACHER    → ✓ correct (teacher answers, or asks a clarifying question
 *                  when the user's message is too vague)
 *   - USER       → ✗ wrong (cue_user makes no agent speak — the user faces
 *                  dead air; the teacher should ask the clarifying question)
 *   - OTHER_AGENT → ✗ wrong (peer-agent "variety" routing)
 *   - END        → ✗ wrong
 *
 * A/B:
 *   - baseline  : current director template with rule 13 stripped
 *   - with_rule : current director template as-shipped (rule 13 in place)
 *
 * Pass criterion: with_rule.correctRate ≥ EVAL_PASS_THRESHOLD (default 0.7).
 * The pre-vs-post Δ is reported as informational only — scenarios where the
 * baseline already routes correctly shouldn't fail just because there is no
 * room to lift.
 *
 * Required env:
 *   EVAL_DIRECTOR_MODEL
 *
 * Optional env:
 *   EVAL_SAMPLES        Samples per (scenario, variant). Default 5.
 *   EVAL_PASS_THRESHOLD Min with_rule correct rate per scenario. Default 0.7.
 *   EVAL_SCENARIO       Filter to a single scenario by case_id.
 *
 * Output: eval/orchestration/results-answering/<model>/<timestamp>/report.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callLLM } from '@/lib/ai/llm';
import { parseDirectorDecision } from '@/lib/orchestration/director-prompt';
import {
  summarizeConversation,
  type OpenAIMessage,
} from '@/lib/orchestration/summarizers/conversation-summary';
import {
  processSnippets,
  processConditionalBlocks,
  interpolateVariables,
} from '@/lib/prompts/loader';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import type { AgentTurnSummary } from '@/lib/orchestration/types';
import type { ScenarioAgent } from './types';

const OUTPUT_DIR = 'eval/orchestration/results-answering';

// ==================== Types ====================

interface AnsweringScenario {
  case_id: string;
  description: string;
  agents: ScenarioAgent[];
  teacherAgentId: string;
  messages: OpenAIMessage[];
  agentResponses: AgentTurnSummary[];
  turnCount: number;
  whiteboardOpen?: boolean;
}

type Variant = 'baseline' | 'with_rule';
type DecisionClass = 'USER' | 'TEACHER' | 'OTHER_AGENT' | 'END' | 'ERROR';

interface SampleResult {
  variant: Variant;
  raw: string;
  classification: DecisionClass;
  rawAgentId: string | null;
  error?: string;
}

interface ScenarioResult {
  case_id: string;
  description: string;
  samples: number;
  baseline: { samples: SampleResult[]; rates: Record<DecisionClass, number>; correctRate: number };
  withRule: { samples: SampleResult[]; rates: Record<DecisionClass, number>; correctRate: number };
  delta: number;
  passes: boolean;
}

// ==================== Prompt building ====================

function readDirectorTemplate(): string {
  const p = path.join(process.cwd(), 'lib', 'prompts', 'templates', 'director', 'system.md');
  return fs.readFileSync(p, 'utf-8').trim();
}

/**
 * Rule 13 was injected directly into director/system.md. To A/B against a
 * pre-rule baseline, strip rule 13 (and its indented continuation block) out
 * of the current template.
 */
function withoutAnsweringRule(template: string): string {
  // Match rule 13 by its number (heading text is reworded often) up to the
  // next blank-line + section header. Decoupled from the heading wording.
  const stripped = template.replace(/^13\. \*\*[\s\S]*?(?=\n\n# )/m, '');
  if (stripped === template) {
    throw new Error(
      'answering-runner: rule 13 not found in director template; eval baseline cannot be constructed',
    );
  }
  return stripped.replace(/\n{3,}/g, '\n\n');
}

function buildPromptFromTemplate(
  template: string,
  scenario: AnsweringScenario,
  conversationSummary: string,
): string {
  const agentList = scenario.agents
    .map((a) => `- id: "${a.id}", name: "${a.name}", role: ${a.role}, priority: ${a.priority}`)
    .join('\n');

  const respondedList =
    scenario.agentResponses.length > 0
      ? scenario.agentResponses
          .map(
            (r) =>
              `- ${r.agentName} (${r.agentId}): "${r.contentPreview}" [${r.actionCount} actions]`,
          )
          .join('\n')
      : 'None yet.';

  const rule1 =
    "1. The teacher (role: teacher, highest priority) should usually speak first to address the user's question or topic.";

  const vars: Record<string, unknown> = {
    agentList,
    respondedList,
    conversationSummary,
    discussionSection: '',
    whiteboardSection: '',
    studentProfileSection: '',
    rule1,
    turnCountPlusOne: scenario.turnCount + 1,
    whiteboardOpenText: scenario.whiteboardOpen
      ? 'OPEN (slide canvas is hidden — spotlight/laser will not work)'
      : 'CLOSED (slide canvas is visible)',
  };

  const withSnippets = processSnippets(template);
  const withConditionals = processConditionalBlocks(withSnippets, vars);
  return interpolateVariables(withConditionals, vars);
}

function buildVariants(scenario: AnsweringScenario): { baseline: string; with_rule: string } {
  const current = readDirectorTemplate();
  const summary = summarizeConversation(scenario.messages);
  return {
    baseline: buildPromptFromTemplate(withoutAnsweringRule(current), scenario, summary),
    with_rule: buildPromptFromTemplate(current, scenario, summary),
  };
}

// ==================== Classifier ====================

function classify(
  raw: string,
  scenario: AnsweringScenario,
): {
  classification: DecisionClass;
  rawAgentId: string | null;
} {
  const parsed = parseDirectorDecision(raw);
  if (parsed.shouldEnd || !parsed.nextAgentId) {
    return { classification: 'END', rawAgentId: null };
  }
  if (parsed.nextAgentId === 'USER') {
    return { classification: 'USER', rawAgentId: 'USER' };
  }
  if (parsed.nextAgentId === scenario.teacherAgentId) {
    return { classification: 'TEACHER', rawAgentId: parsed.nextAgentId };
  }
  return { classification: 'OTHER_AGENT', rawAgentId: parsed.nextAgentId };
}

function emptyRates(): Record<DecisionClass, number> {
  return { USER: 0, TEACHER: 0, OTHER_AGENT: 0, END: 0, ERROR: 0 };
}

function computeRates(samples: SampleResult[]): {
  rates: Record<DecisionClass, number>;
  correctRate: number;
} {
  const rates = emptyRates();
  const usable = samples.filter((s) => !s.error);
  for (const s of usable) rates[s.classification]++;
  const total = usable.length || 1;
  for (const k of Object.keys(rates) as DecisionClass[]) {
    rates[k] = rates[k] / total;
  }
  rates.ERROR = (samples.length - usable.length) / samples.length;
  // Only TEACHER is correct: the teacher answers, or asks a clarifying question
  // for vague input. USER cue is dead air (no agent speaks); peer/END are wrong.
  const correctRate = rates.TEACHER;
  return { rates, correctRate };
}

// ==================== Sampling ====================

async function sampleVariant(
  scenario: AnsweringScenario,
  variant: Variant,
  systemPrompt: string,
  model: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
  samples: number,
): Promise<SampleResult[]> {
  const tasks = Array.from({ length: samples }, async (): Promise<SampleResult> => {
    try {
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Decide which agent should speak next.' },
          ],
        },
        'eval-orchestration-answering',
      );
      const raw = result.text;
      const { classification, rawAgentId } = classify(raw, scenario);
      return { variant, raw, classification, rawAgentId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        variant,
        raw: '',
        classification: 'ERROR',
        rawAgentId: null,
        error: msg,
      };
    }
  });
  return Promise.all(tasks);
}

// ==================== Reporting ====================

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function writeReport(
  runDir: string,
  results: ScenarioResult[],
  modelStr: string,
  samples: number,
  threshold: number,
): string {
  const lines: string[] = [];
  const overallPass = results.every((r) => r.passes);
  const meanBaseline = results.reduce((acc, r) => acc + r.baseline.correctRate, 0) / results.length;
  const meanWithRule = results.reduce((acc, r) => acc + r.withRule.correctRate, 0) / results.length;

  lines.push(`# Director Question-Answering Eval`, ``);
  lines.push(`- **Date**: ${new Date().toISOString()}`);
  lines.push(`- **Model**: ${modelStr}`);
  lines.push(`- **Samples per (scenario, variant)**: ${samples}`);
  lines.push(`- **with_rule correct-rate threshold**: ${pct(threshold)}`);
  lines.push(`- **Δ (pre vs post)**: informational — PASS depends only on with_rule rate`);
  lines.push(``);
  lines.push(`## Aggregate`);
  lines.push(``);
  lines.push(`| Variant | Mean correct rate (TEACHER) |`);
  lines.push(`|---|---|`);
  lines.push(`| baseline | ${pct(meanBaseline)} |`);
  lines.push(`| with_rule | ${pct(meanWithRule)} |`);
  lines.push(`| Δ | ${pct(meanWithRule - meanBaseline)} |`);
  lines.push(``);
  lines.push(`Overall verdict: **${overallPass ? 'PASS' : 'FAIL'}**`);
  lines.push(``);

  lines.push(`## Per scenario`);
  lines.push(``);
  lines.push(
    `| # | Scenario | Baseline USER% TEACHER% OTHER% END% | with_rule USER% TEACHER% OTHER% END% | Δ correct | pass? |`,
  );
  lines.push(`|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    const b = r.baseline.rates;
    const w = r.withRule.rates;
    const bStr = `${pct(b.USER)}/${pct(b.TEACHER)}/${pct(b.OTHER_AGENT)}/${pct(b.END)}`;
    const wStr = `${pct(w.USER)}/${pct(w.TEACHER)}/${pct(w.OTHER_AGENT)}/${pct(w.END)}`;
    lines.push(
      `| ${i + 1} | ${r.case_id} | ${bStr} | ${wStr} | ${pct(r.delta)} | ${r.passes ? '✓' : '✗'} |`,
    );
  });
  lines.push(``);

  lines.push(`## Detail`);
  for (const r of results) {
    lines.push(``, `### ${r.case_id} ${r.passes ? '✓' : '✗'}`, ``);
    lines.push(`- ${r.description}`);
    lines.push(
      `- Baseline correct: ${pct(r.baseline.correctRate)}; with_rule correct: ${pct(r.withRule.correctRate)}; Δ: ${pct(r.delta)}`,
    );
    lines.push(``);
    lines.push(`<details><summary>baseline samples</summary>`, ``);
    for (const s of r.baseline.samples) {
      const label = s.error
        ? `ERROR: ${s.error}`
        : `${s.classification}${s.rawAgentId && s.classification === 'OTHER_AGENT' ? ` (${s.rawAgentId})` : ''}`;
      lines.push(`- ${label}`);
    }
    lines.push(``, `</details>`, ``);
    lines.push(`<details><summary>with_rule samples</summary>`, ``);
    for (const s of r.withRule.samples) {
      const label = s.error
        ? `ERROR: ${s.error}`
        : `${s.classification}${s.rawAgentId && s.classification === 'OTHER_AGENT' ? ` (${s.rawAgentId})` : ''}`;
      lines.push(`- ${label}`);
    }
    lines.push(``, `</details>`, ``);
  }

  const reportPath = path.join(runDir, 'report.md');
  fs.writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

// ==================== Main ====================

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
}

function loadScenarios(): AnsweringScenario[] {
  const p = path.join(getCurrentDir(), 'scenarios/answering.json');
  const scenarios = JSON.parse(fs.readFileSync(p, 'utf-8')) as AnsweringScenario[];
  const filter = process.env.EVAL_SCENARIO;
  return filter ? scenarios.filter((s) => s.case_id === filter) : scenarios;
}

async function main() {
  const modelStr = process.env.EVAL_DIRECTOR_MODEL || process.env.DEFAULT_MODEL;
  if (!modelStr) {
    console.error(
      'Error: EVAL_DIRECTOR_MODEL must be set. Example: EVAL_DIRECTOR_MODEL=google:gemini-3-flash-preview',
    );
    process.exit(1);
  }
  const samples = Number(process.env.EVAL_SAMPLES || '5');
  const threshold = Number(process.env.EVAL_PASS_THRESHOLD || '0.7');

  console.log('=== Director Question-Answering Eval ===');
  console.log(`Model: ${modelStr} | Samples/variant: ${samples} | pass threshold: ${threshold}`);

  const { model } = await resolveEvalModel('EVAL_DIRECTOR_MODEL', process.env.DEFAULT_MODEL);
  const scenarios = loadScenarios();
  console.log(`Loaded ${scenarios.length} scenario(s)`);
  const runDir = createRunDir(OUTPUT_DIR, modelStr);
  console.log(`Output: ${runDir}`);

  const results: ScenarioResult[] = [];
  for (const sc of scenarios) {
    process.stdout.write(`  - ${sc.case_id} ... `);
    const variants = buildVariants(sc);
    const [bs, ws] = await Promise.all([
      sampleVariant(sc, 'baseline', variants.baseline, model, samples),
      sampleVariant(sc, 'with_rule', variants.with_rule, model, samples),
    ]);
    const bAgg = computeRates(bs);
    const wAgg = computeRates(ws);
    const lift = wAgg.correctRate - bAgg.correctRate;
    const passes = wAgg.correctRate >= threshold;
    results.push({
      case_id: sc.case_id,
      description: sc.description,
      samples,
      baseline: { samples: bs, rates: bAgg.rates, correctRate: bAgg.correctRate },
      withRule: { samples: ws, rates: wAgg.rates, correctRate: wAgg.correctRate },
      delta: lift,
      passes,
    });
    console.log(
      `baseline=${pct(bAgg.correctRate)} with_rule=${pct(wAgg.correctRate)} Δ=${pct(lift)} ${passes ? 'PASS' : 'FAIL'}`,
    );
  }

  const reportPath = writeReport(runDir, results, modelStr, samples, threshold);
  const overallPass = results.every((r) => r.passes);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Verdict: ${overallPass ? 'PASS' : 'FAIL'}`);
  process.exit(overallPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
