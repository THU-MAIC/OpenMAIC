import { readFileSync } from 'fs';
import type { VlmScore } from './types';

const RUBRIC_PROMPT = `You are a whiteboard layout quality reviewer. Evaluate the whiteboard screenshot below.

Score each dimension from 1 to 10:

1. readability: Is text clearly legible? Are font sizes appropriate? Are LaTeX formulas fully rendered?
2. overlap: Do any elements occlude or overlap each other? 10 = no overlap, 1 = severe occlusion.
3. space_utilization: Is content reasonably distributed across the canvas? Penalize clustering in one area or excessive empty space.
4. layout_logic: Are related elements grouped together? Is there a clear visual hierarchy and reading order?

Output ONLY a JSON object with this structure:
{"readability":{"score":N,"reason":"..."},"overlap":{"score":N,"reason":"..."},"space_utilization":{"score":N,"reason":"..."},"layout_logic":{"score":N,"reason":"..."},"overall":N,"issues":["..."]}`;

interface ScorerConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  providerType?: string;
}

/**
 * Score a whiteboard screenshot using a VLM.
 */
export async function scoreScreenshot(
  screenshotPath: string,
  config: ScorerConfig,
): Promise<VlmScore> {
  const imageBuffer = readFileSync(screenshotPath);
  const base64Image = imageBuffer.toString('base64');
  const mimeType = 'image/png';

  // Use OpenAI-compatible API for vision
  const apiBase = config.baseUrl || 'https://api.openai.com/v1';
  const response = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: RUBRIC_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Image}` },
            },
          ],
        },
      ],
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`VLM API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content || '';

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
