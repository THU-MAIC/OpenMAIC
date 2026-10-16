/**
 * Agent Answer-Content Eval (#511 / #599 follow-up — the CONTENT layer)
 *
 * The director question-answering eval (answering-runner.ts) only checks that
 * the DIRECTOR routes to the teacher. It never judges the teacher's reply, so
 * it cannot catch the failure mode where the director routes correctly but the
 * dispatched agent's FIRST sentence still drifts (greets / opens a lecture /
 * pivots) and only a LATER turn answers — "first sentence drifts, second answers".
 *
 * This eval closes that gap. Each sample is one in-process Pi classroom request
 * (see pi-harness.ts): the director runs its full tool loop — it decides whether
 * to read_scene — and dispatches children. The reply judged is the full text of
 * the FIRST RECORDED call_agent attempt naming the scenario's teacher, taken
 * from that attempt's own tool result (never peer text, a later teacher call,
 * or the truncated preview). An LLM judge decides:
 *   - leads_with_answer  : did the FIRST sentence(s) address the literal ask?
 *   - answered_anywhere  : did the reply address it AT ALL (even if late)?
 *
 * Limits of this measurement:
 *   - Pi caps a teacher reply at 1–2 short sentences, about the size of the
 *     two-sentence opening the judge reads, so the two metrics nearly coincide.
 *   - A sample scores 0 without a judge call when the run fails, no teacher
 *     attempt is recorded, or the first recorded one is skipped, marked
 *     isError, or has no text. So the score includes the routing step.
 *   - Only failures the trace exposes count. A teacher attempt rejected by the
 *     tool schema is not recorded, so a later recorded one is judged. A legacy
 *     child whose provider fails after streaming partial text is not marked as
 *     failed; that partial text is judged as the student would see it. Scores
 *     can therefore be overstated, and a judged reply is not proof of a
 *     complete answer or of an error-free run.
 *   - Results are a Pi baseline; they are not comparable with the retired
 *     single-prompt A/B.
 *
 * Scenarios are synthetic and anonymized, authored from a real-world failure
 * taxonomy (opening-lecture override, ignored format/capability/navigation
 * request, ignored correction, frustration re-ask, adjacent pivot, vague
 * clarify) plus clean controls. No real user data is included.
 *
 * Pass criterion: leads_with_answer rate >= EVAL_PASS_THRESHOLD (default 0.7)
 * per scenario.
 *
 * Required env:
 *   EVAL_AGENT_MODEL   Model for the whole Pi chain (director and children);
 *                      falls back to DEFAULT_MODEL
 *   EVAL_JUDGE_MODEL   Model used as the answer judge
 * Optional env:
 *   EVAL_SAMPLES        Samples per scenario. Default 3.
 *   EVAL_PASS_THRESHOLD Min leads rate per scenario. Default 0.7.
 *   EVAL_SCENARIO       Filter to a single scenario by case_id.
 *
 * Output: eval/orchestration/results-answer-content/<model>/<timestamp>/report.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { LanguageModel } from 'ai';
import type { AgentTurnSummary } from '@/lib/orchestration/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import { judgeAnswer, type AnswerVerdict } from './answer-content-judge';
import {
  callAgentTrace,
  runPiClassroomRequest,
  scenarioAgentConfig,
  type EvalModel,
  type PiDone,
} from './pi-harness';
import type { ScenarioAgent } from './types';

const OUTPUT_DIR = 'eval/orchestration/results-answer-content';

// ==================== Types ====================

interface ScenarioAgentSpec extends ScenarioAgent {
  persona: string;
}

interface ScenarioTurn {
  role: 'user' | 'agent';
  agentId?: string;
  text: string;
}

export interface ContentScenario {
  case_id: string;
  category: string;
  description: string;
  agents: ScenarioAgentSpec[];
  teacherAgentId: string;
  turns: ScenarioTurn[];
  answerKey: string;
  expectedPreFix?: string;
  /** Classroom context so the request matches the live shape/bulk: a topical
   * slide scene, the stage (incl. languageDirective), and the student
   * profile. Shapes mirror StatelessChatRequest.storeState. Use `scenes` +
   * `currentSceneId` for a multi-slide deck (e.g. so "skip to next page" is
   * well-posed); `scene` is the single-slide shorthand. */
  scene?: unknown;
  scenes?: unknown[];
  currentSceneId?: string;
  stage?: unknown;
  userProfile?: { nickname?: string; bio?: string };
  mode?: 'autonomous' | 'playback';
}

export interface SampleResult {
  leadText: string;
  fullText: string;
  verdict: AnswerVerdict;
  /** Why no teacher reply was judged; the sample scores 0. */
  noReply?: string;
  /** Run failure; the sample scores 0. */
  error?: string;
}

interface VariantAgg {
  samples: SampleResult[];
  leadsRate: number;
  answeredRate: number;
}

interface ScenarioResult extends VariantAgg {
  case_id: string;
  category: string;
  description: string;
  passes: boolean;
}

// ==================== Input construction ====================

/** Store state from the scenario's classroom context (slide scene + stage),
 * as the app sends it. The director reads scene content itself (read_scene);
 * nothing is preloaded into the prompt. Falls back to an empty state if a
 * scenario omits context. */
function buildStoreState(scenario: ContentScenario): StatelessChatRequest['storeState'] {
  const scenes = scenario.scenes ?? (scenario.scene ? [scenario.scene] : []);
  const currentSceneId =
    scenario.currentSceneId ?? (scenes[0] ? ((scenes[0] as { id?: string }).id ?? null) : null);
  return {
    stage: scenario.stage ?? null,
    scenes,
    currentSceneId,
    mode: scenario.mode ?? 'playback',
    whiteboardOpen: false,
  } as unknown as StatelessChatRequest['storeState'];
}

/** Turn list -> the UIMessage[] history of a classroom request. */
function buildMessages(scenario: ContentScenario): StatelessChatRequest['messages'] {
  const nameById = new Map(scenario.agents.map((a) => [a.id, a.name]));
  const messages = scenario.turns.map((turn, i) => {
    if (turn.role === 'user') {
      return {
        id: `user-${i}`,
        role: 'user' as const,
        parts: [{ type: 'text', text: turn.text }],
        metadata: { senderName: 'You', originalRole: 'user', createdAt: i },
      };
    }
    const agentId = turn.agentId ?? scenario.teacherAgentId;
    return {
      id: `assistant-${i}`,
      role: 'assistant' as const,
      parts: [{ type: 'text', text: turn.text }],
      metadata: { agentId, senderName: nameById.get(agentId) ?? agentId, createdAt: i },
    };
  });
  return messages as unknown as StatelessChatRequest['messages'];
}

/** Prior agent turns -> AgentTurnSummary[] for the director's peer context. */
function buildAgentResponses(scenario: ContentScenario): AgentTurnSummary[] {
  const nameById = new Map(scenario.agents.map((a) => [a.id, a.name]));
  return scenario.turns
    .filter((t) => t.role === 'agent')
    .map((t) => {
      const agentId = t.agentId ?? scenario.teacherAgentId;
      return {
        agentId,
        agentName: nameById.get(agentId) ?? agentId,
        contentPreview: t.text.slice(0, 200),
        actionCount: 0,
        whiteboardActions: [],
      };
    });
}

export function buildRequest(scenario: ContentScenario): StatelessChatRequest {
  return {
    messages: buildMessages(scenario),
    storeState: buildStoreState(scenario),
    config: {
      agentIds: scenario.agents.map((agent) => agent.id),
      agentConfigs: scenario.agents.map((agent) => scenarioAgentConfig(agent)),
      sessionType: 'qa',
    },
    directorState: {
      turnCount: 0,
      agentResponses: buildAgentResponses(scenario),
      whiteboardLedger: [],
    },
    userProfile: scenario.userProfile,
    apiKey: '',
  };
}

/** The first recorded teacher call_agent attempt and its full reply text, or why there is none. */
export function firstTeacherReply(
  done: PiDone,
  teacherAgentId: string,
): { text: string } | { noReply: string } {
  const call = callAgentTrace(done).find(
    (entry) => (entry.args as { agentId?: unknown } | undefined)?.agentId === teacherAgentId,
  );
  if (!call) return { noReply: 'director never called the teacher' };
  const details = call.details as
    | { skipped?: boolean; reason?: string; text?: unknown }
    | undefined;
  if (details?.skipped) {
    return { noReply: `first teacher call skipped: ${details.reason ?? 'unknown'}` };
  }
  if (call.isError) return { noReply: 'first teacher call failed' };
  const text = typeof details?.text === 'string' ? details.text.trim() : '';
  if (!text) return { noReply: 'first teacher call produced no text' };
  return { text };
}

/** Split into sentences across both Latin and CJK terminators, keeping order. */
function splitSentences(s: string): string[] {
  return s
    .split(/(?<=[.!?。！？])\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * The "opening" judged for leads_with_answer: the first ~2 speech sentences
 * across ALL ordered text blocks (not just the first block — a reply may be
 * several `type:"text"` items, e.g. [{"Sure."},{"The derivative is 2x."}]). Two
 * sentences let the judge distinguish a brief acknowledgement-then-answer
 * ("Sure. The derivative is 2x."), which the prompt allows, from a
 * greeting/lecture preamble before the answer ("Welcome! …" / "Today we'll
 * discuss parabolas. The formula is…"), which is the drift this eval catches.
 */
function leadFromTexts(texts: string[]): string {
  const joined = texts.join(' ');
  const sentences = splitSentences(joined);
  if (sentences.length === 0) return joined;
  return sentences.slice(0, 2).join(' ');
}

// ==================== Sampling ====================

function lastUserMessage(scenario: ContentScenario): string {
  for (let i = scenario.turns.length - 1; i >= 0; i--) {
    if (scenario.turns[i].role === 'user') return scenario.turns[i].text;
  }
  return '';
}

export async function sampleScenario(
  scenario: ContentScenario,
  evalModel: EvalModel,
  judgeModel: LanguageModel,
  samples: number,
): Promise<SampleResult[]> {
  const studentMessage = lastUserMessage(scenario);
  const tasks = Array.from({ length: samples }, async (): Promise<SampleResult> => {
    try {
      const { done } = await runPiClassroomRequest(buildRequest(scenario), evalModel);
      const reply = firstTeacherReply(done, scenario.teacherAgentId);
      if ('noReply' in reply) {
        return {
          leadText: '',
          fullText: '',
          verdict: { leads_with_answer: false, answered_anywhere: false, reason: reply.noReply },
          noReply: reply.noReply,
        };
      }
      const leadText = leadFromTexts([reply.text]);
      const fullText = reply.text;
      const verdict = await judgeAnswer(
        judgeModel,
        studentMessage,
        scenario.answerKey,
        leadText,
        fullText,
      );
      return { leadText, fullText, verdict };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        leadText: '',
        fullText: '',
        verdict: { leads_with_answer: false, answered_anywhere: false, reason: msg, error: true },
        error: msg,
      };
    }
  });
  return Promise.all(tasks);
}

export function aggregate(samples: SampleResult[]): VariantAgg {
  // Errors count as failures for an eval gate: the denominator is ALL requested
  // samples, so a scenario cannot "pass" on one good sample while the rest error
  // out. An errored sample (generation or judge failure) contributes 0.
  const n = samples.length || 1;
  const ok = (s: SampleResult) => !s.error && !s.verdict.error;
  const leadsRate = samples.filter((s) => ok(s) && s.verdict.leads_with_answer).length / n;
  const answeredRate = samples.filter((s) => ok(s) && s.verdict.answered_anywhere).length / n;
  return { samples, leadsRate, answeredRate };
}

// ==================== Reporting ====================

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function writeReport(
  runDir: string,
  results: ScenarioResult[],
  modelStr: string,
  judgeStr: string,
  samples: number,
  threshold: number,
): string {
  const lines: string[] = [];
  const overallPass = results.every((r) => r.passes);
  const meanLeads = results.reduce((a, r) => a + r.leadsRate, 0) / results.length;
  const meanAnswered = results.reduce((a, r) => a + r.answeredRate, 0) / results.length;

  lines.push(`# Agent Answer-Content Eval (Pi)`, ``);
  lines.push(`- **Date**: ${new Date().toISOString()}`);
  lines.push(`- **Model (director and children)**: ${modelStr}`);
  lines.push(`- **Judge model**: ${judgeStr}`);
  lines.push(`- **Samples per scenario**: ${samples}`);
  lines.push(`- **Leads-with-answer threshold**: ${pct(threshold)}`);
  lines.push(
    `- **Reply judged**: full text of the first recorded call_agent attempt naming the teacher. Samples score 0 out of all requested samples on a run or judge error, no recorded teacher attempt, or a first one that is skipped, marked isError or empty.`,
  );
  lines.push(
    `- **Limits**: only failures the trace exposes score 0 — a schema-rejected teacher attempt is not recorded (a later one is judged), and a legacy child provider failure after partial text is judged on that text, so scores can be overstated and a judged reply does not prove a complete answer or an error-free run. Pi caps teacher replies at 1–2 sentences, so leads-with-answer and answered-anywhere nearly coincide; the score includes the director's routing; a Pi baseline, not comparable with the retired prompt A/B. Route authorization and tool-capability checks are not exercised.`,
  );
  lines.push(``);
  lines.push(`## Aggregate`, ``);
  lines.push(`| Mean leads-with-answer | Mean answered-anywhere |`);
  lines.push(`|---|---|`);
  lines.push(`| ${pct(meanLeads)} | ${pct(meanAnswered)} |`);
  lines.push(``);
  lines.push(`Overall verdict: **${overallPass ? 'PASS' : 'FAIL'}**`, ``);

  lines.push(`## Per scenario`, ``);
  lines.push(`| # | case_id | category | leads | answered | no reply | errors | pass? |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    const noReply = r.samples.filter((s) => s.noReply).length;
    const errors = r.samples.filter((s) => s.error || s.verdict.error).length;
    lines.push(
      `| ${i + 1} | ${r.case_id} | ${r.category} | ${pct(r.leadsRate)} | ${pct(r.answeredRate)} | ${noReply} | ${errors} | ${r.passes ? '✓' : '✗'} |`,
    );
  });
  lines.push(``);

  lines.push(`## Detail`, ``);
  for (const r of results) {
    lines.push(`### ${r.case_id} ${r.passes ? '✓' : '✗'}`, ``);
    lines.push(`- ${r.description}`);
    lines.push(`- leads ${pct(r.leadsRate)} / answered ${pct(r.answeredRate)}`);
    lines.push(``, `<details><summary>samples</summary>`, ``);
    for (const s of r.samples) {
      if (s.error) {
        lines.push(`- ERROR: ${s.error}`);
        continue;
      }
      if (s.noReply) {
        lines.push(`- **NO_TEACHER_REPLY** — ${s.noReply}`);
        continue;
      }
      const tag = s.verdict.leads_with_answer
        ? 'LEADS'
        : s.verdict.answered_anywhere
          ? 'DRIFT→answered'
          : 'DRIFT';
      lines.push(`- **${tag}** — lead: "${s.leadText.slice(0, 140)}" — ${s.verdict.reason}`);
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

function loadScenarios(): ContentScenario[] {
  const p = path.join(getCurrentDir(), 'scenarios/answer-content.json');
  const scenarios = JSON.parse(fs.readFileSync(p, 'utf-8')) as ContentScenario[];
  const filter = process.env.EVAL_SCENARIO;
  return filter ? scenarios.filter((s) => s.case_id === filter) : scenarios;
}

async function main() {
  const modelStr = process.env.EVAL_AGENT_MODEL || process.env.DEFAULT_MODEL;
  const judgeStr = process.env.EVAL_JUDGE_MODEL;
  if (!modelStr) {
    console.error(
      'Error: EVAL_AGENT_MODEL (or DEFAULT_MODEL) must be set. Example: EVAL_AGENT_MODEL=google:gemini-3-flash-preview',
    );
    process.exit(1);
  }
  if (!judgeStr) {
    console.error(
      'Error: EVAL_JUDGE_MODEL must be set. Example: EVAL_JUDGE_MODEL=anthropic:claude-haiku-4-5',
    );
    process.exit(1);
  }
  const samples = Number(process.env.EVAL_SAMPLES || '3');
  const threshold = Number(process.env.EVAL_PASS_THRESHOLD || '0.7');

  console.log('=== Agent Answer-Content Eval (Pi) ===');
  console.log(`Model: ${modelStr} | Judge: ${judgeStr} | Samples: ${samples}`);

  const evalModel = await resolveEvalModel('EVAL_AGENT_MODEL', process.env.DEFAULT_MODEL);
  const { model: judgeModel } = await resolveEvalModel('EVAL_JUDGE_MODEL');
  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    const filter = process.env.EVAL_SCENARIO;
    console.error(
      filter
        ? `No scenario matches EVAL_SCENARIO="${filter}".`
        : 'No scenarios found in scenarios/answer-content.json.',
    );
    process.exit(1);
  }
  console.log(`Loaded ${scenarios.length} scenario(s)`);
  const runDir = createRunDir(OUTPUT_DIR, modelStr);
  console.log(`Output: ${runDir}`);

  const results: ScenarioResult[] = [];
  for (const sc of scenarios) {
    process.stdout.write(`  - ${sc.case_id} ... `);
    const agg = aggregate(await sampleScenario(sc, evalModel, judgeModel, samples));
    const passes = agg.leadsRate >= threshold;
    results.push({
      case_id: sc.case_id,
      category: sc.category,
      description: sc.description,
      ...agg,
      passes,
    });
    console.log(
      `leads=${pct(agg.leadsRate)} answered=${pct(agg.answeredRate)} ${passes ? 'PASS' : 'FAIL'}`,
    );
  }

  const reportPath = writeReport(runDir, results, modelStr, judgeStr, samples, threshold);
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
