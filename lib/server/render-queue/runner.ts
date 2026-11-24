/**
 * The process-scoped worker of the durable video export queue, started from
 * `instrumentation.ts` when `RENDER_DURABLE_QUEUE=true`.
 *
 * It follows the generation runner's loop (`lib/server/generation/run/runner.ts`):
 * scan for claimable jobs up to a local concurrency, act on each under a
 * heartbeat, and stop acting as soon as the heartbeat finds the lease gone.
 * PostgreSQL decides who acts on a job; this process only keeps its own count.
 *
 * A queued job is sent to a render target only while that target's `/health`
 * reports `accepting`, so jobs wait in PostgreSQL rather than in the render
 * service's memory. A job at the render service is followed by polling it,
 * which also refreshes its progress; when it succeeds its MP4 is copied into
 * the job's namespace of the byte store. A job the render service lost (it
 * answers 404, or stays unreachable past `lostAfterMs`) is sent again from the
 * start until `maxAttempts`, then fails with `render_lost`.
 */
import { randomUUID } from 'node:crypto';

import { createLogger } from '@/lib/logger';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import {
  getRenderServiceCapability,
  getRenderServiceUrl,
  isRenderOwnerBoundResponse,
  renderServiceOwnerHeaders,
} from '@/lib/server/render-service';

import {
  deleteRenderParts,
  renderJobBytes,
  renderPartsBody,
  RenderPartCorruptError,
  writeRenderParts,
} from './bytes';
import { renderQueueConfig, type RenderQueueConfig } from './config';
import {
  claimRenderJob,
  failRenderJob,
  finishRenderJobCancel,
  finishRenderJobCleanup,
  hasQueuedRenderJob,
  heartbeatRenderJob,
  listRenderJobCleanups,
  markRenderJobDispatched,
  readRenderJobOutputParts,
  recordRenderOutputPart,
  releaseRenderJob,
  renderQueuePersistence,
  requeueRenderJob,
  resetRenderJobOutput,
  succeedRenderJob,
  type ClaimedRenderJob,
} from './store';

const log = createLogger('RenderQueueRunner');

/** Upload of an archive to the render service; the render itself is asynchronous. */
const DISPATCH_TIMEOUT_MS = 300_000;
const STATUS_TIMEOUT_MS = 15_000;
/** Time to the download's response headers, not to its last byte. */
const DOWNLOAD_HEADERS_TIMEOUT_MS = 30_000;
/** No MP4 the render service produces comes near this. */
const MAX_OUTPUT_BYTES = 4 * 1024 ** 3;

const RUNNER_KEY = Symbol.for('openmaic.render-queue.runner');
const runnerState = globalThis as typeof globalThis & {
  [RUNNER_KEY]?: RenderQueueRunnerHandle;
};

/** Ask this process's runner to scan now (a job was just queued). */
export function wakeRenderQueueRunner(): void {
  runnerState[RUNNER_KEY]?.wake();
}

export interface RenderQueueRunnerHandle {
  workerId: string;
  wake(): void;
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export interface RenderQueueRunnerOptions {
  workerId?: string;
  /** Overrides of the configuration (tests). */
  config?: Partial<RenderQueueConfig>;
}

type Outcome =
  | 'dispatched'
  | 'render_busy'
  | 'dispatch_failed'
  | 'succeeded'
  | 'failed'
  | 'requeued'
  | 'cancelled'
  | 'lease_lost'
  | 'interrupted';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The render service, when its `/health` says it takes a job now. */
async function acceptingTarget(): Promise<string | null> {
  const target = getRenderServiceUrl();
  if (!target) return null;
  const capability = await getRenderServiceCapability();
  return capability.enabled && capability.accepting !== false ? target : null;
}

async function cancelAtRender(target: string, renderJobId: string, ownerId: string) {
  try {
    await proxyFetch(`${target}/owner-bound/render/${encodeURIComponent(renderJobId)}`, {
      method: 'DELETE',
      headers: renderServiceOwnerHeaders(ownerId),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
  } catch (error) {
    // Best effort: a render service that cannot be reached has lost the job,
    // or will finish it and reap it on its own expiry.
    log.warn(`job ${renderJobId}: cancel at render service failed`, error);
  }
}

/**
 * Send a queued job's archive to `target`. Answers how it went; a job the
 * service accepted is `dispatched` with the render service's job id recorded.
 */
async function dispatch(
  claim: ClaimedRenderJob,
  target: string,
  signal: AbortSignal,
): Promise<{ outcome: Outcome; renderJobId?: string }> {
  const { job, lease } = claim;
  const { pool } = await renderQueuePersistence();
  const input = await renderJobBytes(pool, job.id, 'input');
  let corrupt = false;
  let response: Response;
  try {
    response = await proxyFetch(`${target}/owner-bound/render`, {
      method: 'POST',
      body: renderPartsBody(input, job.inputParts, (error) => {
        corrupt = error instanceof RenderPartCorruptError;
      }),
      duplex: 'half',
      headers: {
        'content-type': job.inputContentType,
        // One admission identity per job: the per-owner limit is enforced when
        // the job is queued, so the render service's per-identity limit must
        // not hold back jobs of different owners behind one address.
        'x-openmaic-client': `render-queue:${job.id}`,
        ...renderServiceOwnerHeaders(job.ownerId),
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(DISPATCH_TIMEOUT_MS)]),
    } as RequestInit);
  } catch (error) {
    if (corrupt) {
      // A job whose archive is gone can never render.
      await failRenderJob(lease, 'input_unavailable', 'The export archive is no longer available');
      return { outcome: 'failed' };
    }
    log.warn(`job ${job.id}: dispatch to render service failed`, error);
    await releaseRenderJob(lease);
    return { outcome: 'dispatch_failed' };
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isRenderOwnerBoundResponse(response)) {
    log.warn(`job ${job.id}: render service must be upgraded before accepting jobs`);
    await releaseRenderJob(lease);
    return { outcome: 'dispatch_failed' };
  }
  if (response.status === 202 && typeof data.jobId === 'string') {
    if (await markRenderJobDispatched(lease, target, data.jobId)) {
      return { outcome: 'dispatched', renderJobId: data.jobId };
    }
    // Cancelled (or taken over) while the archive was on its way.
    await cancelAtRender(target, data.jobId, job.ownerId);
    return { outcome: 'cancelled' };
  }
  if (response.status === 429 || response.status === 503) {
    await releaseRenderJob(lease);
    return { outcome: 'render_busy' };
  }
  // Anything else is this archive's answer (400, 413, or an error while the
  // service read it): sending the same bytes again would get it again, and
  // would hold up every job queued behind this one.
  const detail = typeof data.error === 'string' ? data.error : 'The render service refused';
  log.warn(`job ${job.id}: render service answered ${response.status} to a dispatch`);
  await failRenderJob(lease, 'render_rejected', detail);
  return { outcome: 'failed' };
}

/** Copy the finished MP4 into the job's output namespace; answers whether it is stored. */
async function collect(
  claim: ClaimedRenderJob,
  target: string,
  renderJobId: string,
  signal: AbortSignal,
): Promise<'stored' | 'missing' | 'refused'> {
  const { job, lease } = claim;
  const { pool } = await renderQueuePersistence();
  const output = await renderJobBytes(pool, job.id, 'output');
  // Parts of an earlier, interrupted copy (or an earlier dispatch) go first.
  const storedParts = await readRenderJobOutputParts(lease);
  if (storedParts === null) return 'refused';
  if (storedParts.length > 0) {
    await deleteRenderParts(output, storedParts);
    if (!(await resetRenderJobOutput(lease))) return 'refused';
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const headers = setTimeout(abort, DOWNLOAD_HEADERS_TIMEOUT_MS);
  try {
    const response = await proxyFetch(
      `${target}/owner-bound/render/${encodeURIComponent(renderJobId)}/download`,
      {
        method: 'GET',
        redirect: 'manual',
        headers: renderServiceOwnerHeaders(job.ownerId),
        signal: controller.signal,
      },
    );
    clearTimeout(headers);
    // The bundled render service streams the file. A redirect (a host artifact
    // store that hands out signed URLs) is not followed: it counts as missing.
    if (!isRenderOwnerBoundResponse(response) || !response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      return 'missing';
    }
    const total = await writeRenderParts(
      output,
      response.body as unknown as AsyncIterable<Uint8Array>,
      MAX_OUTPUT_BYTES,
      (part, totalBytes) => recordRenderOutputPart(lease, part, totalBytes),
    );
    if (total === null) return 'refused';
    return (await succeedRenderJob(lease)) ? 'stored' : 'refused';
  } finally {
    clearTimeout(headers);
    signal.removeEventListener('abort', abort);
  }
}

/** The render service lost the job: send it again, or fail it at the attempt limit. */
async function lost(claim: ClaimedRenderJob, attempt: number, config: RenderQueueConfig) {
  if (attempt < config.maxAttempts) {
    log.warn(`job ${claim.job.id}: lost by the render service; queued again`);
    return (await requeueRenderJob(claim.lease)) ? 'requeued' : 'lease_lost';
  }
  log.warn(`job ${claim.job.id}: lost by the render service ${attempt} times; failing`);
  await failRenderJob(claim.lease, 'render_lost', 'The render service lost the job');
  return 'failed';
}

/**
 * Act on one claimed job until it leaves this worker's hands: dispatch it if
 * it is queued, then follow it at the render service to its end. Exported for
 * the contract tests.
 */
export async function runClaimedRenderJob(
  claim: ClaimedRenderJob,
  options: {
    config: RenderQueueConfig;
    signal: AbortSignal;
    /** For a queued job: the target to send it to. */
    target?: string;
    /** Called once the dispatch (if any) has settled: whether the job was sent. */
    onDispatchSettled?: (sent: boolean) => void;
  },
): Promise<Outcome> {
  const { job, lease } = claim;
  const { config } = options;
  const local = new AbortController();
  const signal = AbortSignal.any([options.signal, local.signal]);
  let cancelled = false;
  // A cancellation while the archive is on its way is not an abort: the
  // render service may already hold the job, and the dispatch cancels it there
  // once it knows the id.
  let dispatching = false;
  const heartbeat = setInterval(() => {
    void heartbeatRenderJob(lease)
      .then((status) => {
        if (status === null) local.abort();
        else if (status === 'cancelled') {
          cancelled = true;
          if (!dispatching) local.abort();
        }
      })
      .catch((error) => log.warn(`job ${job.id}: heartbeat failed`, error));
  }, config.heartbeatIntervalMs);
  heartbeat.unref?.();

  const endCancelled = async (target: string | null, renderJobId: string | null) => {
    if (target && renderJobId) await cancelAtRender(target, renderJobId, job.ownerId);
    await finishRenderJobCancel(lease);
    return 'cancelled' as const;
  };

  try {
    if (job.status === 'cancelled') return await endCancelled(job.renderTarget, job.renderJobId);

    let target = job.renderTarget;
    let renderJobId = job.renderJobId;
    let attempt = job.attempt;
    if (job.status === 'queued') {
      if (!options.target) {
        await releaseRenderJob(lease);
        return 'render_busy';
      }
      let sent: Awaited<ReturnType<typeof dispatch>> = { outcome: 'dispatch_failed' };
      dispatching = true;
      try {
        sent = await dispatch(claim, options.target, signal);
      } finally {
        dispatching = false;
        options.onDispatchSettled?.(sent.outcome === 'dispatched');
      }
      if (sent.outcome !== 'dispatched') return sent.outcome;
      target = options.target;
      renderJobId = sent.renderJobId!;
      attempt += 1;
      log.info(`job ${job.id}: dispatched (attempt ${attempt})`);
    } else {
      options.onDispatchSettled?.(true);
    }
    if (!target || !renderJobId) return lost(claim, attempt, config);

    let unreachableSince: number | null = null;
    for (;;) {
      await sleep(config.pollIntervalMs, signal);
      if (signal.aborted) break;
      let data: Record<string, unknown> | null = null;
      let missing = false;
      try {
        const response = await proxyFetch(
          `${target}/owner-bound/render/${encodeURIComponent(renderJobId)}`,
          {
            method: 'GET',
            headers: renderServiceOwnerHeaders(job.ownerId),
            signal: AbortSignal.any([signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]),
          },
        );
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (isRenderOwnerBoundResponse(response) && response.status === 404) missing = true;
        else if (isRenderOwnerBoundResponse(response) && response.ok && body) data = body;
      } catch {
        if (signal.aborted) break;
      }
      // A 404 from a reachable service means it no longer has the job (it was
      // restarted); anything else unanswered is lost only after a while.
      if (missing) return await lost(claim, attempt, config);
      if (!data) {
        unreachableSince ??= Date.now();
        if (Date.now() - unreachableSince >= config.lostAfterMs) {
          return await lost(claim, attempt, config);
        }
        continue;
      }
      unreachableSince = null;

      const status = data.status;
      const current = await heartbeatRenderJob(lease, {
        running: status === 'running' || status === 'succeeded',
        progress: typeof data.progress === 'number' ? data.progress : 0,
        stage: typeof data.currentStage === 'string' ? data.currentStage : null,
      });
      if (current === null) return 'lease_lost';
      if (current === 'cancelled') return await endCancelled(target, renderJobId);

      if (status === 'succeeded') {
        let stored: Awaited<ReturnType<typeof collect>>;
        try {
          stored = await collect(claim, target, renderJobId, signal);
        } catch (error) {
          if (signal.aborted) break;
          // The parts this copy recorded are deleted by the next one.
          log.warn(`job ${job.id}: copying the MP4 failed; retrying`, error);
          continue;
        }
        if (stored === 'stored') return 'succeeded';
        if (stored === 'missing') return await lost(claim, attempt, config);
        break;
      }
      if (status === 'failed' || status === 'cancelled') {
        const message = typeof data.error === 'string' ? data.error : `Render ${status}`;
        await failRenderJob(
          lease,
          status === 'failed' ? 'render_failed' : 'render_cancelled',
          message,
        );
        return 'failed';
      }
    }
    if (cancelled) return await endCancelled(target, renderJobId);
    return options.signal.aborted ? 'interrupted' : 'lease_lost';
  } finally {
    clearInterval(heartbeat);
  }
}

/** Delete what finished and abandoned jobs stored, and drop the expired rows. */
export async function sweepRenderJobs(config: RenderQueueConfig): Promise<number> {
  const { pool } = await renderQueuePersistence();
  const cleanups = await listRenderJobCleanups(config);
  let swept = 0;
  for (const cleanup of cleanups) {
    try {
      if (cleanup.parts.input.length > 0) {
        await deleteRenderParts(
          await renderJobBytes(pool, cleanup.id, 'input'),
          cleanup.parts.input,
        );
      }
      if (cleanup.parts.output.length > 0) {
        await deleteRenderParts(
          await renderJobBytes(pool, cleanup.id, 'output'),
          cleanup.parts.output,
        );
      }
      await finishRenderJobCleanup(cleanup);
      swept += 1;
    } catch (error) {
      log.warn(`job ${cleanup.id}: cleanup failed; retried on the next sweep`, error);
    }
  }
  return swept;
}

export function startRenderQueueRunner(
  options: RenderQueueRunnerOptions = {},
): RenderQueueRunnerHandle {
  const workerId = options.workerId ?? `${process.pid}:${randomUUID()}`;
  const configNow = () => ({ ...renderQueueConfig(), ...options.config });
  const running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  let stopping = false;
  let scanning = false;
  let rescan = false;

  const start = (claim: ClaimedRenderJob, config: RenderQueueConfig, target?: string) => {
    let retry = false;
    let settle!: (sent: boolean) => void;
    const dispatched = new Promise<boolean>((resolve) => (settle = resolve));
    const abort = new AbortController();
    const done = runClaimedRenderJob(claim, {
      config,
      signal: abort.signal,
      target,
      onDispatchSettled: settle,
    })
      .then(async (outcome) => {
        log.info(`job ${claim.job.id}: ${outcome}`);
        // A clean park: another worker (or this one after a restart) takes it over now.
        if (outcome === 'interrupted') await releaseRenderJob(claim.lease).catch(() => undefined);
        // A job the render service did not take waits for the next timed scan;
        // scanning now would only claim it again.
        retry = outcome === 'render_busy' || outcome === 'dispatch_failed';
      })
      .catch((error) => log.error(`job ${claim.job.id} crashed`, error))
      .finally(() => {
        settle(false);
        running.delete(claim.job.id);
        if (!stopping && !retry) void scan();
      });
    running.set(claim.job.id, { abort, done });
    return dispatched;
  };

  const scan = async (): Promise<void> => {
    if (stopping) return;
    if (scanning) {
      rescan = true;
      return;
    }
    scanning = true;
    try {
      do {
        rescan = false;
        const config = configNow();
        while (running.size < config.maxConcurrent && !stopping) {
          // Jobs at the render service nobody follows, and cancellations, first.
          let claim = await claimRenderJob(workerId, {
            leaseTtlMs: config.leaseTtlMs,
            dispatch: false,
          });
          let target: string | undefined;
          if (!claim) {
            if (!(await hasQueuedRenderJob())) break;
            target = (await acceptingTarget()) ?? undefined;
            if (!target) break;
            claim = await claimRenderJob(workerId, {
              leaseTtlMs: config.leaseTtlMs,
              dispatch: true,
            });
            if (!claim) break;
          }
          if (stopping || running.has(claim.job.id)) {
            // This process still acts on the job under a lease that went stale:
            // hand the claim back; the stale execution is fenced.
            running.get(claim.job.id)?.abort.abort();
            await releaseRenderJob(claim.lease).catch(() => undefined);
            break;
          }
          log.info(
            `claimed ${claim.job.id} (${claim.job.status}, generation ${claim.lease.generation})`,
          );
          const dispatched = start(claim, config, target);
          // One dispatch at a time, so the next `/health` read sees it. One the
          // render service did not take ends this scan: the next one retries.
          if (claim.job.status === 'queued' && !(await dispatched)) break;
        }
      } while (rescan && !stopping);
    } catch (error) {
      log.error('claim scan failed', error);
    } finally {
      scanning = false;
    }
  };

  const config = configNow();
  const timer = setInterval(() => void scan(), config.scanIntervalMs);
  timer.unref?.();
  const sweep = () =>
    void sweepRenderJobs(configNow()).catch((error) => log.warn('render job sweep failed', error));
  const sweepTimer = setInterval(sweep, config.sweepIntervalMs);
  sweepTimer.unref?.();
  void scan();
  log.info(
    `render queue runner ${workerId} started (scan=${config.scanIntervalMs}ms, ` +
      `poll=${config.pollIntervalMs}ms, leaseTtl=${config.leaseTtlMs}ms, ` +
      `maxConcurrent=${config.maxConcurrent})`,
  );

  const handle: RenderQueueRunnerHandle = {
    workerId,
    wake: () => void scan(),
    async stop(stopOptions) {
      stopping = true;
      if (runnerState[RUNNER_KEY] === handle) delete runnerState[RUNNER_KEY];
      clearInterval(timer);
      clearInterval(sweepTimer);
      for (const execution of running.values()) execution.abort.abort();
      const deadline = Date.now() + (stopOptions?.timeoutMs ?? 15_000);
      while ((running.size > 0 || scanning) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (running.size > 0) log.warn(`stop() timed out with ${running.size} job(s) still settling`);
    },
  };
  runnerState[RUNNER_KEY] = handle;
  return handle;
}
