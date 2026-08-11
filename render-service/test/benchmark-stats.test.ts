import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../src/benchmark/failure.js';
import { distribution, percentile, summarizeRuns } from '../src/benchmark/stats.js';
import type { BenchmarkRun } from '../src/benchmark/types.js';

function run(caseId: string, wallTimeMs: number, status: BenchmarkRun['status']): BenchmarkRun {
  return {
    schemaVersion: 1,
    runId: `${caseId}-${wallTimeMs}`,
    caseId,
    iteration: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    status,
    failureClassification: status === 'succeeded' ? null : 'unknown',
    error: null,
    input: {
      corpusVersion: '1',
      inputManifestSha256: 'a',
      projectHashSha256: 'b',
      archiveHashSha256: 'c',
    },
    render: {
      fps: 30,
      quality: 'standard',
      requestedWorkers: 1,
      actualWorkers: 1,
      actualCaptureMode: 'beginframe',
      resolution: { width: 1920, height: 1080 },
      frameCount: 60,
    },
    metrics: {
      wallTimeMs,
      stages: { captureMs: wallTimeMs / 2 },
      resources: {
        scope: 'cgroup-v2',
        cpuSeconds: wallTimeMs / 100,
        cpuPeakPercent: 150,
        peakRssBytes: 1000,
        temporaryDiskPeakBytes: 2000,
      },
      probe:
        status === 'succeeded'
          ? {
              formatDurationSeconds: 2,
              videoDurationSeconds: 2,
              audioDurationSeconds: 2,
              avDriftSeconds: 0,
              frameCount: 60,
              outputSizeBytes: 3000,
            }
          : null,
    },
    representativeFrames: [],
    producerPerfSummary: null,
  };
}

describe('benchmark statistics', () => {
  it('uses the nearest-rank definition for P50 and P95', () => {
    const values = [1, 2, 3, 4, 100];
    expect(percentile(values, 0.5)).toBe(3);
    expect(percentile(values, 0.95)).toBe(100);
    expect(distribution(values)).toEqual({ count: 5, p50: 3, p95: 100, min: 1, max: 100 });
  });

  it('summarizes only successful runs while retaining attempt counts', () => {
    const [summary] = summarizeRuns([
      run('static', 100, 'succeeded'),
      run('static', 200, 'failed'),
      run('static', 300, 'succeeded'),
    ]);
    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.metrics.wallTimeMs).toMatchObject({ count: 2, p50: 100, p95: 300 });
    expect(summary.metrics['stage.captureMs']).toMatchObject({ p50: 50, p95: 150 });
  });
});

describe('failure classification', () => {
  it('prioritizes timeouts and maps producer stages', () => {
    expect(classifyFailure({ timedOut: true, failedStage: 'capture' })).toBe('timeout');
    expect(classifyFailure({ timedOut: false, failedStage: 'audio' })).toBe('audio');
    expect(classifyFailure({ timedOut: false, error: 'ffprobe duration mismatch' })).toBe(
      'validation',
    );
  });
});
