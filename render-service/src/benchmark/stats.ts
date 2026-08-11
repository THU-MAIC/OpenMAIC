import type { BenchmarkRun, CaseSummary, MetricDistribution } from './types.js';

export function percentile(values: readonly number[], fraction: number): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) throw new Error('Cannot calculate a percentile of an empty sample');
  if (fraction < 0 || fraction > 1) throw new Error('Percentile fraction must be between 0 and 1');
  const index = Math.max(0, Math.ceil(fraction * finite.length) - 1);
  return finite[index];
}

export function distribution(values: readonly number[]): MetricDistribution {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) throw new Error('Cannot summarize an empty sample');
  return {
    count: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    min: Math.min(...finite),
    max: Math.max(...finite),
  };
}

function addMetric(target: Map<string, number[]>, name: string, value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value)) return;
  const values = target.get(name) ?? [];
  values.push(value);
  target.set(name, values);
}

export function summarizeRuns(runs: readonly BenchmarkRun[]): CaseSummary[] {
  const grouped = new Map<string, BenchmarkRun[]>();
  for (const run of runs) {
    const caseRuns = grouped.get(run.caseId) ?? [];
    caseRuns.push(run);
    grouped.set(run.caseId, caseRuns);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([caseId, caseRuns]) => {
      const succeeded = caseRuns.filter((run) => run.status === 'succeeded');
      const metricValues = new Map<string, number[]>();
      for (const run of succeeded) {
        addMetric(metricValues, 'wallTimeMs', run.metrics.wallTimeMs);
        addMetric(metricValues, 'cpuSeconds', run.metrics.resources.cpuSeconds);
        addMetric(metricValues, 'cpuPeakPercent', run.metrics.resources.cpuPeakPercent);
        addMetric(metricValues, 'peakRssBytes', run.metrics.resources.peakRssBytes);
        addMetric(
          metricValues,
          'temporaryDiskPeakBytes',
          run.metrics.resources.temporaryDiskPeakBytes,
        );
        addMetric(metricValues, 'outputSizeBytes', run.metrics.probe?.outputSizeBytes);
        addMetric(metricValues, 'avDriftSeconds', run.metrics.probe?.avDriftSeconds ?? undefined);
        for (const [stage, value] of Object.entries(run.metrics.stages)) {
          addMetric(metricValues, `stage.${stage}`, value);
        }
      }
      return {
        caseId,
        attempted: caseRuns.length,
        succeeded: succeeded.length,
        failed: caseRuns.length - succeeded.length,
        metrics: Object.fromEntries(
          [...metricValues.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, values]) => [name, distribution(values)]),
        ),
      };
    });
}
