import { writeFileSync } from 'fs';
import { join } from 'path';
import { renderHeader, renderSummaryTable } from '../shared/markdown-report';
import type { EvalResult } from './types';

export interface ReportContext {
  inferenceModel: string;
  judgeModel: string;
}

/**
 * Write `report.md` into `runDir`. Returns the absolute path of the written file.
 *
 * Structure mirrors the old `outline-language.eval.result.md`:
 *   1. Header (date, models, pass count)
 *   2. One detail block per case (PASS / **FAIL**)
 *   3. Summary table of all cases
 */
export function writeReport(runDir: string, results: EvalResult[], ctx: ReportContext): string {
  const passed = results.filter((r) => r.judgePassed).length;
  const total = results.length;
  const pct = total === 0 ? 0 : Math.round((passed / total) * 100);

  const lines: string[] = [];
  lines.push(
    ...renderHeader({
      title: 'Outline Language Inference Eval Results',
      timestamp: new Date().toISOString(),
      model: ctx.inferenceModel,
      judgeModel: ctx.judgeModel,
      extra: {
        Passed: `${passed}/${total} (${pct}%)`,
        Method: 'real outline generation (generateSceneOutlinesFromRequirements) + LLM-as-judge',
      },
    }),
  );

  lines.push(`## Detail`, ``);
  for (const r of results) {
    const icon = r.judgePassed ? 'PASS' : '**FAIL**';
    lines.push(`### ${icon} ${r.case_id}`, ``);
    lines.push(`- **Category**: ${r.category}`);
    lines.push(`- **Input**: \`${r.requirement}\``);
    if (r.pdfTextSample) {
      lines.push(`- **PDF sample**: \`${r.pdfTextSample.slice(0, 80)}...\``);
    }
    lines.push(`- **Ground truth**: ${r.groundTruth}`);
    lines.push(`- **Directive**: ${r.directive}`);
    lines.push(`- **Outlines generated**: ${r.outlinesCount}`);
    lines.push(`- **Judge**: ${r.judgePassed ? 'PASS' : 'FAIL'} — ${r.judgeReason}`);
    lines.push(``);
  }

  lines.push(`## Summary`, ``);
  const rows: string[][] = results.map((r, i) => [
    String(i + 1),
    r.case_id,
    r.category,
    String(r.outlinesCount),
    r.judgePassed ? 'PASS' : 'FAIL',
    r.judgeReason,
  ]);
  lines.push(
    ...renderSummaryTable(['#', 'Case', 'Category', 'Outlines', 'Result', 'Judge reason'], rows),
  );

  const outPath = join(runDir, 'report.md');
  writeFileSync(outPath, lines.join('\n'), 'utf-8');
  return outPath;
}
