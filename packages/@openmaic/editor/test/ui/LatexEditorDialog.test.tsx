// @vitest-environment jsdom
import { renderToString } from 'react-dom/server';
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

  it('portals the dialog and backdrop to document.body', () => {
    const { container } = render(
      <LatexEditorDialog initialLatex="x" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement as HTMLElement;

    expect(container.contains(dialog)).toBe(false);
    expect(backdrop.parentElement).toBe(document.body);
    expect(backdrop.className).toContain('maic-editing-ui-latex-backdrop');
    expect(backdrop.className).toContain('maic-editing-ui-root');
  });

  it('renders nothing during server rendering', () => {
    const realDocument = globalThis.document;
    // @ts-expect-error simulate a server environment without a DOM
    delete globalThis.document;
    try {
      expect(renderToString(<LatexEditorDialog onConfirm={vi.fn()} onClose={vi.fn()} />)).toBe('');
    } finally {
      globalThis.document = realDocument;
    }
  });

  it('calls onClose when the backdrop is pressed but not the dialog', () => {
    const onClose = vi.fn();
    render(<LatexEditorDialog initialLatex="x" onConfirm={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole('dialog');

    fireEvent.pointerDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
