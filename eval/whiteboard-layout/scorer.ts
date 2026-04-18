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

const RUBRIC_PROMPT = `You are evaluating a classroom whiteboard screenshot from an AI teaching assistant. Score like a teacher reviewing their own board work for a student's benefit.

Context: This is a real-time teaching whiteboard, NOT a poster or infographic.
- Empty space is NORMAL and NOT a problem — teachers write in one area at a time.
- What matters: would a student be confused, misled, or unable to read the content?
- Ignore the small dark circle "N" in the corner — it is a page UI element, not whiteboard content.

Score each dimension from 1 to 10 (10 = perfect, 1 = broken):

1. readability — Can a student read every element easily?
   - Font size CONSISTENCY is critical: penalize heavily if some text is 2x+ larger than other text on the same board (e.g., one giant title + tiny formulas).
   - Are characters crisp? Any Chinese rendered as boxes or missing glyphs?
   - Penalize text styled like UI components (gray boxes, card backgrounds) that don't match handwritten whiteboard feel.

2. overlap — Are elements clear of each other, AND does new content respect existing content?
   - Penalize any occlusion (shapes over text, text stacked on text, arrows piercing labels).
   - CRITICAL: penalize "writing over existing content" — if a new formula is placed directly on top of an existing table row when empty space was available nearby, that is a layout failure, not just overlap.
   - 10 = everything distinct; 1 = multiple elements unreadable due to occlusion.

3. rendering_correctness — Are formulas, shapes, and symbols drawn correctly?
   - LaTeX must render: raw source like "\\\\frac", "\\\\theta", or garbled chunks like "0ext", "Gsinheta", "heta" = major penalty.
   - Subscripts/superscripts must render: "G_x" shown as raw underscore (not Gₓ) = penalty.
   - Chinese inside LaTeX math mode (e.g., "口诀(当 a > 0 ext 时)") = penalty.
   - Diagram ACCURACY matters: a parabola drawn as V-shape straight lines, a circle drawn as ellipse-when-should-be-circle, an angle labeled wrong = penalty.
   - 10 = all math/shapes render correctly and match the concept; 1 = multiple broken renders OR fundamentally wrong diagrams.

4. content_completeness — Is the content whole, bounded, and annotated?
   - Edge clipping: any element cut off at canvas edge (formula missing its left character, table column cut, arrow head beyond edge) = major penalty.
   - Unexpected clearing: if previous turns' content has vanished in a later turn with no reason, penalize.
   - Bare diagrams with no labels (a circle with no annotation of what it represents) = penalty.
   - 10 = all content fully visible and annotated; 1 = significant content lost, truncated, or unlabeled.

5. layout_logic — Does the arrangement support teaching flow?
   - Related elements grouped (a diagram with its labels/formulas together)?
   - Natural reading order for the concept (cause → effect, equation → graph → solution)?
   - Spatial planning: does new content go to sensibly-chosen empty areas rather than crammed near or over existing elements?

overall: 1–10 holistic teaching-quality score. Weight overlap and rendering_correctness more heavily since they directly block comprehension.

issues: 1-5 short concrete problem descriptions a teacher would call out.

Output ONLY a JSON object with this exact structure (no markdown, no code fences):
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
    maxOutputTokens: 3000,
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
