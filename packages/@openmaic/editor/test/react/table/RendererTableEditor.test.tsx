// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PPTTableElement } from '@openmaic/dsl';
import { RendererTableEditor } from '../../../src/react/table/RendererTableEditor';
import type { TextEditorController } from '../../../src/react/text/types';

const table: PPTTableElement = {
  id: 'table-1',
  type: 'table',
  left: 20,
  top: 30,
  width: 240,
  height: 100,
  rotate: 0,
  outline: { width: 1, color: '#333333', style: 'solid' },
  colWidths: [0.5, 0.5],
  cellMinHeight: 50,
  data: [
    [
      { id: 'cell-a', colspan: 1, rowspan: 1, text: 'A' },
      { id: 'cell-b', colspan: 1, rowspan: 1, text: 'B' },
    ],
  ],
};

describe('RendererTableEditor', () => {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => document.body,
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  function renderTableEditor(onChange = vi.fn()) {
    vi.useFakeTimers();
    let controller: TextEditorController | null = null;
    render(
      <RendererTableEditor
        element={table}
        onChange={onChange}
        onTextEditorChange={(next) => {
          controller = next;
        }}
      />,
    );
    return {
      onChange,
      getController: () => controller,
    };
  }

  it('commits the active cell HTML when it loses focus', () => {
    const { onChange, getController } = renderTableEditor();

    fireEvent.pointerDown(screen.getByRole('cell', { name: 'A' }));
    const controller = getController();
    if (!controller) throw new Error('Expected a table cell controller');
    act(() => controller.execute({ command: 'replace', value: 'Edited cell' }));
    const editor = document.querySelector('.ProseMirror') as HTMLElement;
    fireEvent.blur(editor);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({
          type: 'table.updateCell',
          id: 'table-1',
          cellId: 'cell-a',
          text: expect.stringContaining('Edited cell'),
        }),
        history: 'record',
      }),
    );
  });

  it('commits a draft before activating another cell', () => {
    const { onChange, getController } = renderTableEditor();

    fireEvent.pointerDown(screen.getByRole('cell', { name: 'A' }));
    const controller = getController();
    if (!controller) throw new Error('Expected a table cell controller');
    act(() => controller.execute({ command: 'replace', value: 'Changed' }));
    fireEvent.pointerDown(screen.getByRole('cell', { name: 'B' }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({
          cellId: 'cell-a',
          text: expect.stringContaining('Changed'),
        }),
        history: 'record',
      }),
    );
    expect(getController()?.getHTML()).toContain('B');
  });

  it('prevents the switching pointer default so the newly mounted editor keeps the first click', () => {
    renderTableEditor();

    fireEvent.pointerDown(screen.getByRole('cell', { name: 'A' }));
    expect(fireEvent.pointerDown(screen.getByRole('cell', { name: 'B' }))).toBe(false);
  });

  it('vertically centers a cell when no explicit vertical alignment is stored', () => {
    renderTableEditor();

    fireEvent.pointerDown(screen.getByRole('cell', { name: 'A' }));

    expect(
      (document.querySelector('[data-table-cell-editor="cell-a"]') as HTMLElement).style
        .justifyContent,
    ).toBe('center');
  });

  it('reports table-cell format state and persists shared text toolbar commands', () => {
    const onChange = vi.fn();
    const onTextFormatChange = vi.fn();
    vi.useFakeTimers();
    let controller: TextEditorController | null = null;
    render(
      <RendererTableEditor
        element={table}
        onChange={onChange}
        onTextFormatChange={onTextFormatChange}
        onTextEditorChange={(next) => {
          controller = next;
        }}
      />,
    );

    fireEvent.pointerDown(screen.getByRole('cell', { name: 'A' }));
    expect(onTextFormatChange).toHaveBeenCalledWith(
      'table-1',
      expect.objectContaining({ color: '#333333' }),
    );
    const activeController = controller as TextEditorController | null;
    if (!activeController) throw new Error('Expected a table cell controller');
    act(() => activeController.execute({ command: 'forecolor', value: '#ff0000' }));
    act(() => vi.advanceTimersByTime(300));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({
          cellId: 'cell-a',
          text: expect.stringContaining('rgb(255, 0, 0)'),
        }),
      }),
    );
  });

  it('discards a draft and exits editing on Escape', () => {
    const onChange = vi.fn();
    const onExit = vi.fn();
    vi.useFakeTimers();
    let controller: TextEditorController | null = null;

    render(
      <RendererTableEditor
        element={table}
        onChange={onChange}
        onExit={onExit}
        onTextEditorChange={(next) => {
          controller = next;
        }}
      />,
    );

    fireEvent.pointerDown(screen.getByRole('cell', { name: 'A' }));
    if (!controller) throw new Error('Expected a table cell controller');
    act(() => controller?.execute({ command: 'replace', value: 'Discard me' }));
    const editor = document.querySelector('.ProseMirror') as HTMLElement;
    fireEvent.keyDown(editor, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
