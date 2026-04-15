/**
 * VLM Scorer for whiteboard layout quality.
 *
 * Uses the project's LLM infrastructure (resolveModel + generateText from AI SDK)
 * so model configuration follows the same `provider:model` convention as the rest
 * of the codebase. Supports all providers (OpenAI, Google, Anthropic, etc.).
 *
 * Environment variable: EVAL_SCORER_MODEL (default: openai:gpt-4o)
 */

import { readFileSync } from 'fs';
import { generateText } from 'ai';
import { resolveModel } from '@/lib/server/resolve-model';
import type { VlmScore } from './types';

const SCORER_MODEL_DEFAULT = 'openai:gpt-4o';

const RUBRIC_PROMPT = `You are a whiteboard layout quality reviewer. Evaluate the whiteboard screenshot below.

Score each dimension from 1 to 10:

1. readability: Is text clearly legible? Are font sizes appropriate? Are LaTeX formulas fully rendered?
2. overlap: Do any elements occlude or overlap each other? 10 = no overlap, 1 = severe occlusion.
3. space_utilization: Is content reasonably distributed across the canvas? Penalize clustering in one area or excessive empty space.
4. layout_logic: Are related elements grouped together? Is there a clear visual hierarchy and reading order?

Output ONLY a JSON object with this structure:
{"readability":{"score":N,"reason":"..."},"overlap":{"score":N,"reason":"..."},"space_utilization":{"score":N,"reason":"..."},"layout_logic":{"score":N,"reason":"..."},"overall":N,"issues":["..."]}`;

/**
 * Score a whiteboard screenshot using a VLM.
 *
 * Model is resolved via EVAL_SCORER_MODEL env var or the provided modelString,
 * using the same resolveModel() infrastructure as the rest of the project.
 */
export async function scoreScreenshot(
  screenshotPath: string,
  modelString?: string,
): Promise<VlmScore> {
  const imageBuffer = readFileSync(screenshotPath);

  const { model } = await resolveModel({
    modelString: modelString || process.env.EVAL_SCORER_MODEL || SCORER_MODEL_DEFAULT,
  });

  const result = await generateText({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: RUBRIC_PROMPT },
          { type: 'image', image: imageBuffer },
        ],
      },
    ],
    temperature: 0,
    maxOutputTokens: 1000,
  });

  const content = result.text;

  // Extract JSON from response (may be wrapped in markdown code fences)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`VLM returned non-JSON response: ${content.slice(0, 200)}`);
  }

  const raw = JSON.parse(jsonMatch[0]);

  // Validate required fields
  const dimensions = ['readability', 'overlap', 'space_utilization', 'layout_logic'] as const;
  for (const dim of dimensions) {
    if (!raw[dim] || typeof raw[dim].score !== 'number') {
      throw new Error(`VLM response missing or invalid dimension: ${dim}`);
    }
  }
  if (typeof raw.overall !== 'number') {
    throw new Error('VLM response missing overall score');
  }

  const score: VlmScore = {
    readability: raw.readability,
    overlap: raw.overlap,
    space_utilization: raw.space_utilization,
    layout_logic: raw.layout_logic,
    overall: raw.overall,
    issues: Array.isArray(raw.issues) ? raw.issues : [],
  };
  return score;
}
