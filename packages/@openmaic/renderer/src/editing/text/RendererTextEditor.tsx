'use client';

import { useEffect, useRef } from 'react';
import { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { executeTextCommands } from './commandExecutor';
import { getTextFormatState } from './formatState';
import { createTextDocument, initTextEditor, textSchema } from './prosemirror';
import { serializeTextDocument } from './prosemirror/document';
import { shouldPushAttrs } from './prosemirror/selection-sync';
import type { TextContentChange, TextEditorController, TextFormatState } from './types';

export interface RendererTextEditorProps {
  elementId: string;
  value: string;
  defaultColor: string;
  defaultFontName: string;
  autoFocus?: boolean;
  onContentChange?: (change: TextContentChange) => void;
  onFormatChange?: (elementId: string, state: TextFormatState) => void;
  onControllerChange?: (controller: TextEditorController | null) => void;
  onFocusChange?: (focused: boolean) => void;
  onEscape?: () => void;
}

type HistoryMode = TextContentChange['history'];

export function RendererTextEditor({
  elementId,
  value,
  defaultColor,
  defaultFontName,
  autoFocus = false,
  onContentChange,
  onFormatChange,
  onControllerChange,
  onFocusChange,
  onEscape,
}: RendererTextEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const callbacksRef = useRef({
    onContentChange,
    onFormatChange,
    onControllerChange,
    onFocusChange,
    onEscape,
  });
  const defaultsRef = useRef({ color: defaultColor, fontname: defaultFontName });

  valueRef.current = value;
  callbacksRef.current = {
    onContentChange,
    onFormatChange,
    onControllerChange,
    onFocusChange,
    onEscape,
  };
  defaultsRef.current = { color: defaultColor, fontname: defaultFontName };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingHistory: HistoryMode = 'record';
    let nextTransactionHistory: HistoryMode = 'record';
    let lastEmitted = valueRef.current.replace(/ style=""/g, '');

    const pushFormatState = (view: EditorView) => {
      callbacksRef.current.onFormatChange?.(
        elementId,
        getTextFormatState(view, defaultsRef.current),
      );
    };

    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const view = viewRef.current;
      if (!view) return;
      const content = serializeTextDocument(view.state.doc);
      const normalized = content.replace(/ style=""/g, '');
      if (normalized === lastEmitted) return;
      lastEmitted = normalized;
      callbacksRef.current.onContentChange?.({
        intent: { type: 'text.updateContent', id: elementId, content, target: 'text' },
        history: pendingHistory,
      });
      pendingHistory = 'record';
    };

    const schedule = (history: HistoryMode) => {
      pendingHistory = history;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 300);
    };

    const view = initTextEditor(host, valueRef.current, {
      editable: () => true,
      dispatchTransaction(this: EditorView, transaction) {
        const nextState = this.state.apply(transaction);
        this.updateState(nextState);
        if (shouldPushAttrs(transaction)) pushFormatState(this);
        if (transaction.docChanged) {
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
            flush();
            callbacksRef.current.onEscape?.();
            return true;
          }
          return false;
        },
      },
    });
    viewRef.current = view;

    const controller: TextEditorController = {
      elementId,
      focus: () => view.focus(),
      flush,
      execute: (command) => {
        nextTransactionHistory = 'record';
        executeTextCommands(view, command);
        view.focus();
        pushFormatState(view);
      },
      getHTML: () => serializeTextDocument(view.state.doc),
    };

    callbacksRef.current.onControllerChange?.(controller);
    pushFormatState(view);
    if (autoFocus) view.focus();

    return () => {
      flush();
      callbacksRef.current.onControllerChange?.(null);
      viewRef.current = null;
      view.destroy();
    };
  }, [autoFocus, elementId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.hasFocus()) return;
    const current = serializeTextDocument(view.state.doc).replace(/ style=""/g, '');
    const incoming = value.replace(/ style=""/g, '');
    if (current === incoming) return;
    view.updateState(
      EditorState.create({
        doc: createTextDocument(value),
        schema: textSchema,
        plugins: view.state.plugins,
      }),
    );
  }, [value]);

  return (
    <div
      ref={hostRef}
      data-renderer-text-editor={elementId}
      className="text renderer-prosemirror-editor"
      style={{ position: 'relative', cursor: 'text', pointerEvents: 'auto', userSelect: 'text' }}
    />
  );
}
