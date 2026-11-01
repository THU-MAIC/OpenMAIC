/**
 * What the course has established so far, for the page that comes next.
 *
 * The engine hands a page the previous page's speeches and nothing else
 * (`previousSpeechesFor`). On a fifteen-minute lesson that is enough. On an
 * hour it is the single worst failure mode in the pipeline: page 19 does not
 * know that page 4 defined the term it is about to define again, page 12 does
 * not know that page 2 opened a question the course is supposed to close, and
 * page 30 cannot tell whether the example it is reaching for has already been
 * used three times.
 *
 * A full transcript would not fit and would not help. What helps is one line
 * per page — the title and the claims it established — because that is exactly
 * the resolution at which "have we already said this" is answerable.
 *
 * The text is built from the outline, not from generated narration, so it is
 * deterministic: the same outline always yields the same ledger, and a
 * regenerated page sees the same memory it saw before.
 */

import type { SceneOutline } from '@/lib/types/generation';

export interface LedgerOptions {
  /** Characters the block may spend. */
  charBudget?: number;
  /** Pages kept verbatim from the start — the definitions everything rests on. */
  headPages?: number;
  /** Pages kept verbatim from the end — the thread the next page continues. */
  tailPages?: number;
  /** Characters one page's line may spend. */
  lineBudget?: number;
}

const DEFAULTS: Required<LedgerOptions> = {
  charBudget: 2200,
  headPages: 10,
  tailPages: 12,
  lineBudget: 70,
};

function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1)}…`;
}

/** One page as a single line: what it was about, and what it established. */
function pageLine(scene: SceneOutline, pageIndex: number, lineBudget: number): string {
  const points = (scene.keyPoints ?? []).slice(0, 3).map((point) => truncate(point, 24));
  const claims = points.length > 0 ? ` — ${points.join(' · ')}` : '';
  return truncate(`${pageIndex}. ${scene.title}${claims}`, lineBudget);
}

/**
 * The ledger for the page at `pageIndex` (1-based).
 *
 * Returns an empty string for the first page — there is nothing established
 * yet, and a header with no content is worse than no header.
 */
export function buildLedgerText(
  outlines: readonly SceneOutline[],
  pageIndex: number,
  options: LedgerOptions = {},
): string {
  const { charBudget, headPages, tailPages, lineBudget } = { ...DEFAULTS, ...options };
  const upto = Math.max(0, Math.min(pageIndex - 1, outlines.length));
  if (upto === 0) return '';

  const lines = outlines
    .slice(0, upto)
    .map((scene, position) => pageLine(scene, position + 1, lineBudget));

  let body: string[];
  let elided = 0;

  const total = lines.reduce((acc, line) => acc + line.length + 1, 0);
  if (total <= charBudget) {
    body = lines;
  } else {
    const head = lines.slice(0, Math.min(headPages, lines.length));
    const tail = lines.slice(Math.max(head.length, lines.length - tailPages));
    elided = lines.length - head.length - tail.length;
    body = [...head, ...(elided > 0 ? [`(${elided} pages elided to fit)`] : []), ...tail];
  }

  return [
    `## What the course has already established (pages 1-${upto})`,
    ``,
    ...body,
    ``,
    `Treat these as established. Refer to them as "前面建立的 X" / "what we built earlier"; do not redefine a term that appears above, do not re-run an example that appears above, and do not re-open a question that appears above unless you are closing it.`,
  ].join('\n');
}
