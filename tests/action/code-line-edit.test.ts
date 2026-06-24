import { describe, it, expect } from 'vitest';
import { applyCodeLineEdit } from '@/lib/action/code-line-edit';
import type { WbEditCodeAction } from '@/lib/types/action';
import type { CodeLine } from '@/lib/types/slides';

const linesOf = (ids: string[]): CodeLine[] => ids.map((id) => ({ id, content: id }));
const edit = (a: Partial<WbEditCodeAction>): WbEditCodeAction =>
  ({ id: 'a1', type: 'wb_edit_code', elementId: 'el', ...a }) as WbEditCodeAction;

describe('applyCodeLineEdit', () => {
  it('replace_lines anchors at the topmost replaced line even when lineIds are out of order', () => {
    // Replace B and D, but supply the IDs OUT of document order (D before B).
    const result = applyCodeLineEdit(
      linesOf(['A', 'B', 'C', 'D', 'E']),
      edit({ operation: 'replace_lines', lineIds: ['D', 'B'], content: 'X' }),
      ['N1'],
    );
    // The replacement lands where B was (topmost), not at D's now-stale index.
    // (Before the fix this produced ['A', 'C', 'E', 'X'].)
    expect(result?.map((l) => l.content)).toEqual(['A', 'X', 'C', 'E']);
  });

  it('replace_lines reuses the replaced IDs for the first new lines', () => {
    const result = applyCodeLineEdit(
      linesOf(['A', 'B', 'C']),
      edit({ operation: 'replace_lines', lineIds: ['B'], content: 'X' }),
      ['N1'],
    );
    expect(result).toEqual([
      { id: 'A', content: 'A' },
      { id: 'B', content: 'X' },
      { id: 'C', content: 'C' },
    ]);
  });

  it('insert_after / insert_before / delete_lines behave as before', () => {
    expect(
      applyCodeLineEdit(
        linesOf(['A', 'B']),
        edit({ operation: 'insert_after', lineId: 'A', content: 'X' }),
        ['N1'],
      )?.map((l) => l.content),
    ).toEqual(['A', 'X', 'B']);
    expect(
      applyCodeLineEdit(
        linesOf(['A', 'B']),
        edit({ operation: 'insert_before', lineId: 'B', content: 'X' }),
        ['N1'],
      )?.map((l) => l.content),
    ).toEqual(['A', 'X', 'B']);
    expect(
      applyCodeLineEdit(
        linesOf(['A', 'B', 'C']),
        edit({ operation: 'delete_lines', lineIds: ['B'] }),
        [],
      )?.map((l) => l.content),
    ).toEqual(['A', 'C']);
  });

  it('returns null for a no-op (target not found / no line IDs)', () => {
    expect(
      applyCodeLineEdit(
        linesOf(['A']),
        edit({ operation: 'insert_after', lineId: 'NOPE', content: 'X' }),
        ['N1'],
      ),
    ).toBeNull();
    expect(
      applyCodeLineEdit(
        linesOf(['A']),
        edit({ operation: 'replace_lines', lineIds: ['NOPE'], content: 'X' }),
        ['N1'],
      ),
    ).toBeNull();
    expect(
      applyCodeLineEdit(linesOf(['A']), edit({ operation: 'delete_lines', lineIds: [] }), []),
    ).toBeNull();
  });
});
