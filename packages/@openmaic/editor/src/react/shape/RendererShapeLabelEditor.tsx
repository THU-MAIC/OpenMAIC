'use client';

import { useCallback, useRef, type CSSProperties } from 'react';
import type { PPTShapeElement, ShapeText } from '@openmaic/dsl';

import { useElementFlip } from '@openmaic/renderer/elements';
import { isSemanticallyEmptyText } from '../text/richText';
import { RendererTextEditor } from '../text/RendererTextEditor';
import type { TextContentChange, TextEditorController, TextFormatState } from '../text/types';
import type { EditIntent } from '../types';

export interface RendererShapeLabelEditorProps {
  element: PPTShapeElement;
  initialFocusPoint?: { left: number; top: number };
  onContentChange?: (change: TextContentChange) => void;
  onFormatChange?: (elementId: string, state: TextFormatState) => void;
  onControllerChange?: (controller: TextEditorController | null) => void;
  onFocusChange?: (focused: boolean) => void;
  onElementsChange?: (intents: EditIntent[]) => void;
  onEscape?: () => void;
}

function shapeText(element: PPTShapeElement): ShapeText {
  return (
    element.text ?? {
      content: '',
      align: 'middle',
      defaultFontName: 'Microsoft YaHei',
      defaultColor: '#333333',
    }
  );
}

/** Inline ProseMirror label editor for a Shape selected in the renderer canvas. */
export function RendererShapeLabelEditor({
  element,
  initialFocusPoint,
  onContentChange,
  onFormatChange,
  onControllerChange,
  onFocusChange,
  onElementsChange,
  onEscape,
}: RendererShapeLabelEditorProps) {
  const controllerRef = useRef<TextEditorController | null>(null);
  const text = shapeText(element);
  const { flipStyle } = useElementFlip(element.flipH, element.flipV);
  const justifyContent =
    text.align === 'top' ? 'flex-start' : text.align === 'bottom' ? 'flex-end' : 'center';

  const handleControllerChange = useCallback(
    (controller: TextEditorController | null) => {
      controllerRef.current = controller;
      onControllerChange?.(controller);
    },
    [onControllerChange],
  );

  const handleFocusChange = useCallback(
    (focused: boolean) => {
      onFocusChange?.(focused);
      if (
        focused ||
        !element.text ||
        !isSemanticallyEmptyText(controllerRef.current?.getHTML() ?? '')
      ) {
        return;
      }
      onElementsChange?.([{ type: 'element.removeProps', id: element.id, props: ['text'] }]);
    },
    [element.id, element.text, onElementsChange, onFocusChange],
  );

  return (
    <div
      data-renderer-shape-label-editor={element.id}
      className="shape-text slide-renderer-prose"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent,
        overflowWrap: 'break-word',
        lineHeight: text.lineHeight,
        letterSpacing: `${text.wordSpace || 0}px`,
        // Match BaseShapeElement: paragraph margins affect the content height,
        // which in turn affects vertically centered Shape labels.
        ...({
          '--paragraphSpace': `${text.paragraphSpace === undefined ? 5 : text.paragraphSpace}px`,
        } as CSSProperties),
        transform: flipStyle,
      }}
    >
      <RendererTextEditor
        elementId={element.id}
        target="shape"
        value={text.content}
        defaultColor={text.defaultColor}
        defaultFontName={text.defaultFontName}
        autoFocus
        initialFocusPoint={initialFocusPoint}
        onContentChange={onContentChange}
        onFormatChange={onFormatChange}
        onControllerChange={handleControllerChange}
        onFocusChange={handleFocusChange}
        onEscape={onEscape}
      />
    </div>
  );
}
