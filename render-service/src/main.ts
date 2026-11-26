/**
 * @openmaic/render-service — HTTP entrypoint.
 *
 * Renders exported Hyperframes projects (the ZIP the app builds with
 * `packageVideoZip`) to MP4 using `@hyperframes/producer`, isolated in a
 * Node 22 + Chromium + FFmpeg container (issue #866).
 *
 * The contract is intentionally minimal and stable so the internals (in-memory
 * vs Redis job store, local-disk vs S3 artifacts) can be swapped for a
 * demo-scale deployment without the app noticing:
 *
 *   POST   /owner-bound/render                 multipart: project(zip) + fps/quality/format → 202 { jobId }
 *   POST   /preview                            JSON: scene + stage + viewport → PNG
 *   POST   /interactive-runtime-check          JSON: interactive scene + stage + viewport → errors
 *   GET    /owner-bound/render/:jobId          → { status, progress, currentStage, done, ... }
 *   GET    /owner-bound/render/:jobId/download → stream MP4 (or 302 to a presigned URL)
 *   DELETE /owner-bound/render/:jobId          → cancel
 *   GET    /health                             → { ok: true, accepting: boolean, ... }
 *
 * NOTE: this file must NOT be named `server.ts`. `@hyperframes/producer`'s main
 * module auto-starts its own bundled HTTP server (on PRODUCER_PORT, default
 * 9847) as an import side effect when the process entry path ends with
 * `/src/server.ts` or `/public-server.js`. We use the producer as a library, so
 * the entrypoint is `main.ts` to avoid spawning that phantom server.
 */
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { validateScene } from '@openmaic/dsl';
import { Hono, type Context } from 'hono';
import { postProcessInteractiveHtml } from '../../packages/@openmaic/generation/src/interactive-post-processor.js';
import { config } from './config.js';
import { hostedInteractiveLibraries } from './hosted-interactive-libraries.js';
import { InMemoryJobStore } from './job-store.js';
import { ShutdownGate } from './shutdown-gate.js';
import { LocalDiskArtifactStore } from './artifact-store.js';
import {
  RenderCoordinator,
  RenderRejectedError,
  makeProjectDir as defaultMakeProjectDir,
} from './render-coordinator.js';
import { InProcessExecutor, type RenderExecutor } from './render-executor.js';
import { InvalidProjectError, unzipProject as defaultUnzipProject } from './unzip.js';
import { hardenProjectDirectory } from './project-html-hardening.js';
import { capBodyStream } from './capped-stream.js';
import { Semaphore } from './semaphore.js';
import {
  EMPTY_PREVIEW_IMAGE_MESSAGE,
  classifyPreviewFailure,
  emitRenderEvent,
  type PreviewErrorCode,
  type RenderEventSink,
  type RuntimeCheckResult,
} from './events.js';
import { PreviewGate, PreviewRejectedError } from './preview-gate.js';
import {
  INTERACTIVE_RUNTIME_DEADLINE_MS,
  type InteractiveRuntimeError,
} from './interactive-runtime.js';
import {
  ChromiumPreviewRenderer,
  PreviewTimeoutError,
  buildSlideClientBundle,
  type InteractiveRuntimeRequest,
  type PreviewRenderer,
  type PreviewScene,
  type PreviewStageContext,
  type PreviewViewport,
} from './preview-renderer.js';
import { invalidSlideCanvasElementError, previewabilityError } from './preview-validation.js';
import type { JobStore } from './job-store.js';
import type { ArtifactStore } from './artifact-store.js';
import {
  isAdmissionIdentity,
  isRenderOwnerId,
  isTerminal,
  type AdmissionIdentity,
  type RenderOptions,
  type RenderOwnerId,
} from './types.js';
import { collectRuntimeVersions } from './runtime-info.js';
import { publicResourceProfile, validateResourceProfileStartup } from './resource-profile.js';
import type { RuntimeVersions } from './types.js';

/** Thrown inside the gated section for an oversized body (→ HTTP 413). */
class UploadTooLargeError extends Error {}
/** Thrown inside the gated section for a malformed request (→ HTTP 400). */
class BadRequestError extends Error {}
/** Thrown for a valid payload whose scene cannot produce a faithful preview (→ HTTP 422). */
class UnprocessablePreviewError extends Error {}

/** 429 body for an admission rejection: the prose plus its machine code, if any. */
function rejectionBody(error: Error & { reason?: string }): { error: string; reason?: string } {
  // Spread-omission keeps reason-less rejections (internal invariants) from
  // serializing `"reason": undefined` into the body.
  return { error: error.message, ...(error.reason ? { reason: error.reason } : {}) };
}

/** Collaborators the app depends on; injectable so the routes are testable. */
export interface AppDeps {
  jobs: JobStore;
  artifacts: ArtifactStore;
  coordinator: RenderCoordinator;
  /** Bounds concurrent *buffering + extraction* (the whole RAM-heavy section). */
  extractionGate: Semaphore;
  /** Independent preview admission, injectable for focused route tests. */
  previewGate?: PreviewGate;
  /** Preview execution capacity, independent of the video render queue. */
  previewExecutionGate?: Semaphore;
  /** Render one validated persisted scene to PNG. */
  previewRenderer?: PreviewRenderer;
  /** Check one validated interactive scene in Chromium. */
  interactiveRuntimeCheck?: (
    request: InteractiveRuntimeRequest,
  ) => Promise<InteractiveRuntimeError[]>;
  /** Preview wall-clock deadline, injectable for focused route tests. */
  previewDeadlineMs?: number;
  /** Runtime check execution-slot wait, injectable for focused route tests. */
  interactiveRuntimeWaitMs?: number;
  /** Preview JSON byte ceiling, injectable for focused route tests. */
  previewMaxJsonBytes?: number;
  /** Extract a validated archive into a dir. Overridable in tests. */
  unzipProject?: (zip: Uint8Array, destDir: string) => Promise<void>;
  /** Inject the untrusted render CSP into an extracted project. Overridable in tests. */
  hardenProject?: (projectDir: string) => Promise<void>;
  /** Create a fresh per-render scratch dir. Overridable in tests. */
  makeProjectDir?: () => Promise<string>;
  /**
   * Where route-level events go. The coordinator takes its own sink; pass the
   * same one here so an embedder that injects a sink receives every event type
   * rather than silently losing the two the routes emit.
   */
  onEvent?: RenderEventSink;
  /** Runtime identity reported by health and copied into per-render metrics. */
  runtimeVersions?: RuntimeVersions;
  /** The systemd resource executor fences video renders only; previews are disabled. */
  resourceMode?: boolean;
}

interface PreviewPayload {
  version: 1;
  scene: PreviewScene;
  stage: PreviewStageContext;
  viewport: PreviewViewport;
}

const RENDER_OWNER_HEADER = 'x-openmaic-render-owner';
const RENDER_OWNER_BOUND_HEADER = 'x-openmaic-render-owner-bound';
const ADMISSION_IDENTITY_HEADER = 'x-openmaic-client';
const INTERACTIVE_RUNTIME_CHECK_PATH = '/interactive-runtime-check';

function runtimeCheckResult(
  status: number,
  busyTimeout: boolean,
  aborted: boolean,
): RuntimeCheckResult {
  if (status === 200) return 'checked';
  if (status === 504) return 'deadline';
  if (busyTimeout) return 'busy_timeout';
  if (aborted) return 'aborted';
  return 'error';
}

function requestOwner(c: Context): RenderOwnerId | null {
  const value = c.req.header(RENDER_OWNER_HEADER)?.trim();
  return isRenderOwnerId(value) ? value : null;
}

function admissionIdentity(c: Context): AdmissionIdentity | null {
  const value = c.req.header(ADMISSION_IDENTITY_HEADER)?.trim();
  return isAdmissionIdentity(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePreviewPayload(value: unknown): PreviewPayload | string {
  if (!isRecord(value)) return 'Expected a JSON object';
  if (value.version !== 1) return 'Unsupported preview payload version';

  const sceneValidation = validateScene(value.scene);
  if (!sceneValidation.valid) {
    const issue = sceneValidation.errors[0];
    return issue ? `Invalid scene at ${issue.path || '/'}: ${issue.message}` : 'Invalid scene';
  }
  const invalidCanvasElement = invalidSlideCanvasElementError(value.scene);
  if (invalidCanvasElement) return invalidCanvasElement;
  const scene = value.scene as PreviewScene;

  if (!isRecord(value.stage)) return 'Invalid stage context';
  const stageId = value.stage.id;
  const stageName = value.stage.name;
  if (typeof stageId !== 'string' || !stageId.trim() || stageId.length > 256) {
    return 'Invalid stage id';
  }
  if (typeof stageName !== 'string' || !stageName.trim() || stageName.length > 10_000) {
    return 'Invalid stage name';
  }
  if (stageId !== scene.stageId) return 'Stage context does not match scene.stageId';

  if (!isRecord(value.viewport)) return 'Invalid viewport';
  const { width, height, deviceScaleFactor } = value.viewport;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < 64 || width > 4096) {
    return 'Invalid viewport width';
  }
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 64 || height > 4096) {
    return 'Invalid viewport height';
  }
  if (
    typeof deviceScaleFactor !== 'number' ||
    !Number.isFinite(deviceScaleFactor) ||
    deviceScaleFactor <= 0 ||
    deviceScaleFactor > config.resourceProfile.maxPreviewDeviceScaleFactor
  ) {
    return `Invalid deviceScaleFactor (maximum ${config.resourceProfile.maxPreviewDeviceScaleFactor} for ${config.resourceProfile.name})`;
  }
  const pixels = width * height * deviceScaleFactor * deviceScaleFactor;
  if (pixels > config.resourceProfile.maxPreviewPixels) {
    return `Preview exceeds the ${config.resourceProfile.name} resource profile pixel limit`;
  }

  return {
    version: 1,
    scene,
    stage: { id: stageId, name: stageName },
    viewport: { width, height, deviceScaleFactor },
  };
}

/** Buffer and parse a byte-capped JSON body while preserving socket backpressure. */
async function readPreviewPayload(
  c: Context,
  signal: AbortSignal,
  maxJsonBytes: number,
): Promise<unknown> {
  if (!c.req.header('content-type')?.toLowerCase().includes('application/json')) {
    throw new BadRequestError('Expected application/json');
  }

  const raw = c.req.raw;
  let value: unknown;
  let capped: ReturnType<typeof capBodyStream> | undefined;
  try {
    if (raw.body) {
      capped = capBodyStream(raw.body, maxJsonBytes, signal);
      const bounded = new Request(raw.url, {
        method: raw.method,
        headers: raw.headers,
        body: capped.stream,
        signal,
        duplex: 'half',
      } as RequestInit);
      value = await bounded.json();
    } else {
      signal.throwIfAborted();
      value = await c.req.json();
    }
  } catch {
    if (capped?.exceeded()) throw new UploadTooLargeError('Upload too large');
    if (signal.aborted)
      throw signal.reason ?? new PreviewTimeoutError('Preview exceeded the deadline');
    throw new BadRequestError('Expected valid JSON');
  }

  return value;
}

/** Parse + validate the multipart render options. Returns options or an error string. */
function parseOptions(form: FormData): RenderOptions | string {
  const fps = Number.parseInt(String(form.get('fps') ?? '30'), 10);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 120) return 'Invalid fps';

  const quality = String(form.get('quality') ?? 'standard');
  if (quality !== 'draft' && quality !== 'standard' && quality !== 'high') {
    return 'Invalid quality (expected draft|standard|high)';
  }

  const format = String(form.get('format') ?? 'mp4');
  if (format !== 'mp4') return 'Unsupported format (only mp4)';

  return { fps, quality, format };
}

/**
 * Build the render-service HTTP app over injected collaborators.
 *
 * Admission ordering is the security boundary here:
 *  1. Each route's admission gate runs FIRST, before anything is read — a
 *     rejected caller never buffers a byte.
 *  2. The whole RAM-heavy section — buffering the multipart (`formData()` is
 *     what materializes the uploaded file into memory), parsing, reading the
 *     file bytes, and extracting — runs INSIDE `extractionGate`. So at most
 *     `maxConcurrentExtractions` bodies are ever buffered at once; the rest wait
 *     with their request body still unconsumed (backpressured on the socket),
 *     not held in RAM. This is what stops a near-cap burst from OOMing the box.
 */
export function createApp(deps: AppDeps): Hono {
  const { jobs, artifacts, coordinator, extractionGate } = deps;
  const unzipProject = deps.unzipProject ?? defaultUnzipProject;
  const hardenProject = deps.hardenProject ?? hardenProjectDirectory;
  const makeProjectDir = deps.makeProjectDir ?? defaultMakeProjectDir;
  const chromium = new ChromiumPreviewRenderer();
  const previewRenderer = deps.previewRenderer ?? chromium;
  const checkInteractiveRuntime =
    deps.interactiveRuntimeCheck ?? chromium.checkInteractiveRuntime.bind(chromium);
  const previewDeadlineMs = deps.previewDeadlineMs ?? config.previewDeadlineMs;
  const interactiveRuntimeWaitMs = deps.interactiveRuntimeWaitMs ?? config.interactiveRuntimeWaitMs;
  const previewMaxJsonBytes = deps.previewMaxJsonBytes ?? config.previewMaxJsonBytes;
  const onEvent = deps.onEvent ?? emitRenderEvent;
  const previewGate =
    deps.previewGate ?? new PreviewGate(config.previewMaxInFlight, config.previewMaxPerUser);
  const previewExecutionGate =
    deps.previewExecutionGate ?? new Semaphore(config.previewMaxConcurrency);

  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.header(RENDER_OWNER_BOUND_HEADER, '1');
  });

  app.get('/health', (c) =>
    c.json({
      ok: true,
      // Aggregate-only by design — the full rationale lives on
      // RenderCoordinator#accepting (never queue depths or per-identity data).
      accepting: coordinator.accepting,
      previewMaxConcurrency: config.previewMaxConcurrency,
      interactiveRuntimeCheck:
        !deps.resourceMode &&
        Boolean(process.env.PRODUCER_HEADLESS_SHELL_PATH || process.env.PUPPETEER_EXECUTABLE_PATH),
      interactiveRuntimeHostedLibraries: true,
      resourceProfile: publicResourceProfile(config.resourceProfile),
      versions: deps.runtimeVersions ?? null,
    }),
  );

  app.post('/owner-bound/render', async (c) => {
    const ownerId = requestOwner(c);
    const identity = admissionIdentity(c);
    if (!ownerId || !identity) return c.json({ error: 'Invalid render identity' }, 400);

    // Reject an oversized body by declared length first (courtesy 413 for honest
    // clients). The real bound is the byte-counting cap below, since
    // Content-Length is client-supplied and absent on chunked uploads.
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > config.maxUploadBytes) {
      return c.json({ error: 'Upload too large' }, 413);
    }

    // Reserve a queue slot BEFORE the buffering permit, so a rejected caller
    // (queue full / per-identity limit) never enters buffering or extraction.
    let reservation;
    try {
      reservation = coordinator.reserve(identity);
    } catch (error) {
      if (error instanceof RenderRejectedError) {
        onEvent({
          event: 'render_admission_rejected',
          route: '/owner-bound/render',
          reason: error.reason ?? 'unspecified',
          status: 429,
        });
        return c.json(rejectionBody(error), 429);
      }
      throw error;
    }

    // From here every failure MUST release the reservation.
    let projectDir: string | undefined;
    try {
      // The ENTIRE memory-heavy section runs under the extraction permit:
      // buffering the body (formData), reading the file, and unzipping. Requests
      // beyond the permit wait here with their body still unconsumed, so only
      // `maxConcurrentExtractions` bodies are buffered concurrently.
      const jobId = await extractionGate.run(async () => {
        const raw = c.req.raw;
        let form: FormData;
        let capped: ReturnType<typeof capBodyStream> | undefined;
        try {
          if (raw.body) {
            // Cap the raw body as it streams into formData(), so a chunked /
            // length-lying upload can't exceed the byte ceiling mid-parse.
            capped = capBodyStream(raw.body, config.maxUploadBytes);
            const bounded = new Request(raw.url, {
              method: raw.method,
              headers: raw.headers,
              body: capped.stream,
              // duplex is required for a streaming request body.
              duplex: 'half',
            } as RequestInit);
            form = await bounded.formData();
          } else {
            form = await c.req.formData();
          }
        } catch {
          if (capped?.exceeded()) throw new UploadTooLargeError('Upload too large');
          throw new BadRequestError('Expected multipart/form-data');
        }

        const options = parseOptions(form);
        if (typeof options === 'string') throw new BadRequestError(options);

        const file = form.get('project');
        if (!(file instanceof File)) {
          throw new BadRequestError('Missing "project" file field');
        }

        projectDir = await makeProjectDir();
        const bytes = new Uint8Array(await file.arrayBuffer());
        await unzipProject(bytes, projectDir);
        // Harden the extracted HTML before the producer reads any of it.
        await hardenProject(projectDir);
        return coordinator.submit({ reservation, ownerId, projectDir, options });
      });
      return c.json({ jobId }, 202);
    } catch (error) {
      coordinator.release(reservation);
      if (projectDir) await coordinator.cleanupProject(projectDir);
      if (error instanceof UploadTooLargeError) return c.json({ error: error.message }, 413);
      if (error instanceof BadRequestError) return c.json({ error: error.message }, 400);
      if (error instanceof InvalidProjectError) return c.json({ error: error.message }, 400);
      if (error instanceof RenderRejectedError) {
        onEvent({
          event: 'render_admission_rejected',
          route: '/owner-bound/render',
          reason: error.reason ?? 'unspecified',
          status: 429,
        });
        return c.json(rejectionBody(error), 429);
      }
      throw error;
    }
  });

  // Times every response the preview route produces — 200, 413, 429, 504, 500
  // alike. A synchronous preview reports failure in its status, so this is the
  // one place a deployment can see the route's real success rate and latency.
  // A 5xx also carries why it failed, as a fixed code the handler records
  // against its request (never the error message).
  const previewFailures = new WeakMap<Request, PreviewErrorCode>();
  const runtimeWaitTimeouts = new WeakSet<Request>();
  const previewRoutes = ['/preview', INTERACTIVE_RUNTIME_CHECK_PATH];
  app.on('POST', previewRoutes, async (c, next) => {
    const startedAt = Date.now();
    await next();
    const errorCode =
      c.res.status >= 500 ? (previewFailures.get(c.req.raw) ?? 'internal') : undefined;
    onEvent({
      event: 'preview_request',
      route: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
      ...(errorCode ? { errorCode } : {}),
      ...(c.req.path === INTERACTIVE_RUNTIME_CHECK_PATH
        ? {
            runtimeCheckResult: runtimeCheckResult(
              c.res.status,
              runtimeWaitTimeouts.has(c.req.raw),
              c.req.raw.signal.aborted,
            ),
          }
        : {}),
    });
  });

  app.on('POST', previewRoutes, async (c) => {
    // Resource mode cannot run Chromium here: this HTTP process is outside the
    // per-task cgroup. Reject before inspecting or buffering the request body.
    if (deps.resourceMode) {
      previewFailures.set(c.req.raw, 'resource_mode_unsupported');
      return c.json(
        {
          error: 'Preview is unavailable while per-task resource budgets are enabled',
          reason: 'resource_mode_unsupported',
        },
        503,
      );
    }
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > previewMaxJsonBytes) {
      return c.json({ error: 'Upload too large' }, 413);
    }

    const runtimeCheck = c.req.path === INTERACTIVE_RUNTIME_CHECK_PATH;
    const identity = c.req.header('x-openmaic-client')?.trim() || 'anonymous';
    let release: () => void;
    try {
      release = previewGate.acquire(identity);
    } catch (error) {
      if (error instanceof PreviewRejectedError) {
        onEvent({
          event: 'render_admission_rejected',
          route: c.req.path,
          reason: (error as Error & { reason?: string }).reason ?? 'unspecified',
          status: 429,
        });
        return c.json(rejectionBody(error), 429);
      }
      throw error;
    }

    const deadlineAbort = new AbortController();
    const budgetMs = runtimeCheck
      ? Math.min(previewDeadlineMs, INTERACTIVE_RUNTIME_DEADLINE_MS)
      : previewDeadlineMs;
    const expiresAt = performance.now() + budgetMs;
    const deadline = setTimeout(
      () => deadlineAbort.abort(new PreviewTimeoutError('Preview exceeded the deadline')),
      budgetMs,
    );
    deadline.unref?.();
    // The Fetch request signal is backed by the Node request's close event, so
    // disconnecting clients abort body reads and Chromium work immediately.
    const signal = AbortSignal.any([c.req.raw.signal, deadlineAbort.signal]);

    try {
      // The extraction permit covers only byte buffering + JSON parse. A parsed
      // scene is bounded by previewMaxJsonBytes times the parser's expansion,
      // and PreviewGate bounds live parsed scenes to previewMaxInFlight.
      const value = await extractionGate.run(
        () => readPreviewPayload(c, signal, previewMaxJsonBytes),
        signal,
      );
      const payload = parsePreviewPayload(value);
      if (typeof payload === 'string') throw new BadRequestError(payload);
      const checkScene =
        runtimeCheck && payload.scene.type === 'interactive' ? payload.scene : undefined;
      if (runtimeCheck && !checkScene) {
        throw new BadRequestError('Runtime checks require an interactive scene');
      }
      if (checkScene?.content.html?.trim()) {
        // Playback processes stored scene HTML. Validate the resulting hosted
        // references under the same request admission and deadline.
        signal.throwIfAborted();
        checkScene.content.html = postProcessInteractiveHtml(checkScene.content.html);
        if (performance.now() >= expiresAt) {
          throw new PreviewTimeoutError('Preview exceeded the deadline');
        }
      }
      const unpreviewable = previewabilityError(
        payload.scene,
        checkScene ? (url) => hostedInteractiveLibraries.match(url) !== undefined : undefined,
      );
      if (unpreviewable) throw new UnprocessablePreviewError(unpreviewable);
      const remainingMs = Math.ceil(expiresAt - performance.now());
      if (remainingMs <= 0) throw new PreviewTimeoutError('Preview exceeded the deadline');
      signal.throwIfAborted();
      const request = {
        scene: payload.scene,
        stage: payload.stage,
        viewport: payload.viewport,
        signal,
        deadlineMs: remainingMs,
      };
      if (checkScene) {
        const busy = new PreviewRejectedError(
          'Timed out waiting for preview capacity; retry shortly.',
          'capacity_busy',
        );
        const waitAbort = new AbortController();
        const waitExpiresAt = performance.now() + interactiveRuntimeWaitMs;
        const waitTimer =
          waitExpiresAt < expiresAt
            ? setTimeout(() => waitAbort.abort(busy), interactiveRuntimeWaitMs)
            : undefined;
        waitTimer?.unref();
        try {
          return await previewExecutionGate.run(
            async () => {
              clearTimeout(waitTimer);
              signal.throwIfAborted();
              const now = performance.now();
              const deadlineMs = Math.ceil(expiresAt - now);
              if (deadlineMs <= 0) throw new PreviewTimeoutError('Preview exceeded the deadline');
              if (now >= waitExpiresAt) throw busy;
              const errors = await checkInteractiveRuntime({
                ...request,
                scene: checkScene,
                deadlineMs,
              });
              signal.throwIfAborted();
              return c.json({ errors });
            },
            AbortSignal.any([signal, waitAbort.signal]),
          );
        } catch (error) {
          if (error === busy) runtimeWaitTimeouts.add(c.req.raw);
          throw error;
        } finally {
          clearTimeout(waitTimer);
        }
      }
      const releaseExecution = previewExecutionGate.tryAcquire();
      if (!releaseExecution) {
        throw new PreviewRejectedError(
          'Preview capacity is busy with another preview; retry shortly.',
          'capacity_busy',
        );
      }
      let png: Uint8Array;
      try {
        png = await previewRenderer.render(request);
      } finally {
        releaseExecution();
      }
      if (png.byteLength === 0) throw new Error(EMPTY_PREVIEW_IMAGE_MESSAGE);

      const body = new Uint8Array(png.byteLength);
      body.set(png);
      return new Response(body.buffer, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(png.byteLength),
        },
      });
    } catch (error) {
      if (error instanceof UploadTooLargeError) return c.json({ error: error.message }, 413);
      if (error instanceof BadRequestError) return c.json({ error: error.message }, 400);
      if (error instanceof UnprocessablePreviewError) {
        return c.json({ error: error.message }, 422);
      }
      if (error instanceof PreviewRejectedError) {
        onEvent({
          event: 'render_admission_rejected',
          route: c.req.path,
          reason: (error as Error & { reason?: string }).reason ?? 'unspecified',
          status: 429,
        });
        return c.json(rejectionBody(error), 429);
      }
      if (error instanceof PreviewTimeoutError || deadlineAbort.signal.aborted) {
        previewFailures.set(c.req.raw, 'deadline_exceeded');
        return c.json({ error: 'Preview exceeded the deadline' }, 504);
      }
      previewFailures.set(c.req.raw, classifyPreviewFailure(error));
      return c.json(
        { error: error instanceof Error ? error.message : 'Preview rendering failed' },
        500,
      );
    } finally {
      clearTimeout(deadline);
      release();
    }
  });

  app.get('/owner-bound/render/:jobId', async (c) => {
    const ownerId = requestOwner(c);
    if (!ownerId) return c.json({ error: 'Invalid render identity' }, 400);
    const job = await jobs.getForOwner(c.req.param('jobId'), ownerId);
    if (!job) return c.json({ error: 'Job not found' }, 404);
    // Only attach position when the job store still says queued AND the coordinator
    // confirms the slot exists. If pump() has already shifted the job but run()
    // hasn't written `running` to the store yet, the gap produces null and we omit
    // rather than show a stale 0.
    const queuePosition = job.status === 'queued' ? coordinator.getQueuePosition(job.id) : null;
    return c.json({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      currentStage: job.currentStage,
      framesRendered: job.framesRendered,
      totalFrames: job.totalFrames,
      metrics: job.metrics,
      resources: job.resources && {
        published: job.resources.published,
        cleanupVerified: job.resources.cleanupVerified,
        reservationReturned: job.resources.reservationReturned,
        admissionClosed: job.resources.admissionClosed,
        ...(job.resources.diagnosticCode ? { diagnosticCode: job.resources.diagnosticCode } : {}),
      },
      error: job.error,
      done: isTerminal(job.status),
      ...(queuePosition !== null ? { queuePosition } : {}),
    });
  });

  app.delete('/owner-bound/render/:jobId', async (c) => {
    const ownerId = requestOwner(c);
    if (!ownerId) return c.json({ error: 'Invalid render identity' }, 400);
    const ok = await coordinator.cancelForOwner(c.req.param('jobId'), ownerId);
    if (!ok) return c.json({ error: 'Job not found' }, 404);
    return c.json({ cancelled: true });
  });

  app.get('/owner-bound/render/:jobId/download', async (c) => {
    const ownerId = requestOwner(c);
    if (!ownerId) return c.json({ error: 'Invalid render identity' }, 400);
    const jobId = c.req.param('jobId');
    const job = await jobs.getForOwner(jobId, ownerId);
    if (!job) return c.json({ error: 'Job not found' }, 404);
    if (job.status !== 'succeeded') {
      return c.json({ error: `Job not ready (status: ${job.status})` }, 409);
    }

    const location = await artifacts.locate(jobId);
    if (!location) return c.json({ error: 'Artifact expired or missing' }, 404);

    // Presigned-URL stores (demo layer) redirect the browser straight to storage.
    if (location.kind === 'url') return c.redirect(location.href, 302);

    const { size } = await stat(location.path).catch(() => ({ size: 0 }));
    if (!size) return c.json({ error: 'Artifact missing on disk' }, 404);

    const webStream = Readable.toWeb(createReadStream(location.path)) as ReadableStream;
    return new Response(webStream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="${jobId}.mp4"`,
      },
    });
  });

  return app;
}

/** Wire the production collaborators and start the server (skipped under tests). */
export async function startService(resourceExecutor?: RenderExecutor): Promise<void> {
  const artifacts = new LocalDiskArtifactStore();
  validateResourceProfileStartup(config.resourceProfile);
  const runtimeVersions = await collectRuntimeVersions();
  if (resourceExecutor) runtimeVersions.producer = '0.8.37 (official, outer resource fence)';
  const executor =
    resourceExecutor ??
    new InProcessExecutor({
      runtimeVersions,
      ...(config.chunkExecutionEnabled
        ? {
            chunkExecution: {
              chunkCount: config.chunkCount,
              chunkWorkers: config.chunkWorkers,
              maxParallelChunks: config.maxParallelChunks,
              ...(config.chunkSizeFrames > 0 ? { chunkSizeFrames: config.chunkSizeFrames } : {}),
              ...(config.targetChunkFrames > 0
                ? { targetChunkFrames: config.targetChunkFrames }
                : {}),
            },
          }
        : {}),
    });
  // Assigned after `jobs` so its reap callback can close over them.
  // eslint-disable-next-line prefer-const
  let coordinator: RenderCoordinator;
  // eslint-disable-next-line prefer-const
  let shutdown: ShutdownGate;
  const jobs = new InMemoryJobStore(config.jobTtlMs, (record) => {
    // A reaped job's artifact + project dir go with it.
    void artifacts.remove(record.id);
    void coordinator.cleanupProject(record.projectDir);
    shutdown.forget(record.id);
  });
  coordinator = new RenderCoordinator(executor, jobs, artifacts);
  shutdown = new ShutdownGate(jobs, () => process.exit(0));

  // On SIGTERM, stop admitting: `/health` reports `accepting: false`, so a
  // caller that checks it before sending a render (the app's durable export
  // queue) sends nothing more here. The process exits once nothing is left
  // (src/shutdown-gate.ts): no render, no upload still answering, and no
  // finished output not yet fetched. Now if that is already so, as before
  // this handler existed. Nothing extends the platform's grace period: a
  // render still running when it ends is killed with the process, and that
  // caller sends it again. The resource entrypoint has its own SIGTERM
  // handler, which closes the resource owner and exits.
  process.once('SIGTERM', () => {
    coordinator.closeAdmission(resourceExecutor ? undefined : () => shutdown.idle());
  });

  // Build the browser mount off the request path so the first preview does not
  // pay the cold esbuild cost while holding admission and execution permits.
  if (!resourceExecutor) {
    const libraryDirectory = await stat(config.interactiveLibraryDir).catch(() => null);
    if (!libraryDirectory?.isDirectory()) {
      console.warn('[render-service] Interactive library directory is unavailable.');
    }
    await buildSlideClientBundle();
  }

  const app = createApp({
    jobs,
    artifacts,
    coordinator,
    // Bounds concurrent buffering + extraction so the per-archive RAM ceiling
    // can't stack across a burst of admitted requests.
    extractionGate: new Semaphore(config.maxConcurrentExtractions),
    runtimeVersions,
    resourceMode: resourceExecutor !== undefined,
  });

  // Ensure the scratch root exists before accepting work. On the documented
  // standalone path nothing creates /tmp/openmaic-renders, so without this every
  // makeProjectDir() would ENOENT. mktemp still creates a fresh subdir per job.
  await mkdir(config.tmpDir, { recursive: true }).catch(() => {});

  const fetchRequest = resourceExecutor ? app.fetch : shutdown.wrap(app.fetch);

  serve({ fetch: fetchRequest, port: config.port }, (info) => {
    console.log(
      `[render-service] listening on :${info.port} ` +
        `(resourceProfile=${config.resourceProfile.name}, ` +
        `capturePolicy=${config.resourceProfile.capturePolicy}, ` +
        `requestedCaptureMode=${config.resourceProfile.requestedCaptureMode}, ` +
        `maxConcurrency=${config.maxConcurrency}, producerWorkers=${config.producerWorkers}, ` +
        `browserGpuMode=${process.env.PRODUCER_BROWSER_GPU_MODE ?? 'producer-default'}, ` +
        `browserPool=${process.env.PRODUCER_ENABLE_BROWSER_POOL ?? 'producer-default'}, ` +
        `lowMemoryMode=${process.env.PRODUCER_LOW_MEMORY_MODE ?? 'auto'}, ` +
        `staticDedup=${process.env.HF_STATIC_DEDUP ?? 'producer-default'}, ` +
        `headlessShell=${process.env.PRODUCER_HEADLESS_SHELL_PATH ?? 'unset'}, ` +
        `requireBeginFrame=${config.requireBeginFrame}, ` +
        `producer=${runtimeVersions.producer}, node=${runtimeVersions.node}, ` +
        `chromium=${runtimeVersions.chromium}, ffmpeg=${runtimeVersions.ffmpeg})`,
    );
  });
}

// Only auto-start when run as the entrypoint, not when imported by tests.
if (process.env.RENDER_SERVICE_NO_LISTEN !== 'true') {
  await startService();
}
