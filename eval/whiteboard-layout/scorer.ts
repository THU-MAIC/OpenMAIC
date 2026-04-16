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

const RUBRIC_PROMPT = `You are evaluating a classroom whiteboard screenshot from an AI teaching assistant. Score like a teacher reviewing their own board work.

Context: This is a real-time teaching whiteboard. Teachers naturally write in one area before moving to the next — empty space is normal and NOT a problem. Focus on what would confuse or distract a student.

Score each dimension from 1 to 10:

1. readability: Is text clearly legible? Are font sizes CONSISTENT across elements (a major issue if some text is 3x larger than other text on the same board)? Is the handwriting/rendering clean?
2. overlap: Do any elements occlude or overlap each other? 10 = no overlap, 1 = severe occlusion where content is unreadable.
3. rendering_correctness: Are all LaTeX formulas correctly rendered (no raw LaTeX source like "\\frac" visible, no garbled text like "0ext" or "heta")? Are shapes/arrows drawn properly? 10 = everything renders correctly, 1 = multiple broken formulas or garbled text.
4. content_completeness: Is all content fully visible within the canvas (not cut off at edges)? Has previous content been preserved (not unexpectedly cleared)? Are diagrams labeled and annotated? 10 = all content intact and visible, 1 = significant content lost or truncated.
5. layout_logic: Are related elements grouped together? Is there a natural reading/teaching flow? Do diagrams and their labels/formulas form coherent visual units?

Output ONLY a JSON object with this structure:
{"readability":{"score":N,"reason":"..."},"overlap":{"score":N,"reason":"..."},"rendering_correctness":{"score":N,"reason":"..."},"content_completeness":{"score":N,"reason":"..."},"layout_logic":{"score":N,"reason":"..."},"overall":N,"issues":["..."]}`;

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
    maxOutputTokens: 2000,
  });

  const content = result.text;

  // Extract JSON from response (may be wrapped in markdown code fences)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`VLM returned non-JSON response: ${content.slice(0, 200)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch {
    // VLM sometimes produces unescaped quotes or trailing content — attempt cleanup
    const cleaned = jsonMatch[0]
      .replace(/,\s*}/g, '}') // trailing commas
      .replace(/,\s*]/g, ']');
    try {
      raw = JSON.parse(cleaned);
    } catch (e2) {
      throw new Error(
        `VLM returned invalid JSON: ${(e2 as Error).message}\n${jsonMatch[0].slice(0, 300)}`,
      );
    }
  }

  const dimensions = [
    'readability',
    'overlap',
    'rendering_correctness',
    'content_completeness',
    'layout_logic',
  ] as const;
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
    rendering_correctness: raw.rendering_correctness,
    content_completeness: raw.content_completeness,
    layout_logic: raw.layout_logic,
    overall: raw.overall,
    issues: Array.isArray(raw.issues) ? raw.issues : [],
  };
  return score;
}
