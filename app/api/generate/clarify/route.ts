/**
 * Requirements Clarification API (pre-outline ask_user preflight).
 *
 * A lightweight model call that runs BEFORE outline generation. It returns
 * either `{ needsClarification: false, questions: [] }` (proceed straight to
 * outlines) or a small set of structured questions for the user. The frontend
 * pauses the pipeline on questions, collects answers, and re-injects them into
 * the outline request as `clarificationQA`.
 *
 * Fail-open by design: an unparseable model response resolves to
 * no-clarification so generation is never blocked by this step. Transport and
 * model-resolution failures still surface as errors — the caller fails open.
 *
 * POST body:
 *   { requirements, pdfText?, researchContext?, thinkingConfig? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { generateClarificationQuestions, type UserRequirements } from '@openmaic/generation';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';

const log = createLogger('Clarify');

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let resolvedModelString: string | undefined;
  try {
    const body = await req.json();

    const { model, modelInfo, modelString, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'scene-outlines-stream',
    );
    resolvedModelString = modelString;

    if (!body.requirements) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Requirements are required');
    }

    const { requirements, pdfText, researchContext } = body as {
      requirements: UserRequirements;
      pdfText?: string;
      researchContext?: string;
    };

    const result = await generateClarificationQuestions(
      requirements,
      async (system, user) => {
        const llmResult = await callLLM(
          {
            model,
            system,
            prompt: user,
            maxOutputTokens: modelInfo?.outputWindow,
          },
          'clarify',
          undefined,
          thinkingConfig,
        );
        return llmResult.text;
      },
      { pdfText, researchContext, logger: log },
    );

    if (!result.success || !result.data) {
      // Fail open: a model that cannot follow the clarify contract must not
      // block outline generation. The pipeline proceeds without questions.
      log.warn(`Clarify preflight unparseable, proceeding without questions: ${result.error}`);
      return NextResponse.json({ needsClarification: false, questions: [] });
    }

    return NextResponse.json(result.data);
  } catch (error) {
    log.error(`Clarify preflight failed [model=${resolvedModelString ?? 'unknown'}]:`, error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
