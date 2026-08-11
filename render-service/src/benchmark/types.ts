import type { RenderPerfSummary } from '@hyperframes/producer';

export const BENCHMARK_SCHEMA_VERSION = 1 as const;

export type BenchmarkCategory =
  | 'static-slides'
  | 'formula-chart-heavy'
  | 'image-heavy'
  | 'video-element-heavy'
  | 'interactive-webgl'
  | 'curated-classroom';

export interface CorpusCase {
  id: string;
  category: BenchmarkCategory;
  description: string;
  durationSeconds: number;
  sceneCount: number;
  complexity: 'low' | 'medium' | 'high';
  expectedAudio: boolean;
  projectDir: string;
  files?: Array<{ source: string; archivePath: string }>;
  inputManifestSha256: string;
  projectHashSha256: string;
  archiveHashSha256: string;
  representativeFrameFractions: number[];
}

export interface CorpusManifest {
  schemaVersion: 1;
  corpusVersion: string;
  description: string;
  sharedFiles: Array<{ source: string; archivePath: string }>;
  cases: CorpusCase[];
}

export type FailureClassification =
  | 'timeout'
  | 'compile'
  | 'video-extract'
  | 'audio'
  | 'capture'
  | 'encode'
  | 'assemble'
  | 'validation'
  | 'unknown';

export interface ResourceMetrics {
  scope: 'cgroup-v2' | 'process';
  cpuSeconds: number;
  cpuPeakPercent: number;
  peakRssBytes: number;
  temporaryDiskPeakBytes: number;
}

export interface ProbeMetrics {
  formatDurationSeconds: number;
  videoDurationSeconds: number;
  audioDurationSeconds: number | null;
  avDriftSeconds: number | null;
  frameCount: number;
  outputSizeBytes: number;
}

export interface RepresentativeFrame {
  fraction: number;
  timestampSeconds: number;
  sha256: string;
  baselineSha256: string | null;
  matchesBaseline: boolean | null;
}

export interface BenchmarkRun {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  iteration: number;
  startedAt: string;
  status: 'succeeded' | 'failed' | 'timeout';
  failureClassification: FailureClassification | null;
  error: string | null;
  input: {
    corpusVersion: string;
    inputManifestSha256: string;
    projectHashSha256: string;
    archiveHashSha256: string;
  };
  render: {
    fps: number;
    quality: 'draft' | 'standard' | 'high';
    requestedWorkers: number | null;
    actualWorkers: number | null;
    actualCaptureMode: string;
    resolution: { width: number; height: number } | null;
    frameCount: number | null;
  };
  metrics: {
    wallTimeMs: number;
    stages: Record<string, number>;
    resources: ResourceMetrics;
    probe: ProbeMetrics | null;
  };
  representativeFrames: RepresentativeFrame[];
  producerPerfSummary: RenderPerfSummary | null;
}

export interface MetricDistribution {
  count: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export interface CaseSummary {
  caseId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  metrics: Record<string, MetricDistribution>;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  benchmarkVersion: string;
  generatedAt: string;
  command: string;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
    producer: string;
    ffmpeg: string;
    ffmpegPath: string;
    ffprobe: string;
    ffprobePath: string;
    chromium: string | null;
    chromiumPath: string | null;
    containerImage: string | null;
  };
  corpus: {
    version: string;
    cases: CorpusCase[];
  };
  runs: BenchmarkRun[];
  summaries: CaseSummary[];
}
