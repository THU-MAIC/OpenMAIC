import { type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { getTemporalClient, TASK_QUEUE } from '@/temporal/client';
import { classroomGenerationWorkflow } from '@/temporal/workflows/classroom-generation.workflow';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerateClassroom API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let requirementSnippet: string | undefined;
  try {
    const rawBody = (await req.json()) as Partial<GenerateClassroomInput>;
    requirementSnippet = rawBody.requirement?.substring(0, 60);
    const body: GenerateClassroomInput = {
      requirement: rawBody.requirement || '',
      ...(rawBody.pdfContent ? { pdfContent: rawBody.pdfContent } : {}),
      ...(rawBody.language ? { language: rawBody.language } : {}),
      ...(rawBody.enableWebSearch != null ? { enableWebSearch: rawBody.enableWebSearch } : {}),
      ...(rawBody.enableImageGeneration != null
        ? { enableImageGeneration: rawBody.enableImageGeneration }
        : {}),
      ...(rawBody.enableVideoGeneration != null
        ? { enableVideoGeneration: rawBody.enableVideoGeneration }
        : {}),
      ...(rawBody.enableTTS != null ? { enableTTS: rawBody.enableTTS } : {}),
      ...(rawBody.agentMode ? { agentMode: rawBody.agentMode } : {}),
    };

    const { requirement } = body;

    if (!requirement) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);

    const client = await getTemporalClient();
    await client.workflow.start(classroomGenerationWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: jobId,
      args: [{ input: body, baseUrl }],
    });

    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    return apiSuccess(
      {
        jobId,
        status: 'queued',
        step: 'queued',
        message: 'Classroom generation job queued',
        pollUrl,
        pollIntervalMs: 5000,
      },
      202,
    );
  } catch (error) {
    log.error(
      `Classroom generation job creation failed [requirement="${requirementSnippet ?? 'unknown'}..."]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
