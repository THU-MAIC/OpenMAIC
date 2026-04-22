import { type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { getTemporalClient, TASK_QUEUE } from '@/temporal/client';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('CreateClassroom API');

export const maxDuration = 30;

/**
 * POST /api/create-classroom
 *
 * Queues a background "Create Classroom" Temporal workflow.
 * Uses Fish TTS (cheaper) and sends an in-app + email notification on completion.
 * Available to all authenticated users (FREE, PLUS, ULTRA, ADMIN).
 */
export async function POST(req: NextRequest) {
  let requirementSnippet: string | undefined;
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return apiError('UNAUTHORIZED', 401, 'Authentication required');
    }

    const rawBody = (await req.json()) as Partial<GenerateClassroomInput>;
    requirementSnippet = rawBody.requirement?.substring(0, 60);

    const body: GenerateClassroomInput = {
      requirement: rawBody.requirement || '',
      ...(rawBody.pdfContent ? { pdfContent: rawBody.pdfContent } : {}),
      ...(rawBody.language ? { language: rawBody.language } : {}),
      ...(rawBody.enableWebSearch != null ? { enableWebSearch: rawBody.enableWebSearch } : {}),
      enableImageGeneration: rawBody.enableImageGeneration ?? true,
      enableVideoGeneration: rawBody.enableVideoGeneration ?? false,
      enableTTS: rawBody.enableTTS ?? true,
      ...(rawBody.agentMode ? { agentMode: rawBody.agentMode } : {}),
    };

    if (!body.requirement) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);

    // Record the job in Supabase so the UI can track it
    const admin = createAdminClient();
    await admin.from('classroom_jobs').insert({
      id: jobId.startsWith('_') ? undefined : undefined, // let uuid default
      user_id: user.id,
      temporal_id: jobId,
      status: 'queued',
      requirement: body.requirement.substring(0, 500),
    });

    const client = await getTemporalClient();
    await client.workflow.start('queuedClassroomGenerationWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: jobId,
      args: [{
        input: body,
        baseUrl,
        userId: user.id,
        userEmail: user.email,
        jobId,
        ttsProvider: 'fish-tts',
      }],
    });

    return apiSuccess(
      {
        jobId,
        status: 'queued',
        message: 'Your classroom is being generated. We will notify you when it\'s ready.',
      },
      202,
    );
  } catch (error) {
    log.error(
      `Background classroom job creation failed [requirement="${requirementSnippet ?? 'unknown'}..."]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to queue classroom generation',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
