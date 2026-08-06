// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PPTTableElement } from '@openmaic/dsl';
import { StaticTable } from '../../../src/elements/table/StaticTable';

const table: PPTTableElement = {
  id: 'table-1',
  type: 'table',
  left: 0,
  top: 0,
  width: 240,
  height: 80,
  rotate: 0,
  colWidths: [1],
  cellMinHeight: 80,
  outline: { width: 1, color: '#333333', style: 'solid' },
  data: [[{ id: 'cell-1', colspan: 1, rowspan: 1, text: 'Centered by default' }]],
};

describe('StaticTable', () => {
  it('vertically centers a cell when no explicit vertical alignment is stored', () => {
    const { container } = render(<StaticTable elementInfo={table} />);

    expect(
      (container.querySelector('.slide-renderer-cell-text') as HTMLElement).style.justifyContent,
    ).toBe('center');
  });
});
