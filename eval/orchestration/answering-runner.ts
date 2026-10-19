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
 * Each sample is one in-process Pi classroom request (see pi-harness.ts); the
 * director runs its full tool loop. The sample is classified by the FIRST
 * RECORDED call_agent tool attempt in the director tool trace (earlier
 * read_scene / web_search calls are fine; a later recorded attempt never
 * rescues the first):
 *   - TEACHER     → ✓ correct: the attempt names the scenario's teacher,
 *                   whether or not the teacher's own reply then succeeded
 *   - OTHER_AGENT → ✗ wrong: the attempt names another agent, or one that
 *                   does not exist (invalid_agent_id is recorded)
 *   - NO_DISPATCH → ✗ wrong: the run finished with no recorded call_agent.
 *                   The director cannot cue the user or close the session
 *                   before an agent has spoken in the request, so this is not
 *                   an END.
 *   - ERROR       : the run itself failed (threw, was aborted, or ended
 *                   without done), even when the director had already
 *                   dispatched an agent before the failure. Excluded from the
 *                   correct-rate denominator, as before; if every sample
 *                   errors the correct rate is 0.
 *
 * Limits: the correct rate is over non-ERROR samples only. It is not an
 * unconditional routing accuracy over every request, nor an end-to-end
 * completion rate. Excluding failed runs that had already dispatched can raise
 * the score, so read it together with the ERROR share and the number of valid
 * samples.
 *
 * Only recorded attempts count. A call_agent whose arguments fail the tool
 * schema is rejected by the agent runtime before the tool runs and is not in
 * the trace: a later recorded attempt is classified instead (and can score),
 * or the sample is NO_DISPATCH when none follows.
 *
 * Results are a Pi baseline; they are not comparable with the retired
 * single-step director prompt A/B.
 *
 * Pass criterion: correctRate ≥ EVAL_PASS_THRESHOLD (default 0.7) per scenario.
 *
 * Required env:
 *   EVAL_DIRECTOR_MODEL  Model for the whole Pi chain (director and children);
 *                        falls back to DEFAULT_MODEL
 *
 * Optional env:
 *   EVAL_SAMPLES        Samples per scenario. Default 5.
 *   EVAL_PASS_THRESHOLD Min correct rate per scenario. Default 0.7.
 *   EVAL_SCENARIO       Filter to a single scenario by case_id.
 *
 * Output: eval/orchestration/results-answering/<model>/<timestamp>/report.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AgentTurnSummary } from '@/lib/orchestration/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import {
  callAgentTrace,
  runPiClassroomRequest,
  scenarioAgentConfig,
  type EvalModel,
  type PiDone,
} from './pi-harness';
import type { ScenarioAgent } from './types';

const OUTPUT_DIR = 'eval/orchestration/results-answering';

// ==================== Types ====================

/** Fixture history: user turns carry a `[speaker]: ` label, agent turns the
 * old structured-output JSON array. */
interface ScenarioMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnsweringScenario {
  case_id: string;
  description: string;
  agents: ScenarioAgent[];
  teacherAgentId: string;
  messages: ScenarioMessage[];
  agentResponses: AgentTurnSummary[];
  turnCount: number;
  whiteboardOpen?: boolean;
}

type DecisionClass = 'TEACHER' | 'OTHER_AGENT' | 'NO_DISPATCH' | 'ERROR';

export interface SampleResult {
  classification: DecisionClass;
  /** agentId the first call_agent asked for. */
  rawAgentId: string | null;
  /** What the trace shows about the first call beyond its target. */
  note?: string;
  /** Run failure only: excludes the sample from the correct-rate denominator. */
  error?: string;
}

interface ScenarioResult {
  case_id: string;
  description: string;
  samples: SampleResult[];
  rates: Record<DecisionClass, number>;
  correctRate: number;
  passes: boolean;
}

// ==================== Request building ====================

const SPEAKER_LABEL = /^\[[^\]]*\]:\s*/;

/** Visible text of a fixture message, as the app would hold it. */
function messageText(message: ScenarioMessage): string {
  if (message.role === 'user') return message.content.replace(SPEAKER_LABEL, '');
  try {
    const items: unknown = JSON.parse(message.content);
    if (Array.isArray(items)) {
      return items
        .filter(
          (item): item is { type: 'text'; content: string } =>
            item?.type === 'text' && typeof item.content === 'string',
        )
        .map((item) => item.content)
        .join(' ');
    }
  } catch {
    // Not structured output: use the content as written.
  }
  return message.content;
}

export function buildRequest(scenario: AnsweringScenario): StatelessChatRequest {
  return {
    messages: scenario.messages.map((message, i) => ({
      id: `${message.role}-${i}`,
      role: message.role,
      parts: [{ type: 'text', text: messageText(message) }],
      metadata: { createdAt: i },
    })) as unknown as StatelessChatRequest['messages'],
    storeState: {
      stage: null,
      scenes: [],
      currentSceneId: null,
      mode: 'playback',
      whiteboardOpen: scenario.whiteboardOpen ?? false,
    },
    config: {
      agentIds: scenario.agents.map((agent) => agent.id),
      agentConfigs: scenario.agents.map((agent) => scenarioAgentConfig(agent)),
      sessionType: 'qa',
    },
    directorState: {
      turnCount: scenario.turnCount,
      agentResponses: scenario.agentResponses,
      whiteboardLedger: [],
    },
    apiKey: '',
  };
}

// ==================== Classifier ====================

export function classifyFirstDispatch(
  done: PiDone,
  scenario: AnsweringScenario,
): Omit<SampleResult, 'error'> {
  const first = callAgentTrace(done)[0];
  if (!first) {
    return { classification: 'NO_DISPATCH', rawAgentId: null };
  }
  const requested = (first.args as { agentId?: unknown } | undefined)?.agentId;
  const rawAgentId = typeof requested === 'string' ? requested : null;
  const details = first.details as { skipped?: boolean; reason?: string } | undefined;
  if (details?.skipped && details.reason === 'invalid_agent_id') {
    return { classification: 'OTHER_AGENT', rawAgentId, note: 'invalid_agent_id' };
  }
  const note = details?.skipped
    ? `skipped: ${details.reason ?? 'unknown'}`
    : first.isError
      ? 'agent reply failed'
      : undefined;
  return {
    classification: rawAgentId === scenario.teacherAgentId ? 'TEACHER' : 'OTHER_AGENT',
    rawAgentId,
    ...(note ? { note } : {}),
  };
}

function emptyRates(): Record<DecisionClass, number> {
  return { TEACHER: 0, OTHER_AGENT: 0, NO_DISPATCH: 0, ERROR: 0 };
}

export function computeRates(samples: SampleResult[]): {
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
  // for vague input. Peer routing and finishing without a dispatch are wrong.
  const correctRate = rates.TEACHER;
  return { rates, correctRate };
}

// ==================== Sampling ====================

export async function sampleScenario(
  scenario: AnsweringScenario,
  evalModel: EvalModel,
  samples: number,
): Promise<SampleResult[]> {
  const tasks = Array.from({ length: samples }, async (): Promise<SampleResult> => {
    try {
      const { done } = await runPiClassroomRequest(buildRequest(scenario), evalModel);
      return classifyFirstDispatch(done, scenario);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { classification: 'ERROR', rawAgentId: null, error: msg };
    }
  });
  return Promise.all(tasks);
}

// ==================== Reporting ====================

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function sampleLabel(s: SampleResult): string {
  if (s.error) return `ERROR: ${s.error}`;
  const target = s.rawAgentId && s.classification !== 'TEACHER' ? ` (${s.rawAgentId})` : '';
  return `${s.classification}${target}${s.note ? ` — ${s.note}` : ''}`;
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
  const meanCorrect = results.reduce((acc, r) => acc + r.correctRate, 0) / results.length;

  lines.push(`# Director Question-Answering Eval (Pi)`, ``);
  lines.push(`- **Date**: ${new Date().toISOString()}`);
  lines.push(`- **Model (director and children)**: ${modelStr}`);
  lines.push(`- **Samples per scenario**: ${samples}`);
  lines.push(`- **Correct-rate threshold**: ${pct(threshold)}`);
  lines.push(
    `- **Classification**: first recorded call_agent tool attempt in the director tool trace. Attempts rejected by the tool schema are not recorded, so a later recorded attempt is classified instead (or NO_DISPATCH if none). A run that threw, was aborted or ended without done is ERROR, even if it had already dispatched an agent, and ERROR samples are excluded from the correct rate.`,
  );
  lines.push(
    `- **Limits**: the correct rate covers non-ERROR samples only. It is not an unconditional routing accuracy over every request, nor an end-to-end completion rate. Excluding failed runs that had already dispatched can raise it, so read it together with the Errors and Valid columns. If every sample errors, the correct rate is 0.`,
  );
  lines.push(
    `- **Baseline**: Pi in-process run (legacy child, whiteboard tools on); not comparable with the retired single-step director A/B. Route authorization and tool-capability checks are not exercised.`,
  );
  lines.push(``);
  lines.push(`Mean correct rate (TEACHER): **${pct(meanCorrect)}**`, ``);
  lines.push(`Overall verdict: **${overallPass ? 'PASS' : 'FAIL'}**`, ``);

  lines.push(`## Per scenario`, ``);
  lines.push(`| # | Scenario | TEACHER | OTHER_AGENT | NO_DISPATCH | Errors | Valid | pass? |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    const errors = r.samples.filter((s) => s.error).length;
    lines.push(
      `| ${i + 1} | ${r.case_id} | ${pct(r.rates.TEACHER)} | ${pct(r.rates.OTHER_AGENT)} | ${pct(r.rates.NO_DISPATCH)} | ${errors} | ${r.samples.length - errors} | ${r.passes ? '✓' : '✗'} |`,
    );
  });
  lines.push(``);

  lines.push(`## Detail`);
  for (const r of results) {
    lines.push(``, `### ${r.case_id} ${r.passes ? '✓' : '✗'}`, ``);
    lines.push(`- ${r.description}`);
    lines.push(`- Correct: ${pct(r.correctRate)}`);
    lines.push(``, `<details><summary>samples</summary>`, ``);
    for (const s of r.samples) lines.push(`- ${sampleLabel(s)}`);
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

  console.log('=== Director Question-Answering Eval (Pi) ===');
  console.log(`Model: ${modelStr} | Samples: ${samples} | pass threshold: ${threshold}`);

  const evalModel = await resolveEvalModel('EVAL_DIRECTOR_MODEL', process.env.DEFAULT_MODEL);
  const scenarios = loadScenarios();
  console.log(`Loaded ${scenarios.length} scenario(s)`);
  const runDir = createRunDir(OUTPUT_DIR, modelStr);
  console.log(`Output: ${runDir}`);

  const results: ScenarioResult[] = [];
  for (const sc of scenarios) {
    process.stdout.write(`  - ${sc.case_id} ... `);
    const sampled = await sampleScenario(sc, evalModel, samples);
    const { rates, correctRate } = computeRates(sampled);
    const passes = correctRate >= threshold;
    results.push({
      case_id: sc.case_id,
      description: sc.description,
      samples: sampled,
      rates,
      correctRate,
      passes,
    });
    console.log(`correct=${pct(correctRate)} ${passes ? 'PASS' : 'FAIL'}`);
  }

  const reportPath = writeReport(runDir, results, modelStr, samples, threshold);
  const overallPass = results.every((r) => r.passes);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Verdict: ${overallPass ? 'PASS' : 'FAIL'}`);
  process.exit(overallPass ? 0 : 1);
}

// Run only as the CLI entry point, so tests can import the runner's functions.
const isEntryPoint =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
