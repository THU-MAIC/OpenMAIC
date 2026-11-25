// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatexEditorDialog } from '../../src/ui/latex/LatexEditorDialog';

afterEach(cleanup);

describe('LatexEditorDialog', () => {
  it('previews valid source and confirms a measured editor result', () => {
    const onConfirm = vi.fn();

    render(<LatexEditorDialog initialLatex="x^2" onConfirm={onConfirm} onClose={vi.fn()} />);

    expect(screen.getByTestId('latex-editor-preview').innerHTML).toContain('katex');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(onConfirm).toHaveBeenCalledWith({
      latex: 'x^2',
      html: expect.stringContaining('katex'),
      width: 120,
      height: 48,
    });
  });

  it('temporarily hides the symbol and preset palettes', () => {
    render(<LatexEditorDialog initialLatex="ab" onConfirm={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Insert integral' })).toBeNull();
  });

  it('portals the modal to the document body so editor chrome cannot paint over it', () => {
    const { container } = render(
      <LatexEditorDialog initialLatex="x^2" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );

    const backdrop = screen.getByRole('dialog').parentElement;

    expect(backdrop?.parentElement).toBe(document.body);
    expect(container.contains(backdrop)).toBe(false);
  });

  it('hydrates server markup without a mismatch and focuses the source once open', async () => {
    const dialog = <LatexEditorDialog initialLatex="x^2" onConfirm={vi.fn()} onClose={vi.fn()} />;
    const container = document.createElement('div');
    container.innerHTML = renderToString(dialog);
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();

    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, dialog, { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog').parentElement?.parentElement).toBe(document.body);
    expect(screen.getByLabelText('LaTeX source')).toHaveFocus();

    act(() => root?.unmount());
    container.remove();
  });

  it('disables confirm and announces an error for invalid Latex', () => {
    render(<LatexEditorDialog onConfirm={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: '\\frac{' } });

    expect(screen.getByRole('status').textContent).not.toBe('');
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
