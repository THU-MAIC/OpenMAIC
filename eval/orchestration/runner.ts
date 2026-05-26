/**
 * Orchestration Premature-END Regression Eval
 *
 * For each scenario, builds the director system prompt twice:
 *   - "pre-fix"  : current director/system.md with rules 10/11/12 removed
 *   - "post-fix" : current director/system.md as-shipped
 * Calls the LLM N times per variant, parses each decision, and reports the
 * END rate for both. A scenario "discriminates" when (pre − post) ≥ delta.
 *
 * Required env:
 *   EVAL_DIRECTOR_MODEL  Model under test (or DEFAULT_MODEL fallback)
 *
 * Optional env:
 *   EVAL_SAMPLES         Samples per (scenario, variant). Default 5.
 *   EVAL_DELTA           Discrimination threshold for pre-vs-post Δ (0..1). Default 0.3.
 *   EVAL_END_THRESHOLD   Max acceptable post-fix END rate per scenario (0..1). Default 0.2.
 *   EVAL_SCENARIO        Filter to a single scenario by case_id.
 *
 * Usage:
 *   EVAL_DIRECTOR_MODEL=openai:gpt-4.1-mini pnpm eval:orchestration
 *
 * Output: eval/orchestration/results/<model>/<timestamp>/report.md
 *
 * Exit code:
 *   0 — every scenario's post-fix END rate is at or below EVAL_END_THRESHOLD
 *       (the regression guard holds for this model)
 *   1 — some scenario's post-fix END rate exceeded the threshold
 *       (potential regression of #554's premature-END fix)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { callLLM } from '@/lib/ai/llm';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import { classifyDecision, endRate } from './judge';
import { buildVariants } from './prompt-variants';
import { writeReport } from './reporter';
import type { EvalReport, PromptVariant, SampleResult, Scenario, ScenarioResult } from './types';

const OUTPUT_DIR = 'eval/orchestration/results';

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function loadScenarios(): Scenario[] {
  const path = join(getCurrentDir(), 'scenarios/premature-end.json');
  const scenarios = JSON.parse(readFileSync(path, 'utf-8')) as Scenario[];
  const filter = process.env.EVAL_SCENARIO;
  return filter ? scenarios.filter((s) => s.case_id === filter) : scenarios;
}

function requireModelEnv(): string {
  const modelStr = process.env.EVAL_DIRECTOR_MODEL || process.env.DEFAULT_MODEL;
  if (!modelStr) {
    console.error(
      'Error: EVAL_DIRECTOR_MODEL (or DEFAULT_MODEL) must be set. Example: EVAL_DIRECTOR_MODEL=openai:gpt-4.1-mini',
    );
    process.exit(1);
  }
  return modelStr;
}

async function callDirector(
  model: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
  systemPrompt: string,
): Promise<string> {
  const result = await callLLM(
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Decide which agent should speak next.' },
      ],
    },
    'eval-orchestration',
  );
  return result.text;
}

async function sampleVariant(
  scenario: Scenario,
  variant: PromptVariant,
  systemPrompt: string,
  model: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
  samples: number,
): Promise<SampleResult[]> {
  const tasks = Array.from({ length: samples }, async (): Promise<SampleResult> => {
    try {
      const raw = await callDirector(model, systemPrompt);
      const { decision, isEnd } = classifyDecision(raw);
      return { variant, raw, decision, isEnd };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Don't conflate API failures with END decisions — that polluted earlier
      // sweeps (e.g. anthropic 'Forbidden' showing as 100% END). Mark erroneous
      // samples so the rate calculator excludes them.
      return { variant, raw: '', decision: 'ERROR', isEnd: false, error: msg };
    }
  });
  return Promise.all(tasks);
}

async function runScenario(
  scenario: Scenario,
  model: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
  samples: number,
  thresholdDelta: number,
  postFixEndThreshold: number,
): Promise<ScenarioResult> {
  const { preFix, postFix } = buildVariants({
    agents: scenario.agents,
    messages: scenario.messages,
    agentResponses: scenario.agentResponses,
    turnCount: scenario.turnCount,
    discussionContext: scenario.discussionContext ?? null,
    triggerAgentId: scenario.triggerAgentId ?? null,
    userProfile: scenario.userProfile,
    whiteboardOpen: scenario.whiteboardOpen ?? false,
  });

  const [preSamples, postSamples] = await Promise.all([
    sampleVariant(scenario, 'pre-fix', preFix, model, samples),
    sampleVariant(scenario, 'post-fix', postFix, model, samples),
  ]);

  const preRate = endRate(preSamples);
  const postRate = endRate(postSamples);
  const delta = preRate - postRate;
  return {
    case_id: scenario.case_id,
    description: scenario.description,
    samples,
    preFix: { endRate: preRate, samples: preSamples },
    postFix: { endRate: postRate, samples: postSamples },
    delta,
    discriminates: delta >= thresholdDelta,
    postFixPasses: postRate <= postFixEndThreshold,
  };
}

async function main() {
  const modelStr = requireModelEnv();
  const samples = Number(process.env.EVAL_SAMPLES || '5');
  const thresholdDelta = Number(process.env.EVAL_DELTA || '0.3');
  const postFixEndThreshold = Number(process.env.EVAL_END_THRESHOLD || '0.2');

  console.log('=== Director Premature-END Regression Eval ===');
  console.log(
    `Model: ${modelStr} | Samples/variant: ${samples} | Δ threshold: ${thresholdDelta} | post-fix END threshold: ${postFixEndThreshold}`,
  );

  const { model } = await resolveEvalModel('EVAL_DIRECTOR_MODEL', process.env.DEFAULT_MODEL);
  const scenarios = loadScenarios();
  console.log(`Loaded ${scenarios.length} scenario(s)`);

  const runDir = createRunDir(OUTPUT_DIR, modelStr);
  console.log(`Output: ${runDir}`);

  const results: ScenarioResult[] = [];
  for (const sc of scenarios) {
    process.stdout.write(`  - ${sc.case_id} ... `);
    const r = await runScenario(sc, model, samples, thresholdDelta, postFixEndThreshold);
    results.push(r);
    console.log(
      `pre=${Math.round(r.preFix.endRate * 100)}% post=${Math.round(r.postFix.endRate * 100)}% Δ=${Math.round(r.delta * 100)}% ${r.postFixPasses ? 'PASS' : 'FAIL'}${r.discriminates ? ' (discriminates)' : ''}`,
    );
  }

  const anyDiscriminates = results.some((r) => r.discriminates);
  const allPostFixPass = results.every((r) => r.postFixPasses);
  const report: EvalReport = {
    model: modelStr,
    samplesPerVariant: samples,
    thresholdDelta,
    postFixEndThreshold,
    results,
    anyDiscriminates,
    allPostFixPass,
  };
  const reportPath = writeReport(runDir, report);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Post-fix regression guard: ${allPostFixPass ? 'PASS' : 'FAIL'}`);
  console.log(`Any scenario discriminates (informational): ${anyDiscriminates ? 'YES' : 'NO'}`);
  process.exit(allPostFixPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
