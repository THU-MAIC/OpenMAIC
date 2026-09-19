// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('disables confirm and announces an error for invalid Latex', () => {
    render(<LatexEditorDialog onConfirm={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('LaTeX source'), { target: { value: '\\frac{' } });

    expect(screen.getByRole('status').textContent).not.toBe('');
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
