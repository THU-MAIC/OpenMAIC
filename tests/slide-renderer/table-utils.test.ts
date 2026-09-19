import { describe, expect, it } from 'vitest';

import { getHiddenCells } from '@/components/slide-renderer/components/element/TableElement/tableUtils';

describe('tableUtils', () => {
  it('tolerates malformed rows and null cells when computing hidden cells', () => {
    const data = [[{ id: 'a', text: 'x', colspan: 2 }, null], null, 5] as never;

    expect(() => getHiddenCells(data)).not.toThrow();
    expect(getHiddenCells(data)).toEqual(new Set(['0_1']));
  });
});
