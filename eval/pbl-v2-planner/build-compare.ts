/**
 * Build (or rebuild) `compare.html` for a harness run directory.
 *
 * Usage:
 *   # explicit run dir
 *   pnpm tsx eval/pbl-v2-planner/build-compare.ts eval/pbl-v2-planner/results/<model>/<ts>
 *   # latest run under results/ (auto-pick)
 *   pnpm tsx eval/pbl-v2-planner/build-compare.ts
 *
 * Then open the printed compare.html path in a browser.
 */
import { readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { buildCompareHtml } from './compare-html';

function here(): string {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

/** Find the most recently modified run dir (the leaf containing projects/). */
function latestRunDir(): string | undefined {
  const resultsRoot = join(here(), 'results');
  if (!existsSync(resultsRoot)) return undefined;
  let best: { dir: string; mtime: number } | undefined;
  for (const model of readdirSync(resultsRoot)) {
    const modelDir = join(resultsRoot, model);
    if (!statSync(modelDir).isDirectory()) continue;
    for (const ts of readdirSync(modelDir)) {
      const dir = join(modelDir, ts);
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, 'projects'))) continue;
      const mtime = statSync(dir).mtimeMs;
      if (!best || mtime > best.mtime) best = { dir, mtime };
    }
  }
  return best?.dir;
}

function main(): void {
  const arg = process.argv[2];
  const runDir = arg || latestRunDir();
  if (!runDir) {
    console.error('No run dir given and none found under results/. Run the harness first.');
    process.exit(1);
  }
  if (!existsSync(join(runDir, 'projects'))) {
    console.error(`"${runDir}" has no projects/ subdir — not a harness run dir.`);
    process.exit(1);
  }
  const out = buildCompareHtml(runDir);
  console.log(`Wrote ${out}`);
  console.log(`Open it: file://${out}`);
}

main();
