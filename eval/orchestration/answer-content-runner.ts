/**
 * Agent Answer-Content Eval (#511 / #599 follow-up — the CONTENT layer)
 *
 * The director question-answering eval (answering-runner.ts) only checks that
 * the DIRECTOR routes to the teacher. It never generates the teacher's reply,
 * so it cannot catch the failure mode where the director routes correctly but
 * the dispatched agent's FIRST sentence still drifts (greets / opens a lecture /
 * pivots) and only a LATER turn answers — "first sentence drifts, second answers".
 *
 * This eval closes that gap. For each scenario it runs the REAL agent-generate
 * inputs — buildStructuredPrompt() + convertMessagesToOpenAI() — against the
 * model, parses the structured output with the app's runtime parser, and uses an
 * LLM judge to decide:
 *   - leads_with_answer  : did the FIRST sentence(s) address the literal ask?
 *   - answered_anywhere  : did the reply address it AT ALL (even if late)?
 * The gap (answered_anywhere && !leads_with_answer) quantifies the
 * drift-then-answer pathology directly.
 *
 * Scenarios are synthetic and anonymized, authored from a real-world failure
 * taxonomy (opening-lecture override, ignored format/capability/navigation
 * request, ignored correction, frustration re-ask, adjacent pivot, vague
 * clarify) plus clean controls. No real user data is included.
 *
 * A/B (mirrors answering-runner's rule-13 strip):
 *   - baseline  : agent-system with the "Responding to the User's Turn" section stripped
 *   - with_rule : agent-system as-shipped
 *
 * Pass criterion: with_rule mean leads_with_answer rate >= EVAL_PASS_THRESHOLD
 * (default 0.7). Δ vs baseline is reported as informational.
 *
 * Required env:
 *   EVAL_AGENT_MODEL   Model used to generate the agent reply (or DEFAULT_MODEL)
 *   EVAL_JUDGE_MODEL   Model used as the answer judge
 * Optional env:
 *   EVAL_SAMPLES        Samples per (scenario, variant). Default 3.
 *   EVAL_PASS_THRESHOLD Min with_rule leads rate per scenario. Default 0.7.
 *   EVAL_SCENARIO       Filter to a single scenario by case_id.
 *
 * Output: eval/orchestration/results-answer-content/<model>/<timestamp>/report.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callLLM } from '@/lib/ai/llm';
import { buildStructuredPrompt } from '@/lib/orchestration/prompt-builder';
import { convertMessagesToOpenAI } from '@/lib/orchestration/summarizers/message-converter';
import {
  createParserState,
  parseStructuredChunk,
  finalizeParser,
} from '@/lib/orchestration/stateless-generate';
import { type AgentConfig, getActionsForRole } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary } from '@/lib/orchestration/types';
import type { StatelessChatRequest } from '@/lib/types/chat';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import { judgeAnswer, type AnswerVerdict } from './answer-content-judge';
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

interface ContentScenario {
  case_id: string;
  category: string;
  description: string;
  agents: ScenarioAgentSpec[];
  teacherAgentId: string;
  turns: ScenarioTurn[];
  answerKey: string;
  expectedPreFix?: string;
  /** Classroom context so the assembled prompt matches the live shape/bulk:
   * a topical slide scene, the stage (incl. languageDirective), and the
   * student profile. Shapes mirror StatelessChatRequest.storeState. Use `scenes`
   * + `currentSceneId` for a multi-slide deck (e.g. so "skip to next page" is
   * well-posed); `scene` is the single-slide shorthand. */
  scene?: unknown;
  scenes?: unknown[];
  currentSceneId?: string;
  stage?: unknown;
  userProfile?: { nickname?: string; bio?: string };
  mode?: 'autonomous' | 'playback';
}

type Variant = 'baseline' | 'with_rule';

interface SampleResult {
  variant: Variant;
  leadText: string;
  fullText: string;
  verdict: AnswerVerdict;
  error?: string;
}

interface VariantAgg {
  samples: SampleResult[];
  leadsRate: number;
  answeredRate: number;
}

interface ScenarioResult {
  case_id: string;
  category: string;
  description: string;
  baseline: VariantAgg;
  withRule: VariantAgg;
  delta: number;
  passes: boolean;
}

// ==================== Input construction ====================

/** Build a full AgentConfig for the teacher from the scenario spec. */
function buildTeacherConfig(scenario: ContentScenario): AgentConfig {
  const spec = scenario.agents.find((a) => a.id === scenario.teacherAgentId) ?? scenario.agents[0];
  return {
    id: spec.id,
    name: spec.name,
    role: spec.role,
    persona: spec.persona,
    avatar: '🧑‍🏫',
    color: '#6d28d9',
    // Use the canonical role action set (incl. play_video + full whiteboard) so
    // the assembled prompt's available-actions section matches production.
    allowedActions: getActionsForRole(spec.role),
    priority: spec.priority,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: true,
  };
}

/** Store state from the scenario's classroom context (slide scene + stage),
 * so buildStructuredPrompt produces the same "# Current State" shape/bulk as
 * the live agent-generate path. Falls back to an empty state if a scenario
 * omits context. */
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

/** Turn list -> the UIMessage[] shape convertMessagesToOpenAI expects. */
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

/** Prior agent turns -> AgentTurnSummary[] for peer context in the prompt. */
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

/**
 * Remove the "# Responding to the User's Turn" section from an assembled agent
 * system prompt to build the pre-fix baseline. Bounded by the next section header.
 */
function stripAnsweringSection(prompt: string): string {
  const re = /\n# Responding to the User's Turn[\s\S]*?(?=\n# Current State)/;
  if (!re.test(prompt)) {
    throw new Error(
      'answer-content-runner: "# Responding to the User\'s Turn" section not found in agent prompt; baseline cannot be constructed',
    );
  }
  return prompt.replace(re, '\n');
}

/** Extract ordered text blocks from a structured agent response. */
function extractTexts(raw: string): string[] {
  const state = createParserState();
  const streamed = parseStructuredChunk(raw, state);
  if (streamed.textChunks.length > 0) return streamed.textChunks;
  // Recover only when the model emitted plain prose (never opened a JSON array) —
  // finalizeParser then surfaces that prose as text. If an array WAS started but
  // yielded no text (e.g. actions-only), the correct result is "no text"; we must
  // not fall through to finalizeParser's raw-buffer fallback, which would surface
  // action JSON as fake speech.
  if (!state.jsonStarted) return finalizeParser(state).textChunks;
  return [];
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

async function sampleVariant(
  scenario: ContentScenario,
  variant: Variant,
  systemPrompt: string,
  openaiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  agentModel: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
  judgeModel: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
  studentMessage: string,
  samples: number,
): Promise<SampleResult[]> {
  const tasks = Array.from({ length: samples }, async (): Promise<SampleResult> => {
    try {
      const gen = await callLLM(
        {
          model: agentModel,
          messages: [{ role: 'system', content: systemPrompt }, ...openaiMessages],
        },
        `eval-answer-content-${variant}`,
      );
      const texts = extractTexts(gen.text);
      const leadText = leadFromTexts(texts);
      const fullText = texts.join(' ');
      const verdict = await judgeAnswer(
        judgeModel,
        studentMessage,
        scenario.answerKey,
        leadText,
        fullText,
      );
      return { variant, leadText, fullText, verdict };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        variant,
        leadText: '',
        fullText: '',
        verdict: { leads_with_answer: false, answered_anywhere: false, reason: msg, error: true },
        error: msg,
      };
    }
  });
  return Promise.all(tasks);
}

function aggregate(samples: SampleResult[]): VariantAgg {
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
  const meanBaseLeads = results.reduce((a, r) => a + r.baseline.leadsRate, 0) / results.length;
  const meanRuleLeads = results.reduce((a, r) => a + r.withRule.leadsRate, 0) / results.length;
  const meanRuleAnswered =
    results.reduce((a, r) => a + r.withRule.answeredRate, 0) / results.length;

  lines.push(`# Agent Answer-Content Eval`, ``);
  lines.push(`- **Date**: ${new Date().toISOString()}`);
  lines.push(`- **Agent model**: ${modelStr}`);
  lines.push(`- **Judge model**: ${judgeStr}`);
  lines.push(`- **Samples per (scenario, variant)**: ${samples}`);
  lines.push(`- **with_rule leads-with-answer threshold**: ${pct(threshold)}`);
  lines.push(``);
  lines.push(`## Aggregate`, ``);
  lines.push(`| Variant | Mean leads-with-answer | Mean answered-anywhere |`);
  lines.push(`|---|---|---|`);
  lines.push(`| baseline (no answering rule) | ${pct(meanBaseLeads)} | — |`);
  lines.push(`| with_rule (as-shipped) | ${pct(meanRuleLeads)} | ${pct(meanRuleAnswered)} |`);
  lines.push(``);
  lines.push(
    `**Drift-then-answer gap (with_rule)**: answered-anywhere ${pct(meanRuleAnswered)} − leads ${pct(meanRuleLeads)} = **${pct(Math.max(0, meanRuleAnswered - meanRuleLeads))}** of replies answered only AFTER a drifting opener.`,
  );
  lines.push(``);
  lines.push(`Overall verdict: **${overallPass ? 'PASS' : 'FAIL'}**`, ``);

  lines.push(`## Per scenario`, ``);
  lines.push(
    `| # | case_id | category | baseline leads | with_rule leads | with_rule answered | Δ leads | pass? |`,
  );
  lines.push(`|---|---|---|---|---|---|---|---|`);
  results.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.case_id} | ${r.category} | ${pct(r.baseline.leadsRate)} | ${pct(r.withRule.leadsRate)} | ${pct(r.withRule.answeredRate)} | ${pct(r.delta)} | ${r.passes ? '✓' : '✗'} |`,
    );
  });
  lines.push(``);

  lines.push(`## Detail`, ``);
  for (const r of results) {
    lines.push(`### ${r.case_id} ${r.passes ? '✓' : '✗'}`, ``);
    lines.push(`- ${r.description}`);
    lines.push(
      `- baseline leads ${pct(r.baseline.leadsRate)}; with_rule leads ${pct(r.withRule.leadsRate)} / answered ${pct(r.withRule.answeredRate)}; Δ leads ${pct(r.delta)}`,
    );
    lines.push(``, `<details><summary>with_rule samples</summary>`, ``);
    for (const s of r.withRule.samples) {
      if (s.error) {
        lines.push(`- ERROR: ${s.error}`);
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

  console.log('=== Agent Answer-Content Eval ===');
  console.log(`Agent: ${modelStr} | Judge: ${judgeStr} | Samples/variant: ${samples}`);

  const { model: agentModel } = await resolveEvalModel(
    'EVAL_AGENT_MODEL',
    process.env.DEFAULT_MODEL,
  );
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

    const teacher = buildTeacherConfig(sc);
    const storeState = buildStoreState(sc);
    const agentResponses = buildAgentResponses(sc);
    const withRulePrompt = buildStructuredPrompt(
      teacher,
      storeState,
      undefined,
      [],
      sc.userProfile,
      agentResponses,
    );
    const baselinePrompt = stripAnsweringSection(withRulePrompt);
    const openaiMessages = convertMessagesToOpenAI(buildMessages(sc), sc.teacherAgentId);
    const studentMessage = lastUserMessage(sc);

    const [bs, ws] = await Promise.all([
      sampleVariant(
        sc,
        'baseline',
        baselinePrompt,
        openaiMessages,
        agentModel,
        judgeModel,
        studentMessage,
        samples,
      ),
      sampleVariant(
        sc,
        'with_rule',
        withRulePrompt,
        openaiMessages,
        agentModel,
        judgeModel,
        studentMessage,
        samples,
      ),
    ]);
    const baseline = aggregate(bs);
    const withRule = aggregate(ws);
    const delta = withRule.leadsRate - baseline.leadsRate;
    const passes = withRule.leadsRate >= threshold;
    results.push({
      case_id: sc.case_id,
      category: sc.category,
      description: sc.description,
      baseline,
      withRule,
      delta,
      passes,
    });
    console.log(
      `baseline=${pct(baseline.leadsRate)} with_rule=${pct(withRule.leadsRate)} answered=${pct(withRule.answeredRate)} ${passes ? 'PASS' : 'FAIL'}`,
    );
  }

  const reportPath = writeReport(runDir, results, modelStr, judgeStr, samples, threshold);
  const overallPass = results.every((r) => r.passes);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Verdict: ${overallPass ? 'PASS' : 'FAIL'}`);
  process.exit(overallPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
