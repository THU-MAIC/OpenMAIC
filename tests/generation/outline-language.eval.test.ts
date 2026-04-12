/**
 * Outline Language Inference — Real LLM Evaluation Tests
 *
 * Tests the languageDirective inferred during REAL outline generation.
 * Calls the actual generateSceneOutlinesFromRequirements function,
 * then uses an LLM-as-judge to evaluate the directive against ground truth.
 *
 * Calls real LLM APIs — meant to be run locally, NOT in CI/CD.
 *
 * Environment variables:
 *   EVAL_INFERENCE_MODEL  Model for outline generation (default: DEFAULT_MODEL or gpt-4o-mini)
 *   EVAL_JUDGE_MODEL      Model for LLM-as-judge (default: openai:gpt-4o-mini)
 *
 * Usage:
 *   EVAL_INFERENCE_MODEL=google:gemini-3-flash-preview \
 *   EVAL_JUDGE_MODEL=openai:gpt-4o-mini \
 *   pnpm vitest run tests/generation/outline-language.eval.test.ts
 *
 * Results are written to tests/generation/outline-language.eval.result.md
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { generateText } from 'ai';
import { generateSceneOutlinesFromRequirements } from '@/lib/generation/outline-generator';
import { resolveModel } from '@/lib/server/resolve-model';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import { callLLM } from '@/lib/ai/llm';

// ---------------------------------------------------------------------------
// Test case definition
// ---------------------------------------------------------------------------

interface LanguageTestCase {
  case_id: string;
  category: string;
  requirement: string;
  prod_language: string;
  prod_id: string;
  prod_name: string;
  ground_truth: string;
  pdfTextSample?: string;
}

// ---------------------------------------------------------------------------
// Load test cases from JSON (curated from production data)
// ---------------------------------------------------------------------------

const TEST_CASES: LanguageTestCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'language-test-cases.json'), 'utf-8'),
);

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

const JUDGE_MODEL_DEFAULT = 'openai:gpt-4o-mini';

/** Resolve the inference model (EVAL_INFERENCE_MODEL → DEFAULT_MODEL → gpt-4o-mini) */
function getInferenceModel() {
  return resolveModel({
    modelString: process.env.EVAL_INFERENCE_MODEL || undefined,
  });
}

/** Resolve the judge model (EVAL_JUDGE_MODEL → gpt-4o-mini) */
function getJudgeModel() {
  return resolveModel({
    modelString: process.env.EVAL_JUDGE_MODEL || JUDGE_MODEL_DEFAULT,
  });
}

// ---------------------------------------------------------------------------
// Build AICallFn from the inference model
// ---------------------------------------------------------------------------

async function buildAICallFn(): Promise<AICallFn> {
  const { model: languageModel, modelInfo } = await getInferenceModel();
  return async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
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
}

// ---------------------------------------------------------------------------
// LLM Judge
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are evaluating whether a language directive for an AI course generation system is reasonable given the expected behavior.

You will be given:
1. The original user requirement
2. The generated language directive
3. The ground truth description of expected behavior

Evaluation criteria — the directive should:
- Use the correct primary teaching language
- Handle terminology in a reasonable way for the subject and audience
- For cross-language scenarios (foreign language learning, cross-language PDF), acknowledge both languages

Be LENIENT in your evaluation:
- The directive does NOT need to match the ground truth word-for-word
- Different but equally valid approaches should PASS
- If the teaching language is correct and the overall approach is reasonable, it should PASS
- Only FAIL if the directive is clearly WRONG (e.g., wrong teaching language, completely ignoring a cross-language situation)

Respond with ONLY a JSON object:
{"pass": true/false, "reason": "brief explanation (1-2 sentences)"}`;

interface JudgeResult {
  pass: boolean;
  reason: string;
}

async function judgeDirective(
  requirement: string,
  directive: string,
  groundTruth: string,
): Promise<JudgeResult> {
  const { model } = await getJudgeModel();
  const result = await generateText({
    model,
    system: JUDGE_SYSTEM_PROMPT,
    prompt: `Requirement: "${requirement}"\n\nGenerated directive: "${directive}"\n\nGround truth: "${groundTruth}"`,
    temperature: 0,
  });

  try {
    const text = result.text.replace(/```json\s*|\s*```/g, '').trim();
    return JSON.parse(text) as JudgeResult;
  } catch {
    return { pass: false, reason: `Failed to parse judge response: ${result.text}` };
  }
}

// ---------------------------------------------------------------------------
// Result collector
// ---------------------------------------------------------------------------

interface EvalResult {
  case_id: string;
  category: string;
  requirement: string;
  pdfTextSample?: string;
  groundTruth: string;
  directive: string;
  outlinesCount: number;
  judgePassed: boolean;
  judgeReason: string;
}

const results: EvalResult[] = [];

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

describe('Outline Language Inference Evaluation', () => {
  let aiCall: AICallFn;

  beforeAll(async () => {
    aiCall = await buildAICallFn();
  });

  for (const tc of TEST_CASES) {
    it.concurrent(
      `${tc.case_id}: ${tc.requirement.slice(0, 50)}`,
      { timeout: 120_000 },
      async () => {
        // Call the REAL outline generation function
        const result = await generateSceneOutlinesFromRequirements(
          { requirement: tc.requirement },
          tc.pdfTextSample || undefined, // pass PDF text if available
          undefined, // no PDF images
          aiCall,
          undefined, // no callbacks
        );

        expect(result.success, `Outline generation failed: ${result.error}`).toBe(true);
        expect(result.data).toBeDefined();

        const { languageDirective, outlines } = result.data!;
        expect(languageDirective, 'languageDirective should not be empty').toBeTruthy();
        expect(outlines.length, 'should generate at least 1 outline').toBeGreaterThan(0);

        // LLM-as-judge
        const judge = await judgeDirective(tc.requirement, languageDirective, tc.ground_truth);

        results.push({
          case_id: tc.case_id,
          category: tc.category,
          requirement: tc.requirement,
          pdfTextSample: tc.pdfTextSample,
          groundTruth: tc.ground_truth,
          directive: languageDirective,
          outlinesCount: outlines.length,
          judgePassed: judge.pass,
          judgeReason: judge.reason,
        });

        expect(judge.pass, `Judge failed: ${judge.reason}`).toBe(true);
      },
    );
  }

  // Write results file after all tests
  afterAll(() => {
    if (results.length === 0) return;

    const passed = results.filter((r) => r.judgePassed).length;
    const total = results.length;
    const inferenceModelStr =
      process.env.EVAL_INFERENCE_MODEL || process.env.DEFAULT_MODEL || '(default: gpt-4o-mini)';
    const judgeModelStr = process.env.EVAL_JUDGE_MODEL || JUDGE_MODEL_DEFAULT;

    const lines: string[] = [
      `# Outline Language Inference Eval Results`,
      ``,
      `- **Date**: ${new Date().toISOString()}`,
      `- **Passed**: ${passed}/${total} (${((passed / total) * 100).toFixed(0)}%)`,
      `- **Inference model**: ${inferenceModelStr}`,
      `- **Judge model**: ${judgeModelStr}`,
      `- **Method**: real outline generation (generateSceneOutlinesFromRequirements) + LLM-as-judge`,
      `- **Test cases**: curated from production data`,
      ``,
      `## Detail`,
      ``,
    ];

    for (const r of results) {
      const icon = r.judgePassed ? 'PASS' : '**FAIL**';

      lines.push(`### ${icon} ${r.case_id}`);
      lines.push(``);
      lines.push(`- **Category**: ${r.category}`);
      lines.push(`- **Input**: \`${r.requirement}\``);
      if (r.pdfTextSample) {
        lines.push(`- **PDF sample**: \`${r.pdfTextSample.slice(0, 80)}...\``);
      }
      lines.push(`- **Ground truth**: ${r.groundTruth}`);
      lines.push(`- **Directive**: ${r.directive}`);
      lines.push(`- **Outlines generated**: ${r.outlinesCount}`);
      lines.push(`- **Judge**: ${r.judgePassed ? 'PASS' : 'FAIL'} — ${r.judgeReason}`);
      lines.push(``);
    }

    lines.push(`## Summary`);
    lines.push(``);
    lines.push(`| # | Case | Category | Outlines | Result | Judge reason |`);
    lines.push(`|---|------|----------|----------|--------|--------------|`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const icon = r.judgePassed ? 'PASS' : 'FAIL';
      lines.push(
        `| ${i + 1} | ${r.case_id} | ${r.category} | ${r.outlinesCount} | ${icon} | ${r.judgeReason} |`,
      );
    }
    lines.push(``);

    const outPath = resolve(__dirname, 'outline-language.eval.result.md');
    writeFileSync(outPath, lines.join('\n'), 'utf-8');
    console.log(`\nResults written to: ${outPath}`);
  });
});
