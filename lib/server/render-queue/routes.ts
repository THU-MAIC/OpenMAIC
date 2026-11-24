/**
 * The export routes' answers when the durable queue is on
 * (`RENDER_DURABLE_QUEUE=true`). Same request and response shapes as the relay
 * to the render service, read from and written to PostgreSQL and the byte
 * store instead: the browser cannot tell the two apart.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { capBodyStream } from '@/lib/server/capped-stream';

import {
  assertRenderQueueStorage,
  renderJobBytes,
  renderPartsBody,
  RenderPartsTooLargeError,
  RenderQueueStorageUnavailableError,
  writeRenderParts,
} from './bytes';
import { renderQueueConfig } from './config';
import { wakeRenderQueueRunner } from './runner';
import {
  cancelRenderJob,
  countUnfinishedRenderJobs,
  createRenderJob,
  failRenderUpload,
  queueRenderJob,
  readRenderJob,
  recordRenderInputPart,
  renderJobQueuePosition,
  renderQueuePersistence,
  type RenderJobStatus,
} from './store';

const log = createLogger('RenderQueue API');

const POLL_INTERVAL_MS = 3000;

function failure(error: unknown, action: string): Response {
  if (error instanceof RenderQueueStorageUnavailableError) {
    return apiError('PROVIDER_DISABLED', 503, error.message);
  }
  log.error(`Render queue ${action} failed:`, error);
  return apiError('INTERNAL_ERROR', 500, `Failed to ${action}`);
}

/**
 * Admit the export, store the multipart body as it arrives (bounded to
 * `maxBytes` of actual bytes, never parsed: the render service validates it
 * when the job is sent), then queue it.
 */
export async function submitQueuedRender(
  req: NextRequest,
  body: ReadableStream<Uint8Array>,
  ownerId: string,
  maxBytes: number,
): Promise<Response> {
  let jobId: string;
  try {
    const { pool } = await renderQueuePersistence();
    await assertRenderQueueStorage(pool);
    const config = renderQueueConfig();
    const admitted = await createRenderJob({
      ownerId,
      inputContentType: req.headers.get('content-type') ?? '',
      maxJobs: config.maxJobs,
      maxJobsPerOwner: config.maxJobsPerOwner,
    });
    if ('refused' in admitted) {
      return apiError(
        'RATE_LIMITED',
        429,
        'Render service rejected the request',
        admitted.refused === 'queue_full'
          ? 'The render queue is full; try again shortly.'
          : 'A render is already in progress.',
        admitted.refused,
      );
    }
    jobId = admitted.id;
  } catch (error) {
    return failure(error, 'queue the render');
  }

  const capped = capBodyStream(body, maxBytes);
  try {
    const total = await writeRenderParts(
      jobId,
      'input',
      capped.stream as unknown as AsyncIterable<Uint8Array>,
      maxBytes,
      (part, totalBytes, queryable) => recordRenderInputPart(jobId, part, totalBytes, queryable),
    );
    if (total === 0) {
      await failRenderUpload(jobId, 'upload_empty', 'Empty export archive');
      return apiError('INVALID_REQUEST', 400, 'Expected multipart/form-data');
    }
    if (total === null || !(await queueRenderJob(jobId))) {
      return apiError('INVALID_REQUEST', 409, 'The render was cancelled during its upload');
    }
  } catch (error) {
    if (capped.exceeded() || error instanceof RenderPartsTooLargeError) {
      await failRenderUpload(jobId, 'upload_too_large', 'Export archive is too large').catch(
        () => undefined,
      );
      return apiError('INVALID_REQUEST', 413, 'Export archive is too large');
    }
    await failRenderUpload(jobId, 'upload_failed', 'The upload did not complete').catch(
      () => undefined,
    );
    return failure(error, 'store the export archive');
  }
  wakeRenderQueueRunner();
  return apiSuccess({ jobId, pollIntervalMs: POLL_INTERVAL_MS }, 202);
}

/** What the browser is told: the render service's own statuses. */
function publicStatus(status: RenderJobStatus) {
  if (status === 'uploading' || status === 'queued' || status === 'dispatched') return 'queued';
  return status;
}

export async function readQueuedRender(jobId: string, ownerId: string): Promise<Response> {
  try {
    const job = await readRenderJob(jobId, ownerId);
    if (!job) return apiError('UPSTREAM_ERROR', 404, 'Render job lookup failed');
    const status = publicStatus(job.status);
    const queuePosition = job.status === 'queued' ? await renderJobQueuePosition(job) : null;
    return apiSuccess({
      jobId: job.id,
      status,
      progress: job.progress,
      currentStage: job.stage ?? undefined,
      error: job.errorMessage ?? undefined,
      done: status === 'succeeded' || status === 'failed' || status === 'cancelled',
      ...(queuePosition !== null ? { queuePosition } : {}),
      pollIntervalMs: POLL_INTERVAL_MS,
    });
  } catch (error) {
    return failure(error, 'read the render job');
  }
}

export async function cancelQueuedRender(jobId: string, ownerId: string): Promise<Response> {
  try {
    if (!(await cancelRenderJob(jobId, ownerId))) {
      return apiError('UPSTREAM_ERROR', 404, 'Render job lookup failed');
    }
    wakeRenderQueueRunner();
    return apiSuccess({ cancelled: true });
  } catch (error) {
    return failure(error, 'cancel the render job');
  }
}

export async function downloadQueuedRender(jobId: string, ownerId: string): Promise<Response> {
  try {
    const job = await readRenderJob(jobId, ownerId);
    if (!job) return apiError('UPSTREAM_ERROR', 404, 'Render output not available');
    if (job.status !== 'succeeded') {
      return apiError('UPSTREAM_ERROR', 409, 'Render output not available');
    }
    if (job.outputParts.length === 0) {
      return apiError('UPSTREAM_ERROR', 404, 'Render output not available');
    }
    const { pool } = await renderQueuePersistence();
    const output = await renderJobBytes(pool, job.id, 'output');
    return new NextResponse(renderPartsBody(output, job.outputParts), {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(job.outputBytes),
        'Content-Disposition': `attachment; filename="${job.id}.mp4"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return failure(error, 'read the render output');
  }
}

/** Room in the queue, for the capability answer (the render service's own queue is not it). */
export async function queuedRenderAccepting(): Promise<boolean> {
  return (await countUnfinishedRenderJobs()) < renderQueueConfig().maxJobs;
}
