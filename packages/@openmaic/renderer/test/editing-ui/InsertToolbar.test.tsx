// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InsertToolbar, TableInsertPicker } from '../../src/editing-ui';

describe('InsertToolbar', () => {
  it('invokes a configured insert action', () => {
    const onInsertText = vi.fn();

    render(
      <InsertToolbar
        items={[
          {
            id: 'text',
            label: 'Text box',
            tooltip: 'Insert text box',
            icon: <span>T</span>,
            onInvoke: onInsertText,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Text box' }));

    expect(onInsertText).toHaveBeenCalledTimes(1);
  });

  it('renders injected table content and returns the selected dimensions', () => {
    const onInsertTable = vi.fn();

    render(
      <InsertToolbar
        items={[
          {
            id: 'table',
            label: 'Table',
            tooltip: 'Insert table',
            icon: <span>Table</span>,
            renderPopover: ({ close }) => (
              <TableInsertPicker
                getLabel={(rows, columns) => `${rows} x ${columns} table`}
                onPick={(rows, columns) => {
                  onInsertTable(rows, columns);
                  close();
                }}
              />
            ),
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    fireEvent.mouseEnter(screen.getByRole('button', { name: '3 x 4 table' }));
    expect(screen.getByTestId('table-insert-dimensions').textContent).toBe('3 x 4 table');

    fireEvent.click(screen.getByRole('button', { name: '3 x 4 table' }));

    expect(onInsertTable).toHaveBeenCalledWith(3, 4);
    expect(screen.queryByTestId('table-insert-dimensions')).toBeNull();
  });
});
