/**
 * Orchestration Director Eval Runner
 *
 * Builds the real director prompt for each scenario, calls an LLM, parses the
 * routing decision, and judges it against the scenario's expected outcome.
 *
 * For premature-END scenarios the judge is deterministic (no judge model needed).
 *
 * Required env:
 *   EVAL_INFERENCE_MODEL  Model for the director decision (or DEFAULT_MODEL)
 *
 * Usage:
 *   EVAL_INFERENCE_MODEL=<provider:model> pnpm eval:orchestration
 *
 * Output: eval/orchestration/results/<inference-model>/<timestamp>/report.md
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { callLLM } from '@/lib/ai/llm';
import { buildDirectorPrompt, parseDirectorDecision } from '@/lib/orchestration/director-prompt';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import { judgeDecision } from './judge';
import { writeReport } from './reporter';
import type { DirectorScenario, EvalResult } from './types';

const OUTPUT_DIR = 'eval/orchestration/results';

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function loadScenarios(): DirectorScenario[] {
  const path = join(getCurrentDir(), 'scenarios/premature-end.json');
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as DirectorScenario | DirectorScenario[];
  return Array.isArray(raw) ? raw : [raw];
}

function toAgentConfig(sc: DirectorScenario['input']['agents'][number]): AgentConfig {
  return {
    id: sc.id,
    name: sc.name,
    role: sc.role,
    priority: sc.priority,
    persona: '',
    avatar: '',
    color: '',
    allowedActions: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: false,
  };
}

async function runCase(
  scenario: DirectorScenario,
  inferenceModel: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
): Promise<EvalResult> {
  try {
    const agents = scenario.input.agents.map(toAgentConfig);
    const agentResponses = scenario.input.agentResponses.map((r) => ({
      ...r,
      whiteboardActions: [],
    }));

    const systemPrompt = buildDirectorPrompt(
      agents,
      scenario.input.conversationSummary,
      agentResponses,
      scenario.input.turnCount,
      scenario.input.discussionContext ?? null,
      null,
      undefined,
      scenario.input.userProfile,
      scenario.input.whiteboardOpen ?? false,
    );

    const result = await callLLM(
      {
        model: inferenceModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Decide which agent should speak next.' },
        ],
        temperature: 0,
      },
      'eval-orchestration',
    );

    const directorOutput = result.text;
    const decision = parseDirectorDecision(directorOutput);
    const judge = judgeDecision(scenario, decision.shouldEnd);

    return {
      case_id: scenario.case_id,
      category: scenario.category,
      description: scenario.description,
      directorOutput,
      shouldEnd: decision.shouldEnd,
      judgePassed: judge.pass,
      judgeReason: judge.reason,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      case_id: scenario.case_id,
      category: scenario.category,
      description: scenario.description,
      directorOutput: '',
      shouldEnd: true,
      judgePassed: false,
      judgeReason: `Exception: ${msg}`,
    };
  }
}

async function main() {
  const inferenceModelStr = process.env.EVAL_INFERENCE_MODEL || process.env.DEFAULT_MODEL;
  if (!inferenceModelStr) {
    console.error(
      'Error: EVAL_INFERENCE_MODEL (or DEFAULT_MODEL) must be set. Example: EVAL_INFERENCE_MODEL=openai:gpt-4.1',
    );
    process.exit(1);
  }

  console.log('=== Orchestration Director Eval ===');
  console.log(`Inference: ${inferenceModelStr}`);

  const { model: inferenceModel } = await resolveEvalModel(
    'EVAL_INFERENCE_MODEL',
    process.env.DEFAULT_MODEL,
  );

  const scenarios = loadScenarios();
  console.log(`Loaded ${scenarios.length} scenario(s)`);

  const runDir = createRunDir(OUTPUT_DIR, inferenceModelStr);
  console.log(`Output: ${runDir}`);

  const results: EvalResult[] = [];
  for (const scenario of scenarios) {
    console.log(`Running: ${scenario.case_id}`);
    const result = await runCase(scenario, inferenceModel);
    results.push(result);
    console.log(`  ${result.judgePassed ? 'PASS' : 'FAIL'} — ${result.judgeReason}`);
  }

  const reportPath = writeReport(runDir, results, { inferenceModel: inferenceModelStr });
  const passed = results.filter((r) => r.judgePassed).length;
  console.log(`\nReport: ${reportPath}`);
  console.log(`Passed: ${passed}/${results.length}`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
