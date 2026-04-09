/**
 * Outline Language Inference — Real LLM Evaluation Tests
 *
 * Tests the language directive inferred during outline generation.
 * Uses the actual outline system prompt to infer languageDirective,
 * then an LLM-as-judge to evaluate against ground truth.
 *
 * Calls real LLM APIs — meant to be run locally, NOT in CI/CD.
 *
 * Environment variables:
 *   EVAL_INFERENCE_MODEL  Model for language inference (default: DEFAULT_MODEL or gpt-4o-mini)
 *   EVAL_JUDGE_MODEL      Model for LLM-as-judge (default: gpt-4o-mini)
 *
 * Usage:
 *   EVAL_INFERENCE_MODEL=google/gemini-2.5-flash-preview-04-17 \
 *   EVAL_JUDGE_MODEL=openai/gpt-4o-mini \
 *   pnpm vitest run tests/generation/outline-language.eval.test.ts
 *
 * Results are written to tests/generation/outline-language.eval.result.md
 */

import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { generateText } from 'ai';
import { buildPrompt, PROMPT_IDS } from '@/lib/generation/prompts';
import { resolveModel } from '@/lib/server/resolve-model';
import { parseJsonResponse } from '@/lib/generation/json-repair';

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

const JUDGE_MODEL_DEFAULT = 'openai/gpt-4o-mini';

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
// Language directive extraction via outline prompt
// ---------------------------------------------------------------------------

/**
 * Call the outline generation prompt but only ask for the languageDirective.
 * Uses the real system prompt to ensure we test the actual inference behavior,
 * but overrides the user prompt to skip full outline generation (saves tokens).
 */
async function inferLanguageDirectiveViaOutlinePrompt(
  requirement: string,
  pdfTextSample?: string,
): Promise<string> {
  const { model } = getInferenceModel();

  // Build the real system prompt (same one used in production)
  const prompts = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
    requirement,
    pdfContent: 'None',
    availableImages: 'No images available',
    userProfile: '',
    mediaGenerationPolicy:
      '**IMPORTANT: Do NOT include any mediaGenerations in the outlines. Both image and video generation are disabled.**',
    researchContext: 'None',
    teacherContext: '',
    pdfLanguageSample: pdfTextSample || '',
  });

  if (!prompts) {
    throw new Error('Failed to build outline prompt');
  }

  // Override user prompt: ask for ONLY the languageDirective, skip outlines
  const userPrompt = `${prompts.user}

**IMPORTANT: For this request, ONLY output the languageDirective field. Do NOT generate outlines.**

Output format:
{"languageDirective": "your 2-5 sentence directive here"}`;

  const result = await generateText({
    model,
    system: prompts.system,
    prompt: userPrompt,
    temperature: 0,
  });

  const parsed = parseJsonResponse<{ languageDirective: string }>(result.text);
  if (!parsed?.languageDirective) {
    throw new Error(`Failed to parse languageDirective: ${result.text.slice(0, 200)}`);
  }
  return parsed.languageDirective;
}

// ---------------------------------------------------------------------------
// LLM Judge (uses a small/fast model)
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
  const { model } = getJudgeModel();
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
  groundTruth: string;
  directive: string;
  judgePassed: boolean;
  judgeReason: string;
}

const results: EvalResult[] = [];

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

describe('Outline Language Inference Evaluation', () => {
  for (const tc of TEST_CASES) {
    it(
      `${tc.case_id}: ${tc.requirement.slice(0, 50)}`,
      { timeout: 60_000 },
      async () => {
        // Step 1: Infer language directive via outline prompt
        const directive = await inferLanguageDirectiveViaOutlinePrompt(tc.requirement);
        expect(directive, 'directive should not be empty').toBeTruthy();

        // Step 2: LLM-as-judge
        const judge = await judgeDirective(tc.requirement, directive, tc.ground_truth);

        results.push({
          case_id: tc.case_id,
          category: tc.category,
          requirement: tc.requirement,
          groundTruth: tc.ground_truth,
          directive,
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

    const inferenceModelStr = process.env.EVAL_INFERENCE_MODEL || process.env.DEFAULT_MODEL || '(default: gpt-4o-mini)';
    const judgeModelStr = process.env.EVAL_JUDGE_MODEL || JUDGE_MODEL_DEFAULT;

    const lines: string[] = [
      `# Outline Language Inference Eval Results`,
      ``,
      `- **Date**: ${new Date().toISOString()}`,
      `- **Passed**: ${passed}/${total} (${((passed / total) * 100).toFixed(0)}%)`,
      `- **Inference model**: ${inferenceModelStr}`,
      `- **Judge model**: ${judgeModelStr}`,
      `- **Method**: outline system prompt + LLM-as-judge`,
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
      lines.push(`- **Ground truth**: ${r.groundTruth}`);
      lines.push(`- **Directive**: ${r.directive}`);
      lines.push(`- **Judge**: ${r.judgePassed ? 'PASS' : 'FAIL'} — ${r.judgeReason}`);
      lines.push(``);
    }

    lines.push(`## Summary`);
    lines.push(``);
    lines.push(`| # | Case | Category | Result | Judge reason |`);
    lines.push(`|---|------|----------|--------|--------------|`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const icon = r.judgePassed ? 'PASS' : 'FAIL';
      lines.push(
        `| ${i + 1} | ${r.case_id} | ${r.category} | ${icon} | ${r.judgeReason} |`,
      );
    }
    lines.push(``);

    const outPath = resolve(__dirname, 'outline-language.eval.result.md');
    writeFileSync(outPath, lines.join('\n'), 'utf-8');
    console.log(`\nResults written to: ${outPath}`);
  });
});
