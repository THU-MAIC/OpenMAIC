/**
 * Outline Language Inference — Real LLM Evaluation Runner
 *
 * Calls generateSceneOutlinesFromRequirements for each test case, then uses
 * an LLM-as-judge to score the inferred languageDirective against ground truth.
 *
 * Required env:
 *   EVAL_INFERENCE_MODEL  Model for outline generation (or DEFAULT_MODEL)
 *   EVAL_JUDGE_MODEL      Model for LLM-as-judge
 *
 * Usage:
 *   EVAL_INFERENCE_MODEL=<provider:model> EVAL_JUDGE_MODEL=<provider:model> \
 *   pnpm eval:outline-language
 *
 * Output: eval/outline-language/results/<inference-model>/<timestamp>/report.md
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateSceneOutlinesFromRequirements } from '@/lib/generation/outline-generator';
import { callLLM } from '@/lib/ai/llm';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import { judgeDirective } from './judge';
import { writeReport } from './reporter';
import type { LanguageTestCase, EvalResult } from './types';

const OUTPUT_DIR = 'eval/outline-language/results';

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function loadScenarios(): LanguageTestCase[] {
  const path = join(getCurrentDir(), 'scenarios/language-test-cases.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as LanguageTestCase[];
}

// Pre-validate env with tailored messages (including example model strings).
// resolveEvalModel() also throws on missing vars, but with a shorter message;
// surfacing the example before any async work makes misconfiguration obvious.
function requireModelEnv(): { inferenceModelStr: string; judgeModelStr: string } {
  const inferenceModelStr = process.env.EVAL_INFERENCE_MODEL || process.env.DEFAULT_MODEL;
  const judgeModelStr = process.env.EVAL_JUDGE_MODEL;
  if (!inferenceModelStr) {
    console.error(
      'Error: EVAL_INFERENCE_MODEL (or DEFAULT_MODEL) must be set. Example: EVAL_INFERENCE_MODEL=openai:gpt-4.1',
    );
    process.exit(1);
  }
  if (!judgeModelStr) {
    console.error(
      'Error: EVAL_JUDGE_MODEL must be set. Example: EVAL_JUDGE_MODEL=anthropic:claude-haiku-4-5',
    );
    process.exit(1);
  }
  return { inferenceModelStr, judgeModelStr };
}

async function runCase(
  tc: LanguageTestCase,
  aiCall: AICallFn,
  judgeModel: Awaited<ReturnType<typeof resolveEvalModel>>['model'],
): Promise<EvalResult> {
  try {
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: tc.requirement },
      tc.pdfTextSample || undefined,
      undefined,
      aiCall,
      undefined,
    );

    if (!result.success || !result.data) {
      return {
        case_id: tc.case_id,
        category: tc.category,
        requirement: tc.requirement,
        pdfTextSample: tc.pdfTextSample,
        groundTruth: tc.ground_truth,
        directive: '',
        outlinesCount: 0,
        judgePassed: false,
        judgeReason: `Outline generation failed: ${result.error || 'unknown error'}`,
      };
    }

    const { languageDirective, outlines } = result.data;
    const judge = await judgeDirective(
      judgeModel,
      tc.requirement,
      languageDirective,
      tc.ground_truth,
    );

    return {
      case_id: tc.case_id,
      category: tc.category,
      requirement: tc.requirement,
      pdfTextSample: tc.pdfTextSample,
      groundTruth: tc.ground_truth,
      directive: languageDirective,
      outlinesCount: outlines.length,
      judgePassed: judge.pass,
      judgeReason: judge.reason,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      case_id: tc.case_id,
      category: tc.category,
      requirement: tc.requirement,
      pdfTextSample: tc.pdfTextSample,
      groundTruth: tc.ground_truth,
      directive: '',
      outlinesCount: 0,
      judgePassed: false,
      judgeReason: `Exception: ${msg}`,
    };
  }
}

async function main() {
  const { inferenceModelStr, judgeModelStr } = requireModelEnv();

  console.log('=== Outline Language Inference Eval ===');
  console.log(`Inference: ${inferenceModelStr} | Judge: ${judgeModelStr}`);

  const { model: inferenceModel, modelInfo } = await resolveEvalModel(
    'EVAL_INFERENCE_MODEL',
    process.env.DEFAULT_MODEL,
  );
  const { model: judgeModel } = await resolveEvalModel('EVAL_JUDGE_MODEL');

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: inferenceModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'eval-outline-language',
    );
    return result.text;
  };

  const cases = loadScenarios();
  console.log(`Loaded ${cases.length} test case(s)`);

  const runDir = createRunDir(OUTPUT_DIR, inferenceModelStr);
  console.log(`Output: ${runDir}`);

  const results = await Promise.all(cases.map((tc) => runCase(tc, aiCall, judgeModel)));

  const reportPath = writeReport(runDir, results, {
    inferenceModel: inferenceModelStr,
    judgeModel: judgeModelStr,
  });
  const passed = results.filter((r) => r.judgePassed).length;
  console.log(`\nReport: ${reportPath}`);
  console.log(`Passed: ${passed}/${results.length}`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
