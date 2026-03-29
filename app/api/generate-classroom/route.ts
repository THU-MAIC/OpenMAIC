import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';

export const maxDuration = 30;

function parseOptionalNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = (await req.json()) as Partial<GenerateClassroomInput>;
    const body: GenerateClassroomInput = {
      requirement: rawBody.requirement || '',
      ...(rawBody.pdfContent ? { pdfContent: rawBody.pdfContent } : {}),
      ...(rawBody.language ? { language: rawBody.language } : {}),
      ...(rawBody.stageName || req.headers.get('x-stage-name')
        ? { stageName: rawBody.stageName || req.headers.get('x-stage-name') || undefined }
        : {}),
      ...(rawBody.modelString || req.headers.get('x-model')
        ? { modelString: rawBody.modelString || req.headers.get('x-model') || undefined }
        : {}),
      ...(rawBody.apiKey || req.headers.get('x-api-key')
        ? { apiKey: rawBody.apiKey || req.headers.get('x-api-key') || undefined }
        : {}),
      ...(rawBody.baseUrl || req.headers.get('x-base-url')
        ? { baseUrl: rawBody.baseUrl || req.headers.get('x-base-url') || undefined }
        : {}),
      ...(rawBody.providerType || req.headers.get('x-provider-type')
        ? { providerType: rawBody.providerType || req.headers.get('x-provider-type') || undefined }
        : {}),
      ...(rawBody.requiresApiKey !== undefined ||
      req.headers.get('x-requires-api-key') !== null
        ? {
            requiresApiKey:
              rawBody.requiresApiKey ??
              (req.headers.get('x-requires-api-key') === 'true' ? true : false),
          }
        : {}),
      ...(rawBody.imageGenerationEnabled !== undefined ||
      req.headers.get('x-image-generation-enabled') !== null
        ? {
            imageGenerationEnabled:
              rawBody.imageGenerationEnabled ??
              (req.headers.get('x-image-generation-enabled') === 'true' ? true : false),
          }
        : {}),
      ...(rawBody.imageProviderId || req.headers.get('x-image-provider')
        ? {
            imageProviderId:
              (rawBody.imageProviderId ||
                req.headers.get('x-image-provider') ||
                undefined) as GenerateClassroomInput['imageProviderId'],
          }
        : {}),
      ...(rawBody.imageModel || req.headers.get('x-image-model')
        ? { imageModel: rawBody.imageModel || req.headers.get('x-image-model') || undefined }
        : {}),
      ...(rawBody.imageApiKey || req.headers.get('x-image-api-key')
        ? {
            imageApiKey:
              rawBody.imageApiKey || req.headers.get('x-image-api-key') || undefined,
          }
        : {}),
      ...(rawBody.imageBaseUrl || req.headers.get('x-image-base-url')
        ? {
            imageBaseUrl:
              rawBody.imageBaseUrl || req.headers.get('x-image-base-url') || undefined,
          }
        : {}),
      ...(rawBody.ttsEnabled !== undefined || req.headers.get('x-tts-enabled') !== null
        ? {
            ttsEnabled:
              rawBody.ttsEnabled ??
              (req.headers.get('x-tts-enabled') === 'true' ? true : false),
          }
        : {}),
      ...(rawBody.ttsProviderId || req.headers.get('x-tts-provider')
        ? {
            ttsProviderId: (rawBody.ttsProviderId ||
              req.headers.get('x-tts-provider') ||
              undefined) as GenerateClassroomInput['ttsProviderId'],
          }
        : {}),
      ...(rawBody.ttsVoice || req.headers.get('x-tts-voice')
        ? { ttsVoice: rawBody.ttsVoice || req.headers.get('x-tts-voice') || undefined }
        : {}),
      ...(rawBody.ttsSpeed !== undefined || req.headers.get('x-tts-speed') !== null
        ? {
            ttsSpeed: rawBody.ttsSpeed ?? parseOptionalNumber(req.headers.get('x-tts-speed')),
          }
        : {}),
      ...(rawBody.ttsApiKey || req.headers.get('x-tts-api-key')
        ? { ttsApiKey: rawBody.ttsApiKey || req.headers.get('x-tts-api-key') || undefined }
        : {}),
      ...(rawBody.ttsBaseUrl || req.headers.get('x-tts-base-url')
        ? {
            ttsBaseUrl: rawBody.ttsBaseUrl || req.headers.get('x-tts-base-url') || undefined,
          }
        : {}),
    };
    const { requirement } = body;

    if (!requirement) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);
    const job = await createClassroomGenerationJob(jobId, body);
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    after(() => runClassroomGenerationJob(jobId, body, baseUrl));

    return apiSuccess(
      {
        jobId,
        status: job.status,
        step: job.step,
        message: job.message,
        pollUrl,
        pollIntervalMs: 5000,
      },
      202,
    );
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
