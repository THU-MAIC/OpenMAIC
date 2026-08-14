// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { TableInsertPicker } from '@/components/edit/surfaces/slide/TableInsertPicker';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function renderPicker(onPick = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(TableInsertPicker, {
        onPick,
        getLabel: (rows: number, columns: number) => `${rows} x ${columns} Table`,
      }),
    );
  });
  return { container, root, onPick };
}

describe('TableInsertPicker', () => {
  it('highlights the rectangle from the origin through the hovered size', async () => {
    const { container, root } = await renderPicker();

    expect(container.querySelectorAll('[data-table-insert-cell]')).toHaveLength(48);
    const target = container.querySelector('[aria-label="2 x 3 Table"]') as HTMLButtonElement;
    await act(async () => {
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="table-insert-dimensions"]')?.textContent).toBe(
      '2 x 3 Table',
    );
    expect(container.querySelectorAll('[data-table-insert-cell][data-active="true"]')).toHaveLength(
      6,
    );
    await act(async () => root.unmount());
    container.remove();
  });

  it('returns the selected row and column count', async () => {
    const { container, root, onPick } = await renderPicker();
    const target = container.querySelector('[aria-label="4 x 5 Table"]') as HTMLButtonElement;

    await act(async () => target.click());
    expect(onPick).toHaveBeenCalledWith(4, 5);
    await act(async () => root.unmount());
    container.remove();
  });
});
