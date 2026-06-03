import type { CodeLine } from '@/lib/types/slides';
import type { WbEditCodeAction } from '@/lib/types/action';

/**
 * Apply a line-level edit (insert / delete / replace) to a code block's lines.
 *
 * Pure and side-effect free: returns the new lines array, or `null` when the
 * operation is a no-op (target line not found, or no line IDs supplied) so the
 * caller can skip the re-render — mirroring the original early-return behaviour.
 *
 * `newLineIds` supplies IDs for inserted lines (the caller pre-generates them).
 */
export function applyCodeLineEdit(
  inputLines: CodeLine[],
  action: WbEditCodeAction,
  newLineIds: string[],
): CodeLine[] | null {
  let lines: CodeLine[] = [...inputLines];
  const newContentLines = action.content ? action.content.split('\n') : [];

  switch (action.operation) {
    case 'insert_after': {
      const idx = lines.findIndex((l) => l.id === action.lineId);
      if (idx === -1) return null;
      const newLines = newContentLines.map((content, i) => ({ id: newLineIds[i], content }));
      lines.splice(idx + 1, 0, ...newLines);
      return lines;
    }
    case 'insert_before': {
      const idx = lines.findIndex((l) => l.id === action.lineId);
      if (idx === -1) return null;
      const newLines = newContentLines.map((content, i) => ({ id: newLineIds[i], content }));
      lines.splice(idx, 0, ...newLines);
      return lines;
    }
    case 'delete_lines': {
      if (!action.lineIds?.length) return null;
      const deleteSet = new Set(action.lineIds);
      return lines.filter((l) => !deleteSet.has(l.id));
    }
    case 'replace_lines': {
      if (!action.lineIds?.length) return null;
      const replaceIds = action.lineIds;
      // Anchor the insertion at the *topmost* (lowest original index) replaced
      // line, not at `replaceIds[0]`. `lineIds` can arrive out of document order,
      // and the filter below removes every replaced line, so an index taken from
      // `replaceIds[0]` may be left stale and place the replacement at the wrong
      // spot (e.g. lineIds ["L5","L2"] inserted at L5's now-shifted index).
      const replaceIndexes = replaceIds
        .map((id) => lines.findIndex((l) => l.id === id))
        .filter((i) => i !== -1);
      if (replaceIndexes.length === 0) return null;
      const firstIdx = Math.min(...replaceIndexes);
      const deleteSet = new Set(replaceIds);
      lines = lines.filter((l) => !deleteSet.has(l.id));
      const newLines = newContentLines.map((content, i) => ({
        id: i < replaceIds.length ? replaceIds[i] : newLineIds[i],
        content,
      }));
      lines.splice(firstIdx, 0, ...newLines);
      return lines;
    }
    default:
      return lines;
  }
}
