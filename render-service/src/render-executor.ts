/**
 * RenderExecutor — the stable seam between render lifecycle policy and a
 * concrete rendering engine. Callers provide cancellation, a deadline, and a
 * progress sink; adapters return domain results and performance data without
 * leaking engine-specific job or error types.
 */
import {
  createRenderJob,
  executeRenderJob,
  RenderCancelledError,
  type RenderConfigInput,
  type RenderJob,
  type RenderPerfSummary,
} from '@hyperframes/producer';
import { config } from './config.js';
import type {
  RenderExecutionRequest,
  RenderExecutionResult,
  RenderOptions,
  RenderPerformanceSummary,
} from './types.js';

export interface RenderExecutor {
  execute(request: RenderExecutionRequest): Promise<RenderExecutionResult>;
}

interface ProducerBridge {
  createJob(options: RenderConfigInput): RenderJob;
  executeJob(
    job: RenderJob,
    projectDir: string,
    outputPath: string,
    onProgress: (job: RenderJob) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
}

const producerBridge: ProducerBridge = {
  createJob: createRenderJob,
  executeJob: executeRenderJob,
};

export interface InProcessExecutorOptions {
  workers?: number;
  requireBeginFrame?: boolean;
}

/** Build the engine-specific config entirely inside the production adapter. */
export function buildProducerJobConfig(
  options: RenderOptions,
  workers = config.producerWorkers,
): RenderConfigInput {
  const producerOptions: RenderConfigInput = {
    fps: options.fps,
    quality: options.quality,
    format: options.format,
  };
  if (workers !== undefined) producerOptions.workers = workers;
  return producerOptions;
}

function performanceSummary(
  summary: RenderPerfSummary | undefined,
): RenderPerformanceSummary | undefined {
  if (!summary) return undefined;
  return {
    totalElapsedMs: summary.totalElapsedMs,
    stages: { ...summary.stages },
    workers: summary.workers,
    totalFrames: summary.totalFrames,
    ...(summary.drawElement?.mode ? { captureMode: summary.drawElement.mode } : {}),
    ...(summary.peakRssMb !== undefined ? { peakRssMb: summary.peakRssMb } : {}),
    ...(summary.tmpPeakBytes !== undefined ? { tmpPeakBytes: summary.tmpPeakBytes } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** In-process adapter around the current HyperFrames producer. */
export class InProcessExecutor implements RenderExecutor {
  private readonly workers: number | undefined;
  private readonly requireBeginFrame: boolean;

  constructor(
    options: InProcessExecutorOptions = {},
    private readonly producer: ProducerBridge = producerBridge,
  ) {
    this.workers = options.workers ?? config.producerWorkers;
    this.requireBeginFrame = options.requireBeginFrame ?? config.requireBeginFrame;
  }

  async execute(request: RenderExecutionRequest): Promise<RenderExecutionResult> {
    if (request.signal.aborted) {
      return {
        status: 'cancelled',
        failure: { code: 'cancelled', message: 'Render cancelled' },
      };
    }

    const abort = new AbortController();
    let abortCause: 'cancelled' | 'deadline' | null = null;
    const cancel = () => {
      if (abortCause !== null) return;
      abortCause = 'cancelled';
      abort.abort();
    };
    request.signal.addEventListener('abort', cancel, { once: true });

    const deadline = setTimeout(
      () => {
        if (abortCause !== null) return;
        abortCause = 'deadline';
        abort.abort();
      },
      Math.max(0, request.deadlineMs),
    );
    deadline.unref?.();

    let job: RenderJob | undefined;
    try {
      job = this.producer.createJob(buildProducerJobConfig(request.options, this.workers));
      await this.producer.executeJob(
        job,
        request.projectDir,
        request.outputPath,
        async (current) => {
          const progress =
            typeof current.progress === 'number'
              ? Math.max(0, Math.min(1, current.progress / 100))
              : 0;
          await request.onProgress({
            progress,
            stage: current.currentStage || current.status,
            ...(typeof current.framesRendered === 'number'
              ? { framesRendered: current.framesRendered }
              : {}),
            ...(typeof current.totalFrames === 'number'
              ? { totalFrames: current.totalFrames }
              : {}),
          });
        },
        abort.signal,
      );

      const performance = performanceSummary(job.perfSummary);
      if (abortCause === 'deadline') {
        return {
          status: 'failed',
          failure: { code: 'deadline_exceeded', message: 'Render exceeded the deadline' },
          ...(performance ? { performance } : {}),
        };
      }
      if (abortCause === 'cancelled') {
        return {
          status: 'cancelled',
          failure: { code: 'cancelled', message: 'Render cancelled' },
          ...(performance ? { performance } : {}),
        };
      }

      const captureMode = performance?.captureMode;
      if (this.requireBeginFrame && captureMode !== 'beginframe') {
        return {
          status: 'failed',
          failure: {
            code: 'unsupported_capture_mode',
            message:
              `Producer did not resolve beginFrame capture (actual=${captureMode ?? 'unknown'}). ` +
              'Check PRODUCER_HEADLESS_SHELL_PATH and Chromium compatibility.',
          },
          ...(performance ? { performance } : {}),
        };
      }

      return { status: 'succeeded', ...(performance ? { performance } : {}) };
    } catch (error) {
      const performance = performanceSummary(job?.perfSummary);
      if (
        abortCause === 'deadline' ||
        (abortCause === null && error instanceof RenderCancelledError && error.reason === 'timeout')
      ) {
        return {
          status: 'failed',
          failure: { code: 'deadline_exceeded', message: 'Render exceeded the deadline' },
          ...(performance ? { performance } : {}),
        };
      }
      if (abortCause === 'cancelled') {
        return {
          status: 'cancelled',
          failure: { code: 'cancelled', message: message(error) },
          ...(performance ? { performance } : {}),
        };
      }
      return {
        status: 'failed',
        failure: { code: 'execution_failed', message: message(error) },
        ...(performance ? { performance } : {}),
      };
    } finally {
      clearTimeout(deadline);
      request.signal.removeEventListener('abort', cancel);
    }
  }
}
