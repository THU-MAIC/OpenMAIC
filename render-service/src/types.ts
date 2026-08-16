/**
 * Shared types for the render service.
 *
 * The public shape a client sees when polling a job. Deliberately decoupled
 * from `@hyperframes/producer`'s internal `RenderJob` so the HTTP contract
 * (and therefore the app) stays stable if the producer's internals change.
 */
import type {
  CapturePolicy,
  RequestedCaptureMode,
  ResourceProfileName,
} from './resource-profile.js';

/** Lifecycle of a render job as the app observes it. */
export type RenderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** User-facing render options accepted by `POST /render`. */
export interface RenderOptions {
  /** Integer frames per second. */
  fps: number;
  quality: 'draft' | 'standard' | 'high';
  /** Only mp4 is supported in this phase; kept explicit for forward-compat. */
  format: 'mp4';
}

export interface RuntimeVersions {
  service: string;
  producer: string;
  node: string;
  chromium: string;
  chromiumPath: string;
  ffmpeg: string;
  ffmpegPath: string;
  containerImage: string | null;
}

export interface RenderExecutionMetrics {
  resourceProfile: ResourceProfileName;
  capturePolicy: CapturePolicy;
  requestedCaptureMode: RequestedCaptureMode;
  actualCaptureMode: string;
  requestedWorkers: number;
  actualWorkers: number | null;
  versions: RuntimeVersions;
}

/** Progress emitted by any render executor, normalized for service callers. */
export interface RenderProgress {
  /** Fraction complete in the stable 0..1 service range. */
  progress: number;
  stage: string;
  framesRendered?: number;
  totalFrames?: number;
}

/** Executor-independent performance data retained for diagnostics and benchmarks. */
export interface RenderPerformanceSummary {
  totalElapsedMs: number;
  stages: Record<string, number>;
  workers: number;
  totalFrames: number;
  captureMode?: string;
  peakRssMb?: number;
  tmpPeakBytes?: number;
}

/** Stable failure classification produced at the RenderExecutor seam. */
export type RenderFailureCode =
  | 'cancelled'
  | 'deadline_exceeded'
  | 'unsupported_capture_mode'
  | 'execution_failed';

export interface RenderCancelledFailure {
  code: 'cancelled';
  message: string;
}

export interface RenderFailedFailure {
  code: Exclude<RenderFailureCode, 'cancelled'>;
  message: string;
}

export type RenderFailure = RenderCancelledFailure | RenderFailedFailure;

/** Everything an executor needs to run one render without knowing about HTTP jobs. */
export interface RenderExecutionRequest {
  projectDir: string;
  outputPath: string;
  options: RenderOptions;
  /** User or coordinator cancellation. */
  signal: AbortSignal;
  /** Wall-clock budget starting when execution begins. */
  deadlineMs: number;
  onProgress: (progress: RenderProgress) => void | Promise<void>;
}

export type RenderExecutionResult =
  | {
      status: 'succeeded';
      performance?: RenderPerformanceSummary;
      metrics?: RenderExecutionMetrics;
    }
  | {
      status: 'cancelled';
      failure: RenderCancelledFailure;
      performance?: RenderPerformanceSummary;
      metrics?: RenderExecutionMetrics;
    }
  | {
      status: 'failed';
      failure: RenderFailedFailure;
      performance?: RenderPerformanceSummary;
      metrics?: RenderExecutionMetrics;
    };

/**
 * A render job's observable state. `progress` is normalized to 0..1; the HTTP
 * layer surfaces it as-is and the client scales it to a percent.
 */
export interface RenderJobRecord {
  id: string;
  /** Optional caller identity used only for the per-user concurrency guard. */
  userId?: string;
  status: RenderJobStatus;
  progress: number;
  currentStage: string;
  framesRendered?: number;
  totalFrames?: number;
  metrics?: RenderExecutionMetrics;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** Absolute path to the unzipped project dir (for cleanup). */
  projectDir: string;
  /** Absolute path to the rendered MP4 once `succeeded`. */
  outputPath?: string;
  /** Domain failure retained independently from the HTTP-compatible error string. */
  failure?: RenderFailure;
  /** Executor-independent diagnostics for completed or failed attempts. */
  performance?: RenderPerformanceSummary;
}

export function isTerminal(status: RenderJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
