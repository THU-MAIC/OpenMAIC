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
 *   POST   /render                 multipart: project(zip) + fps/quality/format → 202 { jobId }
 *   POST   /preview                JSON: scene + stage + viewport → PNG
 *   GET    /render/:jobId          → { status, progress, currentStage, done, ... }
 *   GET    /render/:jobId/download → stream MP4 (or 302 to a presigned URL)
 *   DELETE /render/:jobId          → cancel
 *   GET    /health                 → { ok: true }
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
import { config } from './config.js';
import { InMemoryJobStore } from './job-store.js';
import { LocalDiskArtifactStore } from './artifact-store.js';
import {
  RenderCoordinator,
  RenderRejectedError,
  makeProjectDir as defaultMakeProjectDir,
} from './render-coordinator.js';
import { InProcessExecutor } from './render-executor.js';
import { InvalidProjectError, unzipProject as defaultUnzipProject } from './unzip.js';
import { capBodyStream } from './capped-stream.js';
import { Semaphore } from './semaphore.js';
import { PreviewGate, PreviewRejectedError } from './preview-gate.js';
import {
  ChromiumPreviewRenderer,
  PreviewTimeoutError,
  type PreviewRenderer,
  type PreviewScene,
  type PreviewStageContext,
  type PreviewViewport,
} from './preview-renderer.js';
import type { JobStore } from './job-store.js';
import type { ArtifactStore } from './artifact-store.js';
import { isTerminal, type RenderOptions } from './types.js';
import { collectRuntimeVersions } from './runtime-info.js';
import { publicResourceProfile, validateResourceProfileStartup } from './resource-profile.js';
import type { RuntimeVersions } from './types.js';

/** Thrown inside the gated section for an oversized body (→ HTTP 413). */
class UploadTooLargeError extends Error {}
/** Thrown inside the gated section for a malformed request (→ HTTP 400). */
class BadRequestError extends Error {}

/** Collaborators the app depends on; injectable so the routes are testable. */
export interface AppDeps {
  jobs: JobStore;
  artifacts: ArtifactStore;
  coordinator: RenderCoordinator;
  /** Bounds concurrent *buffering + extraction* (the whole RAM-heavy section). */
  extractionGate: Semaphore;
  /** Independent preview admission, injectable for focused route tests. */
  previewGate?: PreviewGate;
  /** Render one validated persisted scene to PNG. */
  previewRenderer?: PreviewRenderer;
  /** Preview wall-clock deadline, injectable for focused route tests. */
  previewDeadlineMs?: number;
  /** Extract a validated archive into a dir. Overridable in tests. */
  unzipProject?: (zip: Uint8Array, destDir: string) => Promise<void>;
  /** Create a fresh per-render scratch dir. Overridable in tests. */
  makeProjectDir?: () => Promise<string>;
  /** Runtime identity reported by health and copied into per-render metrics. */
  runtimeVersions?: RuntimeVersions;
}

interface PreviewPayload {
  version: 1;
  scene: PreviewScene;
  stage: PreviewStageContext;
  viewport: PreviewViewport;
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

/** Parse a byte-capped JSON body while preserving socket backpressure. */
async function readPreviewPayload(c: Context, signal: AbortSignal): Promise<PreviewPayload> {
  if (!c.req.header('content-type')?.toLowerCase().includes('application/json')) {
    throw new BadRequestError('Expected application/json');
  }

  const raw = c.req.raw;
  let value: unknown;
  let capped: ReturnType<typeof capBodyStream> | undefined;
  try {
    if (raw.body) {
      capped = capBodyStream(raw.body, config.maxUploadBytes, signal);
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

  const payload = parsePreviewPayload(value);
  if (typeof payload === 'string') throw new BadRequestError(payload);
  return payload;
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
  const makeProjectDir = deps.makeProjectDir ?? defaultMakeProjectDir;
  const previewRenderer = deps.previewRenderer ?? new ChromiumPreviewRenderer();
  const previewDeadlineMs = deps.previewDeadlineMs ?? config.previewDeadlineMs;
  const previewGate =
    deps.previewGate ?? new PreviewGate(config.previewMaxInFlight, config.previewMaxPerUser);

  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      resourceProfile: publicResourceProfile(config.resourceProfile),
      versions: deps.runtimeVersions ?? null,
    }),
  );

  app.post('/render', async (c) => {
    // Reject an oversized body by declared length first (courtesy 413 for honest
    // clients). The real bound is the byte-counting cap below, since
    // Content-Length is client-supplied and absent on chunked uploads.
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > config.maxUploadBytes) {
      return c.json({ error: 'Upload too large' }, 413);
    }

    // Identity is derived by the trusted proxy (client IP) and passed in a header;
    // a client-supplied multipart `userId` is deliberately ignored so it can't be
    // rotated to bypass the per-identity guard.
    const identity = c.req.header('x-openmaic-client')?.trim() || 'anonymous';

    // Reserve a queue slot BEFORE the buffering permit, so a rejected caller
    // (queue full / per-identity limit) never enters buffering or extraction.
    let reservation;
    try {
      reservation = coordinator.reserve(identity);
    } catch (error) {
      if (error instanceof RenderRejectedError) return c.json({ error: error.message }, 429);
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
        return coordinator.submit(reservation, projectDir, options);
      });
      return c.json({ jobId }, 202);
    } catch (error) {
      coordinator.release(reservation);
      if (projectDir) await coordinator.cleanupProject(projectDir);
      if (error instanceof UploadTooLargeError) return c.json({ error: error.message }, 413);
      if (error instanceof BadRequestError) return c.json({ error: error.message }, 400);
      if (error instanceof InvalidProjectError) return c.json({ error: error.message }, 400);
      if (error instanceof RenderRejectedError) return c.json({ error: error.message }, 429);
      throw error;
    }
  });

  app.post('/preview', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > config.maxUploadBytes) {
      return c.json({ error: 'Upload too large' }, 413);
    }

    const identity = c.req.header('x-openmaic-client')?.trim() || 'anonymous';
    let release: () => void;
    try {
      release = previewGate.acquire(identity);
    } catch (error) {
      if (error instanceof PreviewRejectedError) return c.json({ error: error.message }, 429);
      throw error;
    }

    const abort = new AbortController();
    const deadline = setTimeout(
      () => abort.abort(new PreviewTimeoutError('Preview exceeded the deadline')),
      previewDeadlineMs,
    );
    deadline.unref?.();

    try {
      // Keep the memory permit until the parsed scene has been rendered, so a
      // burst cannot accumulate large expanded JSON objects while waiting for
      // Chromium. The coordinator gate shares Chromium capacity with videos.
      const png = await extractionGate.run(async () => {
        const payload = await readPreviewPayload(c, abort.signal);
        return coordinator.runWithExecutionSlot(
          () =>
            previewRenderer.render({
              scene: payload.scene,
              stage: payload.stage,
              viewport: payload.viewport,
              signal: abort.signal,
            }),
          abort.signal,
        );
      }, abort.signal);
      if (png.byteLength === 0) throw new Error('Preview renderer returned an empty image');

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
      if (error instanceof PreviewTimeoutError || abort.signal.aborted) {
        return c.json({ error: 'Preview exceeded the deadline' }, 504);
      }
      return c.json(
        { error: error instanceof Error ? error.message : 'Preview rendering failed' },
        500,
      );
    } finally {
      clearTimeout(deadline);
      release();
    }
  });

  app.get('/render/:jobId', async (c) => {
    const job = await jobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: 'Job not found' }, 404);
    return c.json({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      currentStage: job.currentStage,
      framesRendered: job.framesRendered,
      totalFrames: job.totalFrames,
      metrics: job.metrics,
      error: job.error,
      done: isTerminal(job.status),
    });
  });

  app.delete('/render/:jobId', async (c) => {
    const ok = await coordinator.cancel(c.req.param('jobId'));
    if (!ok) return c.json({ error: 'Job not found' }, 404);
    return c.json({ cancelled: true });
  });

  app.get('/render/:jobId/download', async (c) => {
    const jobId = c.req.param('jobId');
    const job = await jobs.get(jobId);
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
async function main(): Promise<void> {
  const artifacts = new LocalDiskArtifactStore();
  validateResourceProfileStartup(config.resourceProfile);
  const runtimeVersions = await collectRuntimeVersions();
  const executor = new InProcessExecutor({
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
  // Assigned after `jobs` so its reap callback can close over the coordinator.
  // eslint-disable-next-line prefer-const
  let coordinator: RenderCoordinator;
  const jobs = new InMemoryJobStore(config.jobTtlMs, (record) => {
    // A reaped job's artifact + project dir go with it.
    void artifacts.remove(record.id);
    void coordinator.cleanupProject(record.projectDir);
  });
  coordinator = new RenderCoordinator(executor, jobs, artifacts);

  const app = createApp({
    jobs,
    artifacts,
    coordinator,
    // Bounds concurrent buffering + extraction so the per-archive RAM ceiling
    // can't stack across a burst of admitted requests.
    extractionGate: new Semaphore(config.maxConcurrentExtractions),
    runtimeVersions,
  });

  // Ensure the scratch root exists before accepting work. On the documented
  // standalone path nothing creates /tmp/openmaic-renders, so without this every
  // makeProjectDir() would ENOENT. mktemp still creates a fresh subdir per job.
  await mkdir(config.tmpDir, { recursive: true }).catch(() => {});

  serve({ fetch: app.fetch, port: config.port }, (info) => {
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
  await main();
}
