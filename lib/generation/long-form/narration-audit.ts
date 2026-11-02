/**
 * What the narration itself can be checked for without a model.
 *
 * The outline audit runs before any page is written, so it can only see titles,
 * descriptions and budgets. Everything a learner actually hears is decided later,
 * and until now nothing looked at it: a page that came back 17% short was written
 * to disk, and a page that re-explained what page 4 already defined read exactly
 * like a page that did not.
 *
 * These three checks are the ones arithmetic can settle. Judgement — whether a
 * derivation is honest, whether a case is well chosen — belongs to the critic,
 * which reads the same numbers so it does not have to spend its reading on them.
 */

export type NarrationCode = 'short-page' | 'repeated-content' | 'no-derivation';

export interface NarrationDefect {
  code: NarrationCode;
  pageIndex: number;
  detail: string;
}

export interface NarrationAudit {
  pages: number;
  totalChars: number;
  /** Causal connectives per 100 characters, across the whole course. */
  derivationDensity: number;
  /** Pages whose narration is under this fraction of its budget are short. */
  defects: NarrationDefect[];
  summary: string;
}

/** Under this fraction of the page's speech budget, the page is short. */
const SHORT_PAGE_RATIO = 0.7;

/**
 * A page this long with no causal connective at all is asserting, not deriving.
 *
 * Below it the page is a transition, a question, or a single claim — none of
 * which owes an argument. Above it, a lecture page that never says why is the
 * exact failure the long-form contract names.
 */
const DERIVATION_FLOOR_CHARS = 300;

/**
 * How many characters must match before a repeat counts.
 *
 * Twelve is long enough that ordinary phrasing does not collide and short enough
 * that a re-used explanation does. Shorter windows flag every course that talks
 * about the same receptor twice.
 */
const REPEAT_WINDOW = 12;

const CONNECTIVES = [
  '因为',
  '所以',
  '因此',
  '于是',
  '从而',
  '可见',
  '由此',
  '既然',
  '导致',
  '推出',
  '意味着',
  '换句话说',
  '也就是说',
  '正因',
  'because',
  'therefore',
  'hence',
  'thus',
  'since',
  'consequently',
  'which means',
  'so that',
];

/** Letters and digits only: punctuation and spacing must not hide a repeat. */
function normalize(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, '');
}

function countConnectives(text: string): number {
  const lower = text.toLowerCase();
  let total = 0;
  for (const word of CONNECTIVES) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at === -1) break;
      total += 1;
      from = at + word.length;
    }
  }
  return total;
}

/**
 * Page index where each window first appeared, so a repeat can name its source.
 */
function firstAppearances(speeches: readonly string[]): Map<string, number> {
  const seen = new Map<string, number>();
  speeches.forEach((speech, position) => {
    const text = normalize(speech);
    for (let start = 0; start + REPEAT_WINDOW <= text.length; start += 4) {
      const window = text.slice(start, start + REPEAT_WINDOW);
      if (!seen.has(window)) seen.set(window, position + 1);
    }
  });
  return seen;
}

/**
 * `budgets` is the speech budget for each page, in characters. It comes from the
 * plan in the pipeline and from the fixture when auditing a finished course, so
 * this takes the numbers rather than the plan.
 */
export function auditNarration(
  speeches: readonly string[],
  budgets: readonly number[],
): NarrationAudit {
  const defects: NarrationDefect[] = [];
  let totalChars = 0;
  let totalConnectives = 0;

  speeches.forEach((speech, position) => {
    const pageIndex = position + 1;
    const chars = normalize(speech).length;
    totalChars += chars;
    totalConnectives += countConnectives(speech);

    const budget = budgets[position];
    if (budget && chars < budget * SHORT_PAGE_RATIO) {
      defects.push({
        code: 'short-page',
        pageIndex,
        detail: `${chars} characters against a ${budget} budget (${Math.round(
          (chars / budget) * 100,
        )}%)`,
      });
    }

    if (chars >= DERIVATION_FLOOR_CHARS && countConnectives(speech) === 0) {
      defects.push({
        code: 'no-derivation',
        pageIndex,
        detail: `${chars} characters with no causal connective — the page states, it does not derive`,
      });
    }
  });

  // A repeat is reported on the later page and names the earlier one, because the
  // later page is the one that has to change.
  const first = firstAppearances(speeches);
  speeches.forEach((speech, position) => {
    const pageIndex = position + 1;
    const text = normalize(speech);
    for (let start = 0; start + REPEAT_WINDOW <= text.length; start += 4) {
      const window = text.slice(start, start + REPEAT_WINDOW);
      const origin = first.get(window);
      if (origin !== undefined && origin < pageIndex) {
        defects.push({
          code: 'repeated-content',
          pageIndex,
          detail: `repeats a passage already spoken on page ${origin}: 「${window}」`,
        });
        return;
      }
    }
  });

  const derivationDensity = totalChars === 0 ? 0 : (totalConnectives / totalChars) * 100;
  const lines = [
    `Narration: ${speeches.length} pages, ${totalChars} characters, ` +
      `${derivationDensity.toFixed(2)} causal connectives per 100 characters.`,
  ];
  if (defects.length === 0) {
    lines.push('No arithmetic defect in the narration.');
  } else {
    for (const defect of defects) {
      lines.push(`- page ${defect.pageIndex}: ${defect.code} — ${defect.detail}`);
    }
  }

  return {
    pages: speeches.length,
    totalChars,
    derivationDensity,
    defects,
    summary: lines.join('\n'),
  };
}

/** True when nothing in the narration is worth a rewrite. */
export function narrationIsClean(audit: NarrationAudit): boolean {
  return audit.defects.length === 0;
}
