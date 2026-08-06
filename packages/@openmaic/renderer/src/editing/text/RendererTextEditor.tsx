'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { executeTextCommands } from './commandExecutor';
import { getTextFormatState } from './formatState';
import { createTextDocument, initTextEditor, textSchema } from './prosemirror';
import { serializeTextDocument } from './prosemirror/document';
import { shouldPushAttrs } from './prosemirror/selection-sync';
import type { TextContentChange, TextEditorController, TextFormatState } from './types';

export interface RendererTextEditorProps {
  elementId: string;
  target?: 'text' | 'shape';
  value: string;
  defaultColor: string;
  defaultFontName: string;
  autoFocus?: boolean;
  initialFocusPoint?: { left: number; top: number };
  onContentChange?: (change: TextContentChange) => void;
  onLayoutChange?: () => void;
  onFormatChange?: (elementId: string, state: TextFormatState) => void;
  onControllerChange?: (controller: TextEditorController | null) => void;
  onFocusChange?: (focused: boolean) => void;
  onEscape?: () => void;
}

type HistoryMode = TextContentChange['history'];

export function RendererTextEditor({
  elementId,
  target = 'text',
  value,
  defaultColor,
  defaultFontName,
  autoFocus = false,
  initialFocusPoint,
  onContentChange,
  onLayoutChange,
  onFormatChange,
  onControllerChange,
  onFocusChange,
  onEscape,
}: RendererTextEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const lastEmittedRef = useRef('');
  const initialFocusPointRef = useRef(initialFocusPoint);
  const callbacksRef = useRef({
    onContentChange,
    onLayoutChange,
    onFormatChange,
    onControllerChange,
    onFocusChange,
    onEscape,
  });
  const defaultsRef = useRef({ color: defaultColor, fontname: defaultFontName });

  useLayoutEffect(() => {
    valueRef.current = value;
    initialFocusPointRef.current = initialFocusPoint;
    callbacksRef.current = {
      onContentChange,
      onLayoutChange,
      onFormatChange,
      onControllerChange,
      onFocusChange,
      onEscape,
    };
    defaultsRef.current = { color: defaultColor, fontname: defaultFontName };
  }, [
    defaultColor,
    defaultFontName,
    initialFocusPoint,
    onContentChange,
    onLayoutChange,
    onControllerChange,
    onEscape,
    onFocusChange,
    onFormatChange,
    value,
  ]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingHistory: HistoryMode = 'record';
    let nextTransactionHistory: HistoryMode = 'record';
    let dirty = false;

    const pushFormatState = (view: EditorView) => {
      callbacksRef.current.onFormatChange?.(
        elementId,
        getTextFormatState(view, defaultsRef.current),
      );
    };

    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!dirty) return;
      const view = viewRef.current;
      if (!view) return;
      const content = serializeTextDocument(view.state.doc);
      const normalized = content.replace(/ style=""/g, '');
      dirty = false;
      if (normalized === lastEmittedRef.current) return;
      lastEmittedRef.current = normalized;
      callbacksRef.current.onContentChange?.({
        intent: { type: 'text.updateContent', id: elementId, content, target },
        history: pendingHistory,
      });
      pendingHistory = 'record';
      // Let the host commit the text before ResizeObserver normalizes the
      // element. That keeps the content and its auto-size in one undo frame.
      callbacksRef.current.onLayoutChange?.();
    };

    const discard = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      dirty = false;
      pendingHistory = 'record';
    };

    const schedule = (history: HistoryMode) => {
      pendingHistory = history;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 300);
    };

    const view = initTextEditor(host, valueRef.current, {
      editable: () => true,
      dispatchTransaction(transaction) {
        const currentView = viewRef.current;
        if (!currentView) return;
        const nextState = currentView.state.apply(transaction);
        currentView.updateState(nextState);
        if (shouldPushAttrs(transaction)) pushFormatState(currentView);
        if (transaction.docChanged) {
          dirty = true;
          const history = nextTransactionHistory;
          nextTransactionHistory = 'record';
          schedule(history);
        }
      },
      handleDOMEvents: {
        focus() {
          callbacksRef.current.onFocusChange?.(true);
          return false;
        },
        blur() {
          flush();
          callbacksRef.current.onFocusChange?.(false);
          return false;
        },
        keydown(_view, event) {
          const mod = event.ctrlKey || event.metaKey;
          if (mod && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
            nextTransactionHistory = 'neutral';
            return false;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            callbacksRef.current.onEscape?.();
            return true;
          }
          return false;
        },
      },
    });
    viewRef.current = view;
    lastEmittedRef.current = serializeTextDocument(view.state.doc).replace(/ style=""/g, '');

    const controller: TextEditorController = {
      elementId,
      focus: () => view.focus(),
      flush,
      discard,
      execute: (command) => {
        nextTransactionHistory = 'record';
        executeTextCommands(view, command);
        // Toolbar form controls (font/color/size) must keep their native focus
        // while commands operate on ProseMirror's retained selection.
        if (document.activeElement === document.body || view.dom.contains(document.activeElement)) {
          view.focus();
        }
        pushFormatState(view);
      },
      getHTML: () => serializeTextDocument(view.state.doc),
    };

    callbacksRef.current.onControllerChange?.(controller);
    pushFormatState(view);
    if (autoFocus) {
      const focusPoint = initialFocusPointRef.current;
      const position = focusPoint ? view.posAtCoords(focusPoint) : null;
      if (position) {
        view.dispatch(
          view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position.pos))),
        );
      }
      view.focus();
    }

    return () => {
      flush();
      callbacksRef.current.onFocusChange?.(false);
      callbacksRef.current.onControllerChange?.(null);
      viewRef.current = null;
      view.destroy();
    };
  }, [autoFocus, elementId, target]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.hasFocus()) return;
    const current = serializeTextDocument(view.state.doc).replace(/ style=""/g, '');
    const incoming = value.replace(/ style=""/g, '');
    if (current === incoming) return;
    const nextState = EditorState.create({
      doc: createTextDocument(value),
      schema: textSchema,
      plugins: view.state.plugins,
    });
    view.updateState(nextState);
    lastEmittedRef.current = serializeTextDocument(nextState.doc).replace(/ style=""/g, '');
  }, [value]);

  return (
    <div
      ref={hostRef}
      data-renderer-text-editor={elementId}
      className="text prosemirror-editor renderer-prosemirror-editor"
      style={{ position: 'relative', cursor: 'text', pointerEvents: 'auto', userSelect: 'text' }}
    />
  );
}
