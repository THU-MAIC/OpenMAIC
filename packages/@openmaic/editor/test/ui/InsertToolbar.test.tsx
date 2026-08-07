// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChartInsertPicker,
  EDITING_UI_STYLES,
  InsertToolbar,
  TableInsertPicker,
} from '../../src/ui';

describe('InsertToolbar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

    expect(screen.getByRole('button', { name: 'Text box' }).getAttribute('data-tooltip')).toBe(
      'Insert text box',
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

  it('renders injected chart content and returns the selected chart type', () => {
    const onInsertChart = vi.fn();

    render(
      <InsertToolbar
        items={[
          {
            id: 'chart',
            label: 'Chart',
            tooltip: 'Insert chart',
            icon: <span>Chart</span>,
            renderPopover: ({ close }) => (
              <ChartInsertPicker
                options={[
                  { type: 'bar', label: 'Bar chart' },
                  { type: 'line', label: 'Line chart' },
                  { type: 'pie', label: 'Pie chart' },
                ]}
                onPick={(type) => {
                  onInsertChart(type);
                  close();
                }}
              />
            ),
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Chart' }));
    const pieButton = screen.getByRole('button', { name: 'Pie chart' });
    expect(pieButton.textContent).toBe('');
    expect(pieButton.getAttribute('data-tooltip')).toBe('Pie chart');
    expect(pieButton.querySelector('svg')).not.toBeNull();
    fireEvent.click(pieButton);

    expect(onInsertChart).toHaveBeenCalledWith('pie');
    expect(screen.queryByRole('dialog', { name: 'Chart' })).toBeNull();
  });

  it('lays chart choices out as icon buttons with hover labels', () => {
    expect(EDITING_UI_STYLES).toContain('flex-direction: row;');
    expect(EDITING_UI_STYLES).toContain('content: attr(data-tooltip);');
    expect(EDITING_UI_STYLES).toContain('width: 32px;');
    expect(EDITING_UI_STYLES).toContain('overflow-y: hidden;');
    expect(EDITING_UI_STYLES).toMatch(
      /\.maic-editing-ui-chart-picker-option \{[\s\S]*?align-items: center;/,
    );
  });

  it('shows toolbar button labels with the shared renderer tooltip treatment', () => {
    expect(EDITING_UI_STYLES).toContain('.maic-editing-ui-tooltip-button::after');
    expect(EDITING_UI_STYLES).toContain("[data-tooltip-placement='right']::after");
  });

  it('anchors a popover beside the triggering insert button instead of the toolbar top', () => {
    const { container } = render(
      <InsertToolbar
        placement="left"
        items={[
          { id: 'text', label: 'Text', icon: <span>T</span> },
          { id: 'image', label: 'Image', icon: <span>I</span> },
          { id: 'table', label: 'Table', icon: <span>Table</span> },
          {
            id: 'chart',
            label: 'Chart',
            icon: <span>Chart</span>,
            renderPopover: () => <span>Chart options</span>,
          },
        ]}
      />,
    );

    const toolbar = within(container);
    fireEvent.click(toolbar.getByRole('button', { name: 'Chart' }));

    expect(toolbar.getByRole('dialog', { name: 'Chart' }).style.top).toBe('102px');
  });

  it('docks across the top and anchors popovers under the triggering button', () => {
    const { container } = render(
      <InsertToolbar
        placement="top"
        items={[
          { id: 'text', label: 'Text', icon: <span>T</span> },
          {
            id: 'table',
            label: 'Table',
            icon: <span>Table</span>,
            renderPopover: () => <span>Table options</span>,
          },
        ]}
      />,
    );

    const toolbar = within(container);
    fireEvent.click(toolbar.getByRole('button', { name: 'Table' }));

    expect(toolbar.getByTestId('renderer-insert-toolbar').getAttribute('data-placement')).toBe(
      'top',
    );
    expect(
      toolbar.getByRole('button', { name: 'Table' }).getAttribute('data-tooltip-placement'),
    ).toBe('bottom');
    expect(toolbar.getByRole('dialog', { name: 'Table' }).style.left).toBe('34px');
    expect(toolbar.getByRole('dialog', { name: 'Table' }).style.top).toBe('');
  });

  it('keeps the canvas rail fixed while a tall popover is open', () => {
    const onRailSizeChange = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 240, 320),
    );

    render(
      <InsertToolbar
        placement="top"
        onRailSizeChange={onRailSizeChange}
        items={[
          {
            id: 'video',
            label: 'Video',
            icon: <span>Video</span>,
            renderPopover: () => <span>Video options</span>,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Video' }));

    expect(onRailSizeChange).toHaveBeenLastCalledWith(48);
  });
});
