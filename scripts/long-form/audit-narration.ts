/**
 * Audit the narration of a finished course.
 *
 * The pipeline checks the outline before any page exists; this checks what was
 * actually written, from a saved course file. It is the same three checks the
 * narration stage runs (`auditNarration`), pointed at a fixture so a run can be
 * inspected after the fact.
 *
 * Usage:
 *   npx tsx --conditions=import scripts/long-form/audit-narration.ts <pages.json> [plan.json]
 *
 * `pages.json` is `{ pages: { p01: { narration, chars } } }` or an array of
 * `{ narration }`. With `plan.json` the per-page `targetChars` becomes the budget;
 * without it the median page length does, so only repeats and underivable pages
 * are reported.
 */
import { readFileSync } from 'node:fs';

import { auditNarration } from '@/lib/generation/long-form';

interface Page {
  index?: number;
  narration?: string;
  chars?: number;
}

function readPages(path: string): Page[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as
    | { pages?: Record<string, Page> }
    | Page[];
  const list = Array.isArray(parsed) ? parsed : Object.values(parsed.pages ?? {});
  return list
    .filter((page) => typeof page.narration === 'string')
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function readBudgets(path: string | undefined, pages: Page[]): number[] {
  if (path) {
    const plan = JSON.parse(readFileSync(path, 'utf8')) as {
      pages?: Array<{ targetChars?: number }>;
    };
    const targets = (plan.pages ?? [])
      .map((page) => page.targetChars ?? 0)
      .filter((value) => value > 0);
    if (targets.length === pages.length) return targets;
    console.warn(
      `plan.json 有 ${targets.length} 页目标，稿件有 ${pages.length} 页，改用中位数作预算`,
    );
  }
  const lengths = pages.map((page) => (page.narration ?? '').length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  return pages.map(() => median);
}

const [pagesPath, planPath] = process.argv.slice(2);
if (!pagesPath) {
  console.error('用法: audit-narration.ts <pages.json> [plan.json]');
  process.exit(2);
}

const pages = readPages(pagesPath);
const speeches = pages.map((page) => page.narration ?? '');
const budgets = readBudgets(planPath, pages);
const audit = auditNarration(speeches, budgets);

console.log(audit.summary);
console.log(
  `\n${audit.defects.length} 处问题 / ${audit.pages} 页 · 平均每页 ${Math.round(
    audit.totalChars / Math.max(1, audit.pages),
  )} 字`,
);
process.exitCode = audit.defects.length > 0 ? 1 : 0;
