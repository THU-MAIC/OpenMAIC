/**
 * The headless classroom API (`POST /api/generate-classroom` and its poll) as
 * a view of a generation run (RFC #1754 §E).
 *
 * A submission starts a run with what the browser's defaults would choose for
 * a requirement alone: course-specific agents (the built-in ones when that
 * step fails), no interactive or task-engine mode, and the outline confirmed
 * by the run itself (`outlineReview: "auto"`). The job id is the run id, and a
 * poll maps the run onto the job contract earlier releases answered with:
 *
 * | run state                                    | job `status` |
 * |----------------------------------------------|--------------|
 * | `preparing`, before its first step           | `queued`     |
 * | `preparing`, `outlining`, `generating`       | `running`    |
 * | `awaiting_outline_confirmation` (transient)  | `running`    |
 * | `completed`                                  | `succeeded`  |
 * | `paused` (a step failed after its retries)   | `failed`     |
 * | `ended` (course deleted or run discarded)    | `failed`     |
 *
 * A paused run is not over: `POST /api/generation-runs/<runId>/retry` re-runs
 * the failed step, and the job reads `running` again. Images and videos that
 * failed do not fail the job; they are counted in `result.warning`.
 */
import type { ApiErrorCode } from '@/lib/server/api-response';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { parseRunInput } from '@/lib/server/generation/run/input';
import type { StoredRun } from '@/lib/server/generation/run/store';
import type {
  GenerationRunInput,
  GenerationRunMediaState,
  GenerationRunState,
} from '@/lib/server/generation/run/types';
import { SlotRequirementError } from '@/lib/server/model-config/llm';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

export const CLASSROOM_JOB_POLL_INTERVAL_MS = 5000;

const PDF_CONTENT_REMOVED_MESSAGE =
  'pdfContent is no longer accepted: upload the document with POST /api/materials and pass the returned materialId in materialIds';

export type ParsedClassroomJobBody =
  | { ok: true; input: GenerationRunInput }
  | { ok: false; code: 'INVALID_REQUEST' | 'MISSING_REQUIRED_FIELD'; message: string };

/**
 * The request body is `{ requirement, materialIds? }`. Optional capabilities
 * are not request fields (they follow the server's model configuration), and
 * other unknown fields are ignored, the run's own options included. The one
 * removed field that is refused rather than ignored is `pdfContent`: ignoring
 * it would silently generate without the caller's document.
 */
export function parseClassroomJobBody(raw: unknown): ParsedClassroomJobBody {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (body.pdfContent !== undefined) {
    return { ok: false, code: 'INVALID_REQUEST', message: PDF_CONTENT_REMOVED_MESSAGE };
  }
  if (typeof body.requirement !== 'string' || !body.requirement.trim()) {
    return {
      ok: false,
      code: 'MISSING_REQUIRED_FIELD',
      message: 'Missing required field: requirement',
    };
  }
  const parsed = parseRunInput({
    requirement: body.requirement,
    ...(body.materialIds !== undefined ? { materialIds: body.materialIds } : {}),
    outlineReview: 'auto',
  });
  if (!parsed.ok) return { ok: false, code: 'INVALID_REQUEST', message: parsed.message };
  return { ok: true, input: parsed.value };
}

/**
 * Refuse a submission no run could get past its outline: the outline model
 * does not resolve for the owner (no model configured, its slot turned off,
 * or a model that cannot do the job), or its provider needs a key that is
 * not configured. Null when the outline model resolves.
 */
export async function outlineModelRefusal(
  ownerId: string,
): Promise<{ code: ApiErrorCode; message: string } | null> {
  let resolved;
  try {
    resolved = await resolveModel({
      stage: 'scene-outlines-stream',
      workspaceId: await backgroundWorkspaceId(ownerId),
    });
  } catch (error) {
    if (
      error instanceof SlotUnassignedError ||
      error instanceof SlotDisabledError ||
      error instanceof SlotRequirementError
    ) {
      return { code: 'MISSING_MODEL', message: error.message };
    }
    throw error;
  }
  if (isProviderKeyRequired(resolved.providerId) && !resolved.apiKey) {
    return {
      code: 'MISSING_API_KEY',
      message: `No API key is configured for the outline model (provider "${resolved.providerId}").`,
    };
  }
  return null;
}

export type ClassroomJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type ClassroomJobStep =
  | 'queued'
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'completed'
  | 'failed';

function jobStatus(run: StoredRun): ClassroomJobStatus {
  const byState: Record<GenerationRunState, ClassroomJobStatus> = {
    preparing: run.step === null ? 'queued' : 'running',
    outlining: 'running',
    awaiting_outline_confirmation: 'running',
    generating: 'running',
    completed: 'succeeded',
    paused: 'failed',
    ended: 'failed',
  };
  return byState[run.state];
}

function jobStep(run: StoredRun, status: ClassroomJobStatus): ClassroomJobStep {
  if (status === 'queued' || status === 'failed') return status;
  if (run.state === 'completed') return 'completed';
  if (run.step === 'material-analysis') return 'initializing';
  if (run.step === 'research') return 'researching';
  if (run.state === 'outlining' || run.state === 'awaiting_outline_confirmation') {
    return 'generating_outlines';
  }
  if (run.state === 'preparing') return 'researching';
  // Every scene is in and the media pass is finishing.
  const { scenesTotal, scenesCompleted } = run.progress;
  return scenesTotal > 0 && scenesCompleted >= scenesTotal
    ? 'generating_media'
    : 'generating_scenes';
}

/** 0–100, in the bands earlier releases reported. */
function jobProgress(run: StoredRun, status: ClassroomJobStatus): number {
  if (status === 'queued') return 0;
  if (status === 'succeeded') return 100;
  const { scenesTotal, scenesCompleted } = run.progress;
  if (scenesTotal > 0) return Math.min(90, 30 + Math.floor((scenesCompleted / scenesTotal) * 60));
  if (run.state === 'preparing') return run.step === 'research' ? 10 : 5;
  return 15;
}

function jobMessage(run: StoredRun, step: ClassroomJobStep): string {
  const { scenesTotal, scenesCompleted } = run.progress;
  switch (step) {
    case 'queued':
      return 'Classroom generation job queued';
    case 'initializing':
      return `Extracting ${run.input.materialIds.length} uploaded material(s)`;
    case 'researching':
      return 'Researching topic';
    case 'generating_outlines':
      return 'Generating scene outlines';
    case 'generating_scenes':
      return `Generated ${scenesCompleted}/${scenesTotal} scenes`;
    case 'generating_media':
      return 'Generating media files';
    case 'completed':
      return 'Classroom generation completed';
    case 'failed':
      return 'Classroom generation failed';
  }
}

function jobError(run: StoredRun): string | undefined {
  if (run.state === 'paused') {
    const message = run.error?.message ?? 'A generation step failed';
    return run.error?.step ? `${run.error.step}: ${message}` : message;
  }
  if (run.state === 'ended') {
    return run.stageId
      ? 'The classroom was deleted before its generation finished'
      : 'The generation run was discarded';
  }
  return undefined;
}

function mediaWarning(
  runId: string,
  media: Record<string, GenerationRunMediaState>,
): string | undefined {
  const states = Object.values(media);
  const failed = states.filter((state) => state.status === 'failed').length;
  if (failed === 0) return undefined;
  return `${failed} of ${states.length} images and videos could not be generated; see GET /api/generation-runs/${runId} for each one`;
}

/** The job a poll answers with: the run, in the job contract. */
export function classroomJobView(
  run: StoredRun,
  media: Record<string, GenerationRunMediaState>,
  origin: string,
) {
  const status = jobStatus(run);
  const step = jobStep(run, status);
  const warning = status === 'succeeded' ? mediaWarning(run.id, media) : undefined;
  const error = jobError(run);
  return {
    jobId: run.id,
    /** The run behind the job: `GET`/`POST /api/generation-runs/<runId>…` (Retry, events). */
    runId: run.id,
    status,
    step,
    progress: jobProgress(run, status),
    message: warning ?? jobMessage(run, step),
    pollUrl: `${origin}/api/generate-classroom/${run.id}`,
    pollIntervalMs: CLASSROOM_JOB_POLL_INTERVAL_MS,
    scenesGenerated: run.progress.scenesCompleted,
    ...(run.progress.scenesTotal > 0 ? { totalScenes: run.progress.scenesTotal } : {}),
    ...(status === 'succeeded' && run.stageId
      ? {
          result: {
            classroomId: run.stageId,
            url: `${origin}/classroom/${run.stageId}`,
            scenesCount: run.progress.scenesCompleted,
            ...(warning ? { warning } : {}),
          },
        }
      : {}),
    ...(error ? { error } : {}),
    done: status === 'succeeded' || status === 'failed',
  };
}
