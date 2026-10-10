import { describe, expect, it } from 'vitest';

import {
  formatText,
  getHiddenCells,
} from '@/components/slide-renderer/components/element/TableElement/tableUtils';

describe('tableUtils', () => {
  it('tolerates malformed rows and null cells when computing hidden cells', () => {
    const data = [[{ id: 'a', text: 'x', colspan: 2 }, null], null, 5] as never;

    expect(() => getHiddenCells(data)).not.toThrow();
    expect(getHiddenCells(data)).toEqual(new Set(['0_1']));
  });

  it('formats line breaks and spaces of plain cell text', () => {
    expect(formatText('a b\nc')).toBe('a&nbsp;b<br/>c');
    expect(formatText(undefined)).toBe('');
  });

  it('leaves cell markup and its attributes untouched when formatting', () => {
    expect(formatText('<p><span data-inline-math="x + y">x + y</span> z</p>')).toBe(
      '<p><span data-inline-math="x + y">x&nbsp;+&nbsp;y</span>&nbsp;z</p>',
    );
  });
});
