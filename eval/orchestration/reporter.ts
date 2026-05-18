import { writeFileSync } from 'fs';
import { join } from 'path';
import { renderHeader, renderSummaryTable } from '../shared/markdown-report';
import type { EvalResult } from './types';

export interface ReportContext {
  inferenceModel: string;
}

export function writeReport(runDir: string, results: EvalResult[], ctx: ReportContext): string {
  const passed = results.filter((r) => r.judgePassed).length;
  const total = results.length;
  const pct = total === 0 ? 0 : Math.round((passed / total) * 100);

  const lines: string[] = [];
  lines.push(
    ...renderHeader({
      title: 'Orchestration Director Eval Results',
      timestamp: new Date().toISOString(),
      model: ctx.inferenceModel,
      extra: {
        Passed: `${passed}/${total} (${pct}%)`,
        Method: 'real director prompt + LLM decision + deterministic judge',
      },
    }),
  );

  lines.push(`## Detail`, ``);
  for (const r of results) {
    const icon = r.judgePassed ? 'PASS' : '**FAIL**';
    lines.push(`### ${icon} ${r.case_id}`, ``);
    lines.push(`- **Category**: ${r.category}`);
    lines.push(`- **Description**: ${r.description}`);
    lines.push(`- **Director output**: \`${r.directorOutput.slice(0, 120)}\``);
    lines.push(`- **shouldEnd**: ${r.shouldEnd}`);
    lines.push(`- **Judge**: ${r.judgePassed ? 'PASS' : 'FAIL'} — ${r.judgeReason}`);
    lines.push(``);
  }

  lines.push(`## Summary`, ``);
  const rows: string[][] = results.map((r, i) => [
    String(i + 1),
    r.case_id,
    r.category,
    String(r.shouldEnd),
    r.judgePassed ? 'PASS' : 'FAIL',
    r.judgeReason,
  ]);
  lines.push(
    ...renderSummaryTable(['#', 'Case', 'Category', 'shouldEnd', 'Result', 'Reason'], rows),
  );

  const outPath = join(runDir, 'report.md');
  writeFileSync(outPath, lines.join('\n'), 'utf-8');
  return outPath;
}
