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
 * A paused run is not over (`retryable: true`, `runState: "paused"`):
 * `POST /api/generation-runs/<runId>/retry` re-runs the failed step, and the
 * job reads `running` again. A paused run does not count toward the owner's
 * limit on runs in progress; its Retry does. Images and videos that failed,
 * and speech clips the narration left silent, do not fail the job; they are
 * counted in `result.warning`.
 */
import type { ApiErrorCode } from '@/lib/server/api-response';
import { parseRunInput } from '@/lib/server/generation/run/input';
import type { StoredRun } from '@/lib/server/generation/run/store';
import type {
  GenerationRunInput,
  GenerationRunMediaState,
  GenerationRunState,
} from '@/lib/server/generation/run/types';
import { ModelConfigurationError, SlotRequirementError } from '@/lib/server/model-config/llm';
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
 * The stages every run needs a model for: the outline, the scene content
 * (each scene type resolves through a child of it) and the actions. Agent
 * profiles are not here: a run falls back to the built-in agents.
 */
const REQUIRED_STAGES = ['scene-outlines-stream', 'scene-content', 'scene-actions'] as const;

/**
 * Refuse a submission no run could complete: a stage it needs resolves to no
 * model for the owner (none configured, its slot turned off, or a model that
 * cannot do the job), or to one the configuration cannot build (no key for a
 * provider that needs one, an endpoint or option it may not set). Checked
 * without calling any provider. Null when every required stage resolves.
 */
export async function requiredModelRefusal(
  ownerId: string,
): Promise<{ code: ApiErrorCode; message: string } | null> {
  const workspaceId = await backgroundWorkspaceId(ownerId);
  for (const stage of REQUIRED_STAGES) {
    try {
      await resolveModel({ stage, workspaceId });
    } catch (error) {
      if (
        error instanceof SlotUnassignedError ||
        error instanceof SlotDisabledError ||
        error instanceof SlotRequirementError
      ) {
        return { code: 'MISSING_MODEL', message: error.message };
      }
      if (error instanceof ModelConfigurationError) {
        return { code: error.code, message: error.message };
      }
      throw error;
    }
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
    const failed = run.error?.step ? `${run.error.step}: ${message}` : message;
    return `${failed} (the run is paused and keeps what it generated; POST /api/generation-runs/${run.id}/retry with { "commandId": "<a new id>" } resumes it at this step)`;
  }
  if (run.state === 'ended') {
    return run.stageId
      ? 'The classroom was deleted before its generation finished'
      : 'The generation run was discarded';
  }
  return undefined;
}

/**
 * What a completed run left out: images and videos that failed (counted from
 * their checkpoints, or from the summary a compaction kept), and speech clips
 * its narration left silent.
 */
function completionWarning(
  run: StoredRun,
  media: Record<string, GenerationRunMediaState>,
): string | undefined {
  const states = Object.values(media);
  const counts =
    states.length > 0
      ? {
          total: states.length,
          failed: states.filter((state) => state.status === 'failed').length,
        }
      : (run.mediaSummary ?? { total: 0, failed: 0 });
  const parts: string[] = [];
  if (counts.failed > 0) {
    parts.push(
      `${counts.failed} of ${counts.total} images and videos could not be generated (see GET /api/generation-runs/${run.id}; the retryable ones can be retried there)`,
    );
  }
  if (run.narrationUnvoiced > 0) {
    parts.push(
      `${run.narrationUnvoiced} speech clip${run.narrationUnvoiced === 1 ? ' was' : 's were'} left without narration`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/** The job a poll answers with: the run, in the job contract. */
export function classroomJobView(
  run: StoredRun,
  media: Record<string, GenerationRunMediaState>,
  origin: string,
) {
  const status = jobStatus(run);
  const step = jobStep(run, status);
  const warning = status === 'succeeded' ? completionWarning(run, media) : undefined;
  const error = jobError(run);
  return {
    jobId: run.id,
    /** The run behind the job: `GET`/`POST /api/generation-runs/<runId>…` (Retry, events). */
    runId: run.id,
    runState: run.state,
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
    /** A failed job whose run is paused: a step Retry resumes it. */
    retryable: run.state === 'paused',
    done: status === 'succeeded' || status === 'failed',
  };
}
