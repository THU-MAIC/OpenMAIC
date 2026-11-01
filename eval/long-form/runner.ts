/**
 * Run the long-form calibration against one or more real decks.
 *
 * Usage:
 *   npx tsx eval/long-form/runner.ts                      # every scenario
 *   npx tsx eval/long-form/runner.ts ch18-analgesics      # one scenario
 *   npx tsx eval/long-form/runner.ts --no-write           # print only
 *
 * No model calls: this compares the planner's arithmetic against a human's
 * minutes, so it runs in a second and can gate every prompt change.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { calibrate } from './metrics/calibration';
import { renderReport } from './reporter';
import type { CalibrationReport, DeckFixture } from './types';

const SCENARIO_DIR = join(process.cwd(), 'eval', 'long-form', 'scenarios');
const REPORT_DIR = join(process.cwd(), 'eval', 'long-form', 'reports');

function listScenarios(only?: string): string[] {
  const names = readdirSync(SCENARIO_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
  if (!only) return names;
  if (!names.includes(only)) {
    throw new Error(`unknown scenario ${JSON.stringify(only)}; have: ${names.join(', ')}`);
  }
  return [only];
}

function pad(value: string, width: number): string {
  // CJK characters occupy two columns in a terminal; count them as two so the
  // comparison table lines up.
  const displayWidth = [...value].reduce(
    (acc, char) => acc + (char.codePointAt(0)! > 0x2e80 ? 2 : 1),
    0,
  );
  return value + ' '.repeat(Math.max(0, width - displayWidth));
}

const VERDICT_MARK: Record<string, string> = { match: 'OK', adjust: 'ADJUST', info: 'INFO' };

function printReport(report: CalibrationReport): void {
  console.log(`\n=== ${report.title} (${report.fixture}) ===`);
  console.log(
    `${report.deck.pages} 页 / ${report.deck.minutes} 分钟 · ${report.deck.pagesPerMinute.toFixed(2)} 页/分钟 · ${report.deck.multiPageUnits} 个多页单元\n`,
  );

  console.log(pad('指标', 22) + pad('真人', 10) + pad('模型', 10) + pad('判定', 10) + '说明');
  console.log('-'.repeat(96));
  for (const row of report.rows) {
    console.log(
      pad(row.label, 22) +
        pad(String(Number.isInteger(row.human) ? row.human : row.human.toFixed(2)), 10) +
        pad(String(Number.isInteger(row.model) ? row.model : row.model.toFixed(2)), 10) +
        pad(VERDICT_MARK[row.verdict], 10) +
        row.note,
    );
  }

  console.log('\n结构维度：');
  for (const item of report.structuralScores) {
    console.log(`  ${item.dimension}: ${item.score}/5 — ${item.reason}`);
  }

  console.log('\n结论：');
  for (const finding of report.findings) console.log(`  · ${finding}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const write = !args.includes('--no-write');
  const only = args.find((arg) => !arg.startsWith('--'));

  const scenarios = listScenarios(only);
  if (scenarios.length === 0) {
    console.error(`no scenarios in ${SCENARIO_DIR}; run scripts/long-form/parse-deck.mjs first`);
    process.exit(1);
  }

  if (write) mkdirSync(REPORT_DIR, { recursive: true });

  for (const name of scenarios) {
    const path = join(SCENARIO_DIR, `${name}.json`);
    const fixture = JSON.parse(readFileSync(path, 'utf-8')) as DeckFixture;
    const report = calibrate(fixture, name);
    printReport(report);

    if (write) {
      const outPath = join(REPORT_DIR, `${name}.md`);
      writeFileSync(outPath, `${renderReport(report)}\n`, 'utf-8');
      console.log(`\n报告已写入 ${outPath}`);
    }
  }
}

main();
