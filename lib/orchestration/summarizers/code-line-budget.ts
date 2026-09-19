// Shared, bounded rendering for whiteboard code-block lines.
//
// Both the request-start state summary (state-context.ts) and the per-round
// virtual whiteboard context (whiteboard-ledger.ts) can carry pre-existing code
// blocks whose line count and id length have no schema cap. Rendering every
// line (even ids-only) would let a code-heavy board grow the child prompt
// without bound. This module is the single source of truth for that cap so the
// two summarizers cannot drift into two different truncation rules.
//
// The budget has two CHARACTER tiers, shared across all code blocks handed the
// same budget object:
//   - content: lines shown with (truncated) content, fully editable.
//   - idList:  remaining lines listed as bare ids (cheaper, still editable).
// Past both tiers, the tail is reported as an omitted count only — bounded and
// no longer individually addressable. Normal code (a few dozen short lines)
// fits entirely and stays fully editable.
export const MAX_LINE_CONTENT_CHARS = 80;
export const MAX_CODE_CONTENT_CHARS = 1200;
export const MAX_CODE_IDLIST_CHARS = 400;

export interface CodeRenderBudget {
  content: number;
  idList: number;
}

export interface CodeLine {
  id: string;
  content: string;
}

export function createCodeRenderBudget(): CodeRenderBudget {
  return { content: MAX_CODE_CONTENT_CHARS, idList: MAX_CODE_IDLIST_CHARS };
}

export function truncateLineContent(content: string): string {
  return content.length > MAX_LINE_CONTENT_CHARS
    ? `${content.slice(0, MAX_LINE_CONTENT_CHARS)}…`
    : content;
}

/**
 * Render code lines against a shared budget, returning the text and the
 * remaining budget so the caller can thread it across multiple code blocks.
 */
export function renderCodeLines(
  codeLines: CodeLine[],
  budget: CodeRenderBudget,
  indent = '     ',
): { text: string; budget: CodeRenderBudget } {
  const out: string[] = [];
  let { content, idList } = budget;
  let i = 0;

  // Tier 1: lines shown with (truncated) content, until the content char budget
  // can no longer fit the next line.
  for (; i < codeLines.length; i += 1) {
    const rendered = `${indent}${codeLines[i].id}: ${truncateLineContent(codeLines[i].content)}`;
    if (rendered.length > content) break;
    out.push(rendered);
    content -= rendered.length;
  }

  // Tier 2: remaining lines listed as bare ids (cheaper, still editable), until
  // the id-list char budget can no longer fit the next id.
  const idOnly: string[] = [];
  for (; i < codeLines.length; i += 1) {
    const piece = idOnly.length === 0 ? codeLines[i].id : `, ${codeLines[i].id}`;
    if (piece.length > idList) break;
    idOnly.push(codeLines[i].id);
    idList -= piece.length;
  }
  if (idOnly.length > 0) {
    out.push(`${indent}(ids only: ${idOnly.join(', ')})`);
  }

  // Anything still unrendered is reported as a count — bounded, not editable.
  const omitted = codeLines.length - i;
  if (omitted > 0) {
    out.push(`${indent}(… ${omitted} more line(s) omitted)`);
  }

  return { text: out.join('\n'), budget: { content, idList } };
}
