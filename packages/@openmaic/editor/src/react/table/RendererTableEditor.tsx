'use client';

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { PPTTableElement, TableCell, TableCellBorder } from '@openmaic/dsl';
import { getTableSubThemeColor } from '@openmaic/renderer';
import { getTextStyle } from '@openmaic/renderer/elements';
import { RendererTextEditor } from '../text/RendererTextEditor';
import type { TextEditorController, TextFormatState } from '../text/types';
import type { TableCellChange } from '../types';

function cellBorderCss(border?: TableCellBorder): string | undefined {
  if (!border || border.width <= 0) return undefined;
  const style = border.style === 'dashed' || border.style === 'dotted' ? border.style : 'solid';
  return `${border.width}px ${style} ${border.color}`;
}

export interface RendererTableEditorProps {
  readonly element: PPTTableElement;
  readonly initialFocusPoint?: { readonly left: number; readonly top: number };
  readonly onChange: (change: TableCellChange) => void;
  readonly onTextEditorChange?: (controller: TextEditorController | null) => void;
  readonly onTextFormatChange?: (elementId: string, state: TextFormatState) => void;
  readonly onTextFocusChange?: (focused: boolean) => void;
  readonly onExit?: () => void;
}

export interface RendererTableEditorController {
  flush: () => void;
  discard: () => void;
}

/** Visual affordance for a selected table before its cells enter edit mode. */
export function TableEditMask({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <div
      data-table-edit-mask-container=""
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      {children}
      <div
        data-table-edit-mask=""
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgb(0 0 0 / 0.02)',
          pointerEvents: 'none',
        }}
      >
        <span
          data-table-edit-mask-tip=""
          style={{
            position: 'absolute',
            top: 5,
            left: 5,
            padding: '6px 12px',
            color: '#fff',
            backgroundColor: 'rgb(0 0 0 / 50%)',
            fontSize: 12,
            lineHeight: 1.2,
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

/** A PPTist-style table editor where only one cell is contenteditable. */
export const RendererTableEditor = forwardRef<
  RendererTableEditorController,
  RendererTableEditorProps
>(function RendererTableEditor(
  {
    element,
    initialFocusPoint,
    onChange,
    onTextEditorChange,
    onTextFormatChange,
    onTextFocusChange,
    onExit,
  },
  ref,
) {
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [cellFocusPoint, setCellFocusPoint] = useState<{
    readonly cellId: string;
    readonly left: number;
    readonly top: number;
  } | null>(null);
  const activeCellControllerRef = useRef<TextEditorController | null>(null);
  const cellRefs = useRef(new Map<string, HTMLTableCellElement>());
  const focusedInitialPointRef = useRef(false);
  const [subThemeDark, subThemeLight] = useMemo(() => {
    if (!element.theme) return ['', ''];
    return getTableSubThemeColor(element.theme.color);
  }, [element.theme]);
  const borderStyle = useMemo(() => {
    const outline = element.outline;
    if (!outline) return 'none';
    return `${outline.width ?? 1}px ${outline.style === 'dashed' ? 'dashed' : 'solid'} ${outline.color ?? '#000'}`;
  }, [element.outline]);

  const commitActiveCell = useCallback(() => {
    activeCellControllerRef.current?.flush();
  }, []);

  const activateCell = useCallback(
    (cellId: string, focusPoint?: { readonly left: number; readonly top: number }) => {
      if (cellId === activeCellId) return;
      commitActiveCell();
      if (focusPoint) setCellFocusPoint({ cellId, ...focusPoint });
      setActiveCellId(cellId);
    },
    [activeCellId, commitActiveCell],
  );
  const discardActiveCell = useCallback(() => {
    activeCellControllerRef.current?.discard();
  }, []);

  useImperativeHandle(ref, () => ({ flush: commitActiveCell, discard: discardActiveCell }), [
    commitActiveCell,
    discardActiveCell,
  ]);

  useLayoutEffect(() => {
    if (!initialFocusPoint || focusedInitialPointRef.current) return;
    const target = [...cellRefs.current.entries()].find(([, cell]) => {
      const rect = cell.getBoundingClientRect();
      return (
        initialFocusPoint.left >= rect.left &&
        initialFocusPoint.left <= rect.right &&
        initialFocusPoint.top >= rect.top &&
        initialFocusPoint.top <= rect.bottom
      );
    });
    if (!target) return;
    focusedInitialPointRef.current = true;
    activateCell(target[0], initialFocusPoint);
  }, [activateCell, initialFocusPoint]);

  const handleCellContentChange = useCallback(
    (cell: TableCell, content: string, history: TableCellChange['history']) => {
      if (content === cell.text) return;
      onChange({
        intent: { type: 'table.updateCell', id: element.id, cellId: cell.id, text: content },
        history,
      });
    },
    [element.id, onChange],
  );
  const handleCellControllerChange = useCallback(
    (controller: TextEditorController | null) => {
      activeCellControllerRef.current = controller;
      onTextEditorChange?.(
        controller
          ? {
              ...controller,
              elementId: element.id,
              kind: 'table-cell',
            }
          : null,
      );
    },
    [element.id, onTextEditorChange],
  );

  const getCellBackground = (rowIndex: number, columnIndex: number, backcolor?: string) => {
    if (backcolor) return backcolor;
    const theme = element.theme;
    if (!theme) return undefined;
    if (theme.rowHeader && rowIndex === 0) return theme.color;
    if (theme.rowFooter && rowIndex === element.data.length - 1) return theme.color;
    if (theme.colHeader && columnIndex === 0) return subThemeDark;
    if (theme.colFooter && columnIndex === (element.data[0]?.length ?? 0) - 1) return subThemeDark;
    const effectiveRow = theme.rowHeader ? rowIndex - 1 : rowIndex;
    return effectiveRow >= 0 && effectiveRow % 2 === 0 ? subThemeLight : undefined;
  };
  const getHeaderTextColor = (rowIndex: number) => {
    const theme = element.theme;
    if (!theme) return undefined;
    if (theme.rowHeader && rowIndex === 0) return '#fff';
    if (theme.rowFooter && rowIndex === element.data.length - 1) return '#fff';
    return undefined;
  };

  return (
    <table
      className="slide-renderer-prose"
      style={{
        width: '100%',
        height: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
        pointerEvents: 'auto',
      }}
    >
      <colgroup>
        {element.colWidths.map((width, index) => (
          <col key={index} style={{ width: `${width * element.width}px` }} />
        ))}
      </colgroup>
      <tbody>
        {element.data.map((row, rowIndex) => (
          <tr
            key={rowIndex}
            style={{ height: `${element.rowHeights?.[rowIndex] ?? element.cellMinHeight}px` }}
          >
            {row.map((cell, columnIndex) => {
              const headerColor = getHeaderTextColor(rowIndex);
              const textStyle = getTextStyle(cell.style);
              if (headerColor && !cell.style?.color) textStyle.color = headerColor;
              const borders = cell.borders;
              const borderCss: CSSProperties =
                borders && (borders.top || borders.bottom || borders.left || borders.right)
                  ? {
                      borderTop: cellBorderCss(borders.top) ?? 'none',
                      borderBottom: cellBorderCss(borders.bottom) ?? 'none',
                      borderLeft: cellBorderCss(borders.left) ?? 'none',
                      borderRight: cellBorderCss(borders.right) ?? 'none',
                    }
                  : { border: borderStyle };
              const rowHeight = element.rowHeights?.[rowIndex] ?? element.cellMinHeight;
              const cellTextStyle: CSSProperties = {
                minHeight: `${rowHeight - 4}px`,
                padding: cell.padding,
                display: 'flex',
                flexDirection: 'column',
                lineHeight: 1,
                justifyContent:
                  cell.vAlign === 'top'
                    ? 'flex-start'
                    : cell.vAlign === 'bottom'
                      ? 'flex-end'
                      : 'center',
                ...textStyle,
              };
              const isActive = activeCellId === cell.id;
              const activeCellFocusPoint =
                cellFocusPoint?.cellId === cell.id
                  ? { left: cellFocusPoint.left, top: cellFocusPoint.top }
                  : undefined;

              return (
                <td
                  key={cell.id}
                  ref={(node) => {
                    if (node) cellRefs.current.set(cell.id, node);
                    else cellRefs.current.delete(cell.id);
                  }}
                  data-table-cell-id={cell.id}
                  colSpan={cell.colspan > 1 ? cell.colspan : undefined}
                  rowSpan={cell.rowspan > 1 ? cell.rowspan : undefined}
                  style={{
                    ...borderCss,
                    backgroundColor: getCellBackground(
                      rowIndex,
                      columnIndex,
                      cell.style?.backcolor,
                    ),
                  }}
                  onPointerDown={(event: ReactPointerEvent<HTMLTableCellElement>) => {
                    event.stopPropagation();
                    if (activeCellId !== cell.id) event.preventDefault();
                    activateCell(cell.id, { left: event.clientX, top: event.clientY });
                  }}
                >
                  {isActive ? (
                    <div
                      data-table-cell-editor={cell.id}
                      style={{ ...cellTextStyle, cursor: 'text', outline: 'none' }}
                    >
                      <RendererTextEditor
                        key={cell.id}
                        elementId={element.id}
                        value={cell.text}
                        defaultColor={cell.style?.color ?? '#333333'}
                        defaultFontName={cell.style?.fontname ?? ''}
                        autoFocus
                        initialFocusPoint={activeCellFocusPoint}
                        onContentChange={(change) =>
                          handleCellContentChange(cell, change.intent.content, change.history)
                        }
                        onFormatChange={onTextFormatChange}
                        onControllerChange={handleCellControllerChange}
                        onFocusChange={onTextFocusChange}
                        onEscape={() => {
                          discardActiveCell();
                          onExit?.();
                        }}
                      />
                    </div>
                  ) : (
                    <div
                      style={{ ...cellTextStyle, cursor: 'text' }}
                      dangerouslySetInnerHTML={{ __html: cell.text }}
                    />
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
});
