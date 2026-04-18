import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { EvalReport, VlmScore } from './types';

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function formatNum(n: number): string {
  return n.toFixed(1);
}

/**
 * Generate JSON + Markdown reports from eval results.
 */
export function generateReport(
  report: EvalReport,
  outputDir: string,
): { json: string; md: string } {
  mkdirSync(outputDir, { recursive: true });

  // Collect all scores across all checkpoints
  const allScores: VlmScore[] = [];
  for (const scenario of report.scenarios) {
    for (const cp of scenario.checkpoints) {
      if (cp.score) allScores.push(cp.score);
    }
  }

  const dimensions = [
    'readability',
    'overlap',
    'rendering_correctness',
    'content_completeness',
    'layout_logic',
  ] as const;

  // Build summary stats (guard against empty arrays)
  const summary: Record<string, { mean: number; min: number; max: number }> = {};
  if (allScores.length > 0) {
    for (const dim of dimensions) {
      const vals = allScores.map((s) => s[dim]?.score).filter((v): v is number => v != null);
      if (vals.length === 0) continue;
      summary[dim] = {
        mean: mean(vals),
        min: Math.min(...vals),
        max: Math.max(...vals),
      };
    }
    const overallVals = allScores.map((s) => s.overall);
    summary['overall'] = {
      mean: mean(overallVals),
      min: Math.min(...overallVals),
      max: Math.max(...overallVals),
    };
  }

  // Write JSON
  const jsonPath = join(outputDir, 'report.json');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // Build Markdown
  const lines: string[] = [];
  lines.push('# Whiteboard Layout Eval Report');
  lines.push(
    `Run: ${report.timestamp} | Model: ${report.model} | Scenarios: ${report.scenarios.length}`,
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('| Metric | Mean | Min | Max |');
  lines.push('|--------|------|-----|-----|');
  for (const [key, stats] of Object.entries(summary)) {
    lines.push(`| ${key} | ${formatNum(stats.mean)} | ${stats.min} | ${stats.max} |`);
  }
  lines.push('');

  lines.push('## Scenarios');
  for (const scenario of report.scenarios) {
    const lastCp = scenario.checkpoints[scenario.checkpoints.length - 1];
    lines.push(`### ${scenario.scenarioId} (run ${scenario.runIndex + 1})`);
    if (scenario.error) {
      lines.push(`- Error: ${scenario.error}`);
    } else if (lastCp) {
      if (lastCp.score) {
        lines.push(`- Overall: ${lastCp.score.overall}`);
        lines.push(`- Overlap: ${lastCp.score.overlap.score} — ${lastCp.score.overlap.reason}`);
        if (lastCp.score.issues.length > 0) {
          lines.push(`- Issues: ${lastCp.score.issues.join('; ')}`);
        }
      } else {
        lines.push(`- Score: (scoring failed)`);
      }
      lines.push(`- Screenshot: ${lastCp.screenshotPath}`);
    }
    lines.push('');
  }

  const mdPath = join(outputDir, 'report.md');
  writeFileSync(mdPath, lines.join('\n'));

  return { json: jsonPath, md: mdPath };
}
