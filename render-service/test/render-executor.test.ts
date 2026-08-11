import { createRenderJob, RenderCancelledError } from '@hyperframes/producer';
import { describe, expect, it } from 'vitest';
import { InProcessExecutor } from '../src/render-executor.js';
import type { RenderExecutionRequest } from '../src/types.js';

const options = { fps: 30, quality: 'standard', format: 'mp4' } as const;

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
  it('normalizes progress and maps producer performance into domain data', async () => {
    const progress = [];
    const executor = new InProcessExecutor(
      { workers: 2, requireBeginFrame: true },
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

    await expect(execution).resolves.toEqual({
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

    await expect(execution).resolves.toEqual({
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

    await expect(executor.execute(request({ deadlineMs: 1 }))).resolves.toEqual({
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
});
