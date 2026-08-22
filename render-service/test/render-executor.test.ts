import { createRenderJob, RenderCancelledError } from '@hyperframes/producer';
import { describe, expect, it, vi } from 'vitest';
import { InProcessExecutor } from '../src/render-executor.js';
import type { RenderExecutionRequest, RuntimeVersions } from '../src/types.js';

const options = { fps: 30, quality: 'standard', format: 'mp4' } as const;
const runtimeVersions: RuntimeVersions = {
  service: '0.1.0',
  producer: '0.7.60',
  node: 'v22.22.2',
  chromium: 'Chromium 151.0.7922.71',
  chromiumPath: '/usr/bin/chromium-headless-shell',
  ffmpeg: 'ffmpeg version 5.1.9-0+deb12u1',
  ffmpegPath: '/usr/bin/ffmpeg',
  containerImage: 'openmaic/render-service:test',
};

function request(overrides: Partial<RenderExecutionRequest> = {}): RenderExecutionRequest {
  return {
    projectDir: '/tmp/project',
    outputPath: '/tmp/project/output.mp4',
    options,
    signal: new AbortController().signal,
    deadlineMs: 1_000,
    onProgress() {},
    ...overrides,
  };
}

function setPerformance(job: ReturnType<typeof createRenderJob>, captureMode = 'beginframe'): void {
  job.perfSummary = {
    renderId: job.id,
    totalElapsedMs: 1_200,
    fps: 30,
    quality: 'standard',
    workers: 2,
    chunkedEncode: false,
    chunkSizeFrames: null,
    compositionDurationSeconds: 2,
    totalFrames: 60,
    resolution: { width: 1920, height: 1080 },
    videoCount: 0,
    audioCount: 0,
    stages: { compileMs: 100, captureMs: 900, encodeMs: 200 },
    drawElement: {
      mode: captureMode,
      workerEncode: false,
      verifyArmed: 0,
      verifyChecked: 0,
      verifyInitMs: 0,
      selfVerifyFallback: false,
      blankSuspects: 0,
      blankDeterministicAccepts: 0,
      blankRecaptures: 0,
      boundaryFrames: 0,
      ncprFallbacks: 0,
    },
  };
}

describe('InProcessExecutor', () => {
  it('uses the bounded chunk executor without changing the executor contract', async () => {
    const chunkExecutor = vi.fn(async (request) => ({
      plan: {
        schemaVersion: 1 as const,
        planHash: 'plan-hash',
        planDir: '/tmp/plan',
        projectDir: request.projectDir,
        projectHash: 'project-hash',
        outputPath: request.outputPath,
        options: request.options,
        chunkCount: 2,
        maxParallelChunks: 1,
        chunkWorkers: 1,
        totalFrames: 60,
        fps: 30,
        width: 1920,
        height: 1080,
        format: 'mp4' as const,
        producerVersion: 'producer',
        ffmpegVersion: 'ffmpeg',
        nodeVersion: runtimeVersions.node,
        chromiumVersion: runtimeVersions.chromium,
        captureMode: 'beginframe',
        assets: [],
        fonts: [],
        runtime: {},
        chunks: [],
      },
      chunks: [
        {
          outputPath: '/tmp/chunk-0.mp4',
          outputKind: 'file' as const,
          framesEncoded: 30,
          sha256: 'a',
          durationMs: 10,
          planHashMs: 1,
          sessionBootMs: 1,
          captureStageMs: 5,
          encodeStageMs: 3,
          workers: 1,
          captureMode: 'beginframe' as const,
          perfPath: '/tmp/chunk-0.mp4.perf.json',
        },
        {
          outputPath: '/tmp/chunk-1.mp4',
          outputKind: 'file' as const,
          framesEncoded: 30,
          sha256: 'b',
          durationMs: 12,
          planHashMs: 1,
          sessionBootMs: 1,
          captureStageMs: 6,
          encodeStageMs: 4,
          workers: 1,
          captureMode: 'beginframe' as const,
          perfPath: '/tmp/chunk-1.mp4.perf.json',
        },
      ],
      assembly: { outputPath: request.outputPath, durationMs: 5, framesEncoded: 60, fileSize: 1 },
      totalElapsedMs: 27,
      stages: { planMs: 2, chunksMs: 20, assembleMs: 5 },
    }));
    const executor = new InProcessExecutor({
      runtimeVersions,
      chunkExecutor,
      chunkExecution: { chunkCount: 2, chunkWorkers: 1, maxParallelChunks: 1 },
    });

    const result = await executor.execute(request());

    expect(result).toMatchObject({
      status: 'succeeded',
      performance: { totalFrames: 60, workers: 1 },
    });
    expect(chunkExecutor).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: '/tmp/project',
        chunkCount: 2,
        chunkWorkers: 1,
        maxParallelChunks: 1,
      }),
    );
  });

  it('normalizes progress and maps producer performance into domain data', async () => {
    const progress = [];
    const executor = new InProcessExecutor(
      { workers: 2, requireBeginFrame: true, runtimeVersions },
      {
        createJob(options) {
          return createRenderJob(options);
        },
        async executeJob(job, _projectDir, _outputPath, onProgress) {
          job.progress = 150;
          job.currentStage = 'capturing';
          job.framesRendered = 60;
          job.totalFrames = 60;
          await onProgress(job);
          setPerformance(job);
        },
      },
    );

    const result = await executor.execute(
      request({
        onProgress(update) {
          progress.push(update);
        },
      }),
    );

    expect(progress).toEqual([
      { progress: 1, stage: 'capturing', framesRendered: 60, totalFrames: 60 },
    ]);
    expect(result).toEqual({
      status: 'succeeded',
      performance: {
        totalElapsedMs: 1_200,
        stages: { compileMs: 100, captureMs: 900, encodeMs: 200 },
        workers: 2,
        totalFrames: 60,
        captureMode: 'beginframe',
      },
      metrics: {
        resourceProfile: 'standard',
        capturePolicy: 'prefer-beginframe',
        requestedCaptureMode: 'beginframe',
        actualCaptureMode: 'beginframe',
        requestedWorkers: 1,
        actualWorkers: 2,
        versions: runtimeVersions,
      },
    });
  });

  it('classifies a user abort as cancellation', async () => {
    const abort = new AbortController();
    const executor = new InProcessExecutor(
      {},
      {
        createJob(options) {
          return createRenderJob(options);
        },
        async executeJob(_job, _projectDir, _outputPath, _onProgress, signal) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
          throw new RenderCancelledError('cancelled', 'aborted');
        },
      },
    );

    const execution = executor.execute(request({ signal: abort.signal }));
    abort.abort();

    await expect(execution).resolves.toMatchObject({
      status: 'cancelled',
      failure: { code: 'cancelled', message: 'cancelled' },
    });
  });

  it('preserves the first user-cancellation cause when producer shutdown crosses the deadline', async () => {
    const abort = new AbortController();
    const executor = new InProcessExecutor(
      {},
      {
        createJob(options) {
          return createRenderJob(options);
        },
        async executeJob(_job, _projectDir, _outputPath, _onProgress, signal) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new RenderCancelledError('cancelled after cleanup', 'aborted');
        },
      },
    );

    const execution = executor.execute(request({ signal: abort.signal, deadlineMs: 5 }));
    abort.abort();

    await expect(execution).resolves.toMatchObject({
      status: 'cancelled',
      failure: { code: 'cancelled', message: 'cancelled after cleanup' },
    });
  });

  it('enforces the deadline and classifies it independently from cancellation', async () => {
    const executor = new InProcessExecutor(
      {},
      {
        createJob(options) {
          return createRenderJob(options);
        },
        async executeJob(_job, _projectDir, _outputPath, _onProgress, signal) {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
          throw new RenderCancelledError('deadline', 'aborted');
        },
      },
    );

    await expect(executor.execute(request({ deadlineMs: 1 }))).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'deadline_exceeded', message: 'Render exceeded the deadline' },
    });
  });

  it('classifies a required capture-mode mismatch without leaking producer status', async () => {
    const executor = new InProcessExecutor(
      { requireBeginFrame: true },
      {
        createJob(options) {
          return createRenderJob(options);
        },
        async executeJob(job) {
          setPerformance(job, 'screenshot');
        },
      },
    );

    const result = await executor.execute(request());
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.failure.code).toBe('unsupported_capture_mode');
      expect(result.failure.message).toMatch(/beginFrame/i);
    }
  });

  it('accepts a screenshot fallback under the default prefer-beginframe policy', async () => {
    const executor = new InProcessExecutor(
      { runtimeVersions },
      {
        createJob(options) {
          return createRenderJob(options);
        },
        async executeJob(job) {
          setPerformance(job, 'screenshot');
        },
      },
    );

    await expect(executor.execute(request())).resolves.toMatchObject({
      status: 'succeeded',
      metrics: {
        resourceProfile: 'standard',
        capturePolicy: 'prefer-beginframe',
        requestedCaptureMode: 'beginframe',
        actualCaptureMode: 'screenshot',
      },
    });
  });

  it('does not treat request observability as actual mode on hard failure', async () => {
    const executor = new InProcessExecutor(
      { requireBeginFrame: true, runtimeVersions },
      {
        createJob(options) {
          return createRenderJob(options);
        },
        async executeJob(job) {
          job.errorDetails = {
            message: 'Target closed',
            elapsedMs: 1_000,
            freeMemoryMB: 1_024,
            observability: {
              events: [],
              eventCount: 1,
              browserDiagnostics: {
                total: 0,
                errors: 0,
                pageErrors: 0,
                requestFailed: 0,
                httpErrors: 0,
                navigationStarts: 0,
                navigationFailures: 0,
                consoleErrors: 0,
                consoleWarnings: 0,
              },
              capture: { forceScreenshot: false, captureMode: 'beginframe', workerCount: 1 },
            },
          };
          throw new Error('Target closed');
        },
      },
    );

    const result = await executor.execute(request());
    expect(result.status).toBe('failed');
    expect(result.metrics?.actualCaptureMode).toBe('unknown');
    if (result.status === 'failed') expect(result.failure.code).toBe('execution_failed');
  });

  it('rejects a confirmed screenshot capture on the failure path', async () => {
    const executor = new InProcessExecutor(
      { requireBeginFrame: true, runtimeVersions },
      {
        createJob(options) {
          return createRenderJob(options);
        },
        async executeJob(job) {
          job.errorDetails = {
            message: 'Target closed',
            elapsedMs: 1_000,
            freeMemoryMB: 1_024,
            observability: {
              events: [
                {
                  phase: 'capture_hdr_layered',
                  status: 'error',
                  elapsedMs: 1_000,
                  data: { forceScreenshot: true, captureMode: 'beginframe', workerCount: 1 },
                },
              ],
              eventCount: 1,
              browserDiagnostics: {
                total: 0,
                errors: 0,
                pageErrors: 0,
                requestFailed: 0,
                httpErrors: 0,
                navigationStarts: 0,
                navigationFailures: 0,
                consoleErrors: 0,
                consoleWarnings: 0,
              },
              capture: { forceScreenshot: true, captureMode: 'screenshot', workerCount: 1 },
            },
          };
          throw new Error('Target closed');
        },
      },
    );

    const result = await executor.execute(request());
    expect(result.status).toBe('failed');
    expect(result.metrics?.actualCaptureMode).toBe('screenshot');
    if (result.status === 'failed') expect(result.failure.code).toBe('unsupported_capture_mode');
  });
});
