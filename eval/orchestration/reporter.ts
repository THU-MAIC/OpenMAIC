import { writeFileSync } from 'fs';
import { join } from 'path';
import { renderHeader, renderSummaryTable } from '../shared/markdown-report';
import type { EvalReport } from './types';

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function countErrors(samples: { error?: string }[]): number {
  return samples.filter((s) => s.error).length;
}

/**
 * Write `report.md` summarising pre-fix vs post-fix END rates per scenario.
 * Returns the absolute path of the written report.
 */
export function writeReport(runDir: string, report: EvalReport): string {
  const lines: string[] = [];
  lines.push(
    ...renderHeader({
      title: 'Director Premature-END Regression Eval',
      timestamp: new Date().toISOString(),
      model: report.model,
      extra: {
        'Samples per variant': report.samplesPerVariant,
        'Post-fix END threshold (regression guard)': pct(report.postFixEndThreshold),
        'Discrimination threshold (Δ END-rate, informational)': pct(report.thresholdDelta),
        Method:
          'A/B director prompt + summary: post-fix = current main; pre-fix = pre-#554 [User]/[Assistant] summary labels AND system.md without rules 10/11/12',
        'Post-fix regression guard (must hold)': report.allPostFixPass ? 'PASS' : 'FAIL',
        'Any scenario discriminates? (informational)': report.anyDiscriminates ? 'YES' : 'NO',
      },
    }),
  );

  lines.push(`## Detail`, ``);
  for (const r of report.results) {
    const pass = r.postFixPasses ? 'PASS' : '**FAIL**';
    const disc = r.discriminates ? ' (Δ ≥ threshold)' : '';
    lines.push(`### ${pass}${disc} ${r.case_id}`, ``);
    lines.push(`- **Description**: ${r.description}`);
    const preErr = countErrors(r.preFix.samples);
    const postErr = countErrors(r.postFix.samples);
    lines.push(`- **Samples per variant**: ${r.samples} (rates exclude errored samples)`);
    lines.push(
      `- **Pre-fix END rate**: ${pct(r.preFix.endRate)}${preErr ? ` — ${preErr} error(s)` : ''}`,
    );
    lines.push(
      `- **Post-fix END rate**: ${pct(r.postFix.endRate)}${postErr ? ` — ${postErr} error(s)` : ''}`,
    );
    lines.push(`- **Δ (pre − post)**: ${pct(r.delta)}`);
    lines.push(``);
    lines.push(`<details><summary>Pre-fix raw decisions</summary>`, ``);
    for (const s of r.preFix.samples) {
      const label = s.error ? `ERROR: ${s.error}` : s.isEnd ? '**END**' : s.decision;
      lines.push(`- ${label}`);
    }
    lines.push(``, `</details>`, ``);
    lines.push(`<details><summary>Post-fix raw decisions</summary>`, ``);
    for (const s of r.postFix.samples) {
      const label = s.error ? `ERROR: ${s.error}` : s.isEnd ? '**END**' : s.decision;
      lines.push(`- ${label}`);
    }
    lines.push(``, `</details>`, ``);
  }

  lines.push(`## Summary`, ``);
  const rows: string[][] = report.results.map((r, i) => [
    String(i + 1),
    r.case_id,
    pct(r.preFix.endRate),
    pct(r.postFix.endRate),
    pct(r.delta),
    r.postFixPasses ? 'PASS' : 'FAIL',
    r.discriminates ? 'YES' : 'no',
  ]);
  lines.push(
    ...renderSummaryTable(
      ['#', 'Scenario', 'Pre-fix END', 'Post-fix END', 'Δ', 'Regression guard', 'Discriminates'],
      rows,
    ),
  );

  const reportPath = join(runDir, 'report.md');
  writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}
