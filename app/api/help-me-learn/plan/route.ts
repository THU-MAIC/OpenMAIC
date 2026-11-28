/**
 * Help Me Learn Study Plan API
 *
 * POST: Generates a personalized learning plan for any student topic or uploaded
 * problem snapshot, honoring the student's chosen mode:
 *  - `theory-then-solve`: Generates 3-4 structured theory slides (intuition,
 *    formulas, worked example) followed by a guided practice problem.
 *  - `solve-only`: Skips theory slides and extracts/creates the target problem
 *    immediately for step-by-step whiteboard + camera guidance.
 */
import { NextRequest } from 'next/server';
import type { ModelMessage } from 'ai';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, modelAuthorizationResponse } from '@/lib/server/api-response';
import { resolveModelFromRequest, type ResolvedModel } from '@/lib/server/resolve-model';
import { modelSupportsVision } from '@/lib/live-tutor/model-capabilities';
import type {
  HelpMeLearnPlan,
  LearningMode,
  PracticeProblem,
  TheorySlide,
} from '@/lib/live-tutor/types';

function resolvedModelSupportsVision(resolved: ResolvedModel): boolean {
  return modelSupportsVision(resolved.modelId, resolved.modelInfo?.capabilities?.vision);
}

const log = createLogger('HelpMeLearnPlan');

interface PlanRequest {
  topic: string;
  mode?: LearningMode;
  imageDataUrl?: string;
  language?: string;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const rawBody: unknown = await req.json().catch(() => null);
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid JSON request body');
    }
    const body = rawBody as PlanRequest;
    const rawTopic = body.topic?.trim() ?? '';
    const hasImage = Boolean(body.imageDataUrl && body.imageDataUrl.startsWith('data:image/'));
    if (!rawTopic && !hasImage) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'Please enter a topic or attach a problem photo',
      );
    }
    if (body.imageDataUrl && body.imageDataUrl.length > 8_000_000) {
      return apiError('INVALID_REQUEST', 413, 'Attached image is too large');
    }

    const mode: LearningMode = body.mode === 'solve-only' ? 'solve-only' : 'theory-then-solve';
    let stage: 'scene-content:slide' | 'chat-adapter' =
      mode === 'theory-then-solve' ? 'scene-content:slide' : 'chat-adapter';

    let resolved = await resolveModelFromRequest(req, body, stage);

    if (hasImage && !resolvedModelSupportsVision(resolved)) {
      if (stage === 'scene-content:slide') {
        try {
          const classroomResolved = await resolveModelFromRequest(req, body, 'chat-adapter');
          if (resolvedModelSupportsVision(classroomResolved)) {
            stage = 'chat-adapter';
            resolved = classroomResolved;
          }
        } catch {
          // Classroom slot may be disabled or unassigned; fall through to the 400 vision error
        }
      }
      if (!resolvedModelSupportsVision(resolved)) {
        return apiError(
          'INVALID_REQUEST',
          400,
          'The configured model does not support photo inputs. Choose a vision-capable model in Settings → Model Services or type your problem as text.',
        );
      }
    }

    const { model: languageModel, thinkingConfig, serverManaged } = resolved;

    const langHint = body.language
      ? `Write all student-facing text in locale "${body.language}".`
      : '';

    const systemPrompt =
      mode === 'theory-then-solve'
        ? `You are a supportive master teacher helping a student learn a topic from first principles and then solve a problem.
${langHint}
Generate 3 to 4 concise, visual theory slides that build intuition step by step, followed by 1 practice problem (use the student's exact problem if they provided one, or create a clear practice problem on the topic).
Formulas in "formulaLatex" must be valid KaTeX/LaTeX WITHOUT surrounding $ or $$ delimiters.
Reply with valid JSON only:
{
  "topic": "<clean topic title>",
  "slides": [
    {
      "title": "<slide title>",
      "summary": "<1-2 sentence plain-language core idea>",
      "keyPoints": ["<clear bullet 1>", "<clear bullet 2>", "<clear bullet 3>"],
      "formulaLatex": "<optional LaTeX formula without $ signs>",
      "workedExample": {
        "problem": "<optional mini example question>",
        "steps": ["<step 1>", "<step 2>"]
      }
    }
  ],
  "problem": {
    "statement": "<the problem the student will now solve with whiteboard & camera guidance>",
    "hint": "<gentle first step hint without giving away the final answer>",
    "targetConcept": "<concept name>",
    "formulaLatex": "<optional helpful reference formula without $ signs>"
  }
}`
        : `You are a supportive Socratic tutor preparing to guide a student directly through solving their problem step by step on a whiteboard.
${langHint}
Extract the exact problem from the student's prompt or photo (or create a focused problem if they only named a topic). Do NOT solve it yet — only state the problem clearly and give a gentle starting hint.
Reply with valid JSON only:
{
  "topic": "<short title for this problem>",
  "problem": {
    "statement": "<clear problem statement>",
    "hint": "<gentle first step hint without giving away the answer>",
    "targetConcept": "<core concept>",
    "formulaLatex": "<optional relevant formula in LaTeX without $ signs>"
  }
}`;

    const promptText = rawTopic
      ? `Student request: ${rawTopic}`
      : 'Read the problem shown in the attached image and prepare the study session.';

    const messages: ModelMessage[] = hasImage
      ? [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image', image: body.imageDataUrl! },
            ],
          },
        ]
      : [{ role: 'user', content: promptText }];

    const result = await callLLM(
      {
        model: languageModel,
        system: systemPrompt,
        messages,
      },
      stage,
      undefined,
      thinkingConfig,
      // Disable slot fallback for image-bearing requests so a retry never hits a text-only fallback model
      { serverManaged, enabled: !hasImage },
    );

    const parsed = extractJsonObject(result.text);
    const topicTitle =
      typeof parsed?.topic === 'string' && parsed.topic.trim()
        ? parsed.topic.trim()
        : rawTopic || 'Guided Study Session';

    const rawSlides =
      mode === 'theory-then-solve' && Array.isArray(parsed?.slides) ? parsed.slides : [];
    const slides: TheorySlide[] = rawSlides
      .map((s, idx): TheorySlide | null => {
        if (!s || typeof s !== 'object') return null;
        const item = s as Record<string, unknown>;
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
        if (!title && !summary) return null;
        const keyPoints = Array.isArray(item.keyPoints)
          ? item.keyPoints.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
          : [];
        const formulaLatex =
          typeof item.formulaLatex === 'string' && item.formulaLatex.trim()
            ? item.formulaLatex.trim()
            : undefined;
        let workedExample: TheorySlide['workedExample'];
        if (item.workedExample && typeof item.workedExample === 'object') {
          const we = item.workedExample as Record<string, unknown>;
          const weProb = typeof we.problem === 'string' ? we.problem.trim() : '';
          const weSteps = Array.isArray(we.steps)
            ? we.steps.filter((st): st is string => typeof st === 'string' && st.trim().length > 0)
            : [];
          if (weProb && weSteps.length > 0) {
            workedExample = { problem: weProb, steps: weSteps };
          }
        }
        return {
          id: `theory-slide-${idx + 1}`,
          title: title || `Concept ${idx + 1}`,
          summary,
          keyPoints,
          formulaLatex,
          workedExample,
        };
      })
      .filter((s): s is TheorySlide => s !== null);

    const rawProb =
      parsed?.problem && typeof parsed.problem === 'object'
        ? (parsed.problem as Record<string, unknown>)
        : {};

    const problem: PracticeProblem = {
      statement:
        typeof rawProb.statement === 'string' && rawProb.statement.trim()
          ? rawProb.statement.trim()
          : rawTopic || 'Solve the problem shown in your notebook step by step.',
      hint:
        typeof rawProb.hint === 'string' && rawProb.hint.trim() ? rawProb.hint.trim() : undefined,
      targetConcept:
        typeof rawProb.targetConcept === 'string' && rawProb.targetConcept.trim()
          ? rawProb.targetConcept.trim()
          : undefined,
      formulaLatex:
        typeof rawProb.formulaLatex === 'string' && rawProb.formulaLatex.trim()
          ? rawProb.formulaLatex.trim()
          : undefined,
    };

    const plan: HelpMeLearnPlan = {
      topic: topicTitle,
      mode,
      slides,
      problem,
    };

    return apiSuccess({ plan });
  } catch (error) {
    const authorization = modelAuthorizationResponse(error);
    if (authorization) return authorization;
    log.error('Help Me Learn plan generation failed:', error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to prepare learning session');
  }
}
