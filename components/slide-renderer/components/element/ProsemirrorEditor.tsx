'use client';

import { useRef, useEffect, useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import { debounce } from 'lodash';
import { useKeyboardStore, useCanvasStore } from '@/lib/store';
import type { EditorView } from 'prosemirror-view';
import { toggleMark, wrapIn, lift } from 'prosemirror-commands';
import { initProsemirrorEditor, createDocument } from '@/lib/prosemirror';
import {
  isActiveOfParentNodeType,
  findNodesWithSameMark,
  getTextAttrs,
  autoSelectAll,
  addMark,
  markActive,
  getFontsize,
} from '@/lib/prosemirror/utils';
import emitter, {
  EmitterEvents,
  type RichTextAction,
  type RichTextCommand,
} from '@/lib/utils/emitter';
import { alignmentCommand } from '@/lib/prosemirror/commands/setTextAlign';
import { indentCommand, textIndentCommand } from '@/lib/prosemirror/commands/setTextIndent';
import { toggleList } from '@/lib/prosemirror/commands/toggleList';
import { setListStyle } from '@/lib/prosemirror/commands/setListStyle';
import { replaceText } from '@/lib/prosemirror/commands/replaceText';
import type { TextFormatPainterKeys } from '@/lib/types/edit';
import { KEYS } from '@/configs/hotkey';
import { toast } from 'sonner';

export interface ProsemirrorEditorProps {
  elementId: string;
  defaultColor: string;
  defaultFontName: string;
  value: string;
  editable?: boolean;
  autoFocus?: boolean;
  onUpdate?: (payload: { value: string; ignore: boolean }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
}

export interface ProsemirrorEditorRef {
  focus: () => void;
}

/**
 * ProseMirror rich text Editor component
 * Handles complex text editing with support for formatting, lists, links, etc.
 */
export const ProsemirrorEditor = forwardRef<ProsemirrorEditorRef, ProsemirrorEditorProps>(
  (
    {
      elementId,
      defaultColor,
      defaultFontName,
      value,
      editable = false,
      autoFocus = false,
      onUpdate,
      onFocus,
      onBlur,
      onMouseDown,
    },
    ref,
  ) => {
    const editorViewRef = useRef<HTMLDivElement>(null);
    const editorView = useRef<EditorView | null>(null);

    const handleElementId = useCanvasStore.use.handleElementId();
    const textFormatPainter = useCanvasStore.use.textFormatPainter();
    const richTextAttrs = useCanvasStore.use.richTextAttrs();
    const activeElementIdList = useCanvasStore.use.activeElementIdList();
    const setDisableHotkeysState = useCanvasStore.use.setDisableHotkeysState();
    const setRichtextAttrs = useCanvasStore.use.setRichtextAttrs();
    const setTextFormatPainter = useCanvasStore.use.setTextFormatPainter();
    const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());

    // Handle input with debounce

    const handleInput = useMemo(
      () =>
        debounce(
          (isHandleHistory = false) => {
            if (!editorView.current) return;
            if (
              value.replace(/ style=""/g, '') ===
              editorView.current.dom.innerHTML.replace(/ style=""/g, '')
            )
              return;
            onUpdate?.({
              value: editorView.current.dom.innerHTML,
              ignore: isHandleHistory,
            });
          },
          300,
          { trailing: true },
        ),
      [value, onUpdate],
    );

    // Handle focus
    const handleFocus = useCallback(() => {
      // Don't disable hotkeys if ctrl/shift is pressed and multiple elements are selected
      if (!ctrlOrShiftKeyActive || activeElementIdList.length <= 1) {
        setDisableHotkeysState(true);
      }
      onFocus?.();
    }, [ctrlOrShiftKeyActive, activeElementIdList.length, setDisableHotkeysState, onFocus]);

    // Handle blur
    const handleBlur = useCallback(() => {
      setDisableHotkeysState(false);
      onBlur?.();
    }, [setDisableHotkeysState, onBlur]);

    // Handle click
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce returns a stable function reference
    const handleClick = useCallback(
      debounce(
        () => {
          if (!editorView.current) return;
          const attrs = getTextAttrs(editorView.current, {
            color: defaultColor,
            fontname: defaultFontName,
          });
          setRichtextAttrs(attrs);
        },
        30,
        { trailing: true },
      ),
      [defaultColor, defaultFontName, setRichtextAttrs],
    );

    // Handle keydown
    const handleKeydown = useCallback(
      (view: EditorView, e: KeyboardEvent) => {
        const { ctrlKey, shiftKey, metaKey } = e;
        const ctrlActive = ctrlKey || shiftKey || metaKey;
        const key = e.key.toUpperCase();

        const isHandleHistory = ctrlActive && (key === KEYS.Z || key === KEYS.Y);

        handleInput(isHandleHistory);
        handleClick();
      },
      [handleInput, handleClick],
    );

    // Execute rich text command
    const execCommand = useCallback(
      ({ target, action }: RichTextCommand) => {
        if (!editorView.current) return;
        if (!target && handleElementId !== elementId) return;
        if (target && target !== elementId) return;

        const actions = 'command' in action ? [action] : action;

        for (const item of actions) {
          if (item.command === 'fontname' && item.value !== undefined) {
            const mark = editorView.current.state.schema.marks.fontname.create({
              fontname: item.value,
            });
            autoSelectAll(editorView.current);
            addMark(editorView.current, mark);

            if (item.value && !document.fonts.check(`16px ${item.value}`)) {
              toast.warning('Font is loading, please wait...');
            }
          } else if (item.command === 'fontsize' && item.value) {
            const mark = editorView.current.state.schema.marks.fontsize.create({
              fontsize: item.value,
            });
            autoSelectAll(editorView.current);
            addMark(editorView.current, mark);
            setListStyle(editorView.current, {
              key: 'fontsize',
              value: item.value,
            });
          } else if (item.command === 'fontsize-add') {
            const step = item.value ? +item.value : 2;
            autoSelectAll(editorView.current);
            const fontsize = getFontsize(editorView.current) + step + 'px';
            const mark = editorView.current.state.schema.marks.fontsize.create({
              fontsize,
            });
            addMark(editorView.current, mark);
            setListStyle(editorView.current, {
              key: 'fontsize',
              value: fontsize,
            });
          } else if (item.command === 'fontsize-reduce') {
            const step = item.value ? +item.value : 2;
            autoSelectAll(editorView.current);
            let fontsize = getFontsize(editorView.current) - step;
            if (fontsize < 12) fontsize = 12;
            const mark = editorView.current.state.schema.marks.fontsize.create({
              fontsize: fontsize + 'px',
            });
            addMark(editorView.current, mark);
            setListStyle(editorView.current, {
              key: 'fontsize',
              value: fontsize + 'px',
            });
          } else if (item.command === 'color' && item.value) {
            const mark = editorView.current.state.schema.marks.forecolor.create({
              color: item.value,
            });
            autoSelectAll(editorView.current);
            addMark(editorView.current, mark);
            setListStyle(editorView.current, {
              key: 'color',
              value: item.value,
            });
          } else if (item.command === 'backcolor' && item.value) {
            const mark = editorView.current.state.schema.marks.backcolor.create({
              backcolor: item.value,
            });
            autoSelectAll(editorView.current);
            addMark(editorView.current, mark);
          } else if (item.command === 'bold') {
            autoSelectAll(editorView.current);
            toggleMark(editorView.current.state.schema.marks.strong)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'em') {
            autoSelectAll(editorView.current);
            toggleMark(editorView.current.state.schema.marks.em)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'underline') {
            autoSelectAll(editorView.current);
            toggleMark(editorView.current.state.schema.marks.underline)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'strikethrough') {
            autoSelectAll(editorView.current);
            toggleMark(editorView.current.state.schema.marks.strikethrough)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'subscript') {
            toggleMark(editorView.current.state.schema.marks.subscript)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'superscript') {
            toggleMark(editorView.current.state.schema.marks.superscript)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'blockquote') {
            const isBlockquote = isActiveOfParentNodeType('blockquote', editorView.current.state);
            if (isBlockquote) lift(editorView.current.state, editorView.current.dispatch);
            else
              wrapIn(editorView.current.state.schema.nodes.blockquote)(
                editorView.current.state,
                editorView.current.dispatch,
              );
          } else if (item.command === 'code') {
            toggleMark(editorView.current.state.schema.marks.code)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'align' && item.value) {
            alignmentCommand(editorView.current, item.value);
          } else if (item.command === 'indent' && item.value) {
            indentCommand(editorView.current, +item.value);
          } else if (item.command === 'textIndent' && item.value) {
            textIndentCommand(editorView.current, +item.value);
          } else if (item.command === 'bulletList') {
            const listStyleType = item.value || '';
            const { bullet_list: bulletList, list_item: listItem } =
              editorView.current.state.schema.nodes;
            const textStyle = {
              color: richTextAttrs.color,
              fontsize: richTextAttrs.fontsize,
            };
            toggleList(
              bulletList,
              listItem,
              listStyleType,
              textStyle,
            )(editorView.current.state, editorView.current.dispatch);
          } else if (item.command === 'orderedList') {
            const listStyleType = item.value || '';
            const { ordered_list: orderedList, list_item: listItem } =
              editorView.current.state.schema.nodes;
            const textStyle = {
              color: richTextAttrs.color,
              fontsize: richTextAttrs.fontsize,
            };
            toggleList(
              orderedList,
              listItem,
              listStyleType,
              textStyle,
            )(editorView.current.state, editorView.current.dispatch);
          } else if (item.command === 'clear') {
            autoSelectAll(editorView.current);
            const { $from, $to } = editorView.current.state.selection;
            editorView.current.dispatch(editorView.current.state.tr.removeMark($from.pos, $to.pos));
            setListStyle(editorView.current, [
              { key: 'fontsize', value: '' },
              { key: 'color', value: '' },
            ]);
          } else if (item.command === 'link') {
            const markType = editorView.current.state.schema.marks.link;
            const { from, to } = editorView.current.state.selection;
            const result = findNodesWithSameMark(editorView.current.state.doc, from, to, markType);
            if (result) {
              if (item.value) {
                const mark = editorView.current.state.schema.marks.link.create({
                  href: item.value,
                  title: item.value,
                });
                addMark(editorView.current, mark, {
                  from: result.from.pos,
                  to: result.to.pos + 1,
                });
              } else
                editorView.current.dispatch(
                  editorView.current.state.tr.removeMark(
                    result.from.pos,
                    result.to.pos + 1,
                    markType,
                  ),
                );
            } else if (markActive(editorView.current.state, markType)) {
              if (item.value) {
                const mark = editorView.current.state.schema.marks.link.create({
                  href: item.value,
                  title: item.value,
                });
                addMark(editorView.current, mark);
              } else toggleMark(markType)(editorView.current.state, editorView.current.dispatch);
            } else if (item.value) {
              autoSelectAll(editorView.current);
              toggleMark(markType, { href: item.value, title: item.value })(
                editorView.current.state,
                editorView.current.dispatch,
              );
            }
          } else if (item.command === 'insert' && item.value) {
            editorView.current.dispatch(editorView.current.state.tr.insertText(item.value));
          } else if (item.command === 'replace' && item.value) {
            replaceText(editorView.current, item.value);
          }
        }

        editorView.current.focus();
        handleInput();
        handleClick();
      },
      [handleElementId, elementId, richTextAttrs, handleInput, handleClick],
    );

    // Handle mouseup for format painter
    const handleMouseup = useCallback(() => {
      if (!textFormatPainter || !editorView.current) return;
      const { keep, ...newProps } = textFormatPainter;

      const actions: RichTextAction[] = [{ command: 'clear' }];
      for (const key of Object.keys(newProps) as TextFormatPainterKeys[]) {
        const command = key;
        const value = textFormatPainter[key];
        if (value === true) actions.push({ command });
        else if (value) actions.push({ command, value });
      }
      execCommand({ action: actions });
      if (!keep) setTextFormatPainter(null);
    }, [textFormatPainter, execCommand, setTextFormatPainter]);

    // Sync attrs to store
    const syncAttrsToStore = useCallback(() => {
      if (handleElementId !== elementId) return;
      handleClick();
    }, [handleElementId, elementId, handleClick]);

    // Initialize ProseMirror Editor
    useEffect(() => {
      if (!editorViewRef.current) return;

      editorView.current = initProsemirrorEditor(editorViewRef.current, value, {
        handleDOMEvents: {
          focus: handleFocus,
          blur: handleBlur,
          keydown: handleKeydown,
          click: handleClick,
          mouseup: handleMouseup,
        },
        editable: () => editable,
      });

      if (autoFocus) {
        editorView.current.focus();
      }

      return () => {
        if (editorView.current) {
          editorView.current.destroy();
        }
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Sync content to DOM
    useEffect(() => {
      if (!editorView.current) return;
      if (editorView.current.hasFocus()) return;

      const { doc, tr } = editorView.current.state;
      editorView.current.dispatch(tr.replaceRangeWith(0, doc.content.size, createDocument(value)));
    }, [value]);

    // Toggle editable mode
    useEffect(() => {
      if (!editorView.current) return;
      editorView.current.setProps({ editable: () => editable });
    }, [editable]);

    // Setup emitter listeners
    useEffect(() => {
      emitter.on(EmitterEvents.RICH_TEXT_COMMAND, execCommand);
      emitter.on(EmitterEvents.SYNC_RICH_TEXT_ATTRS_TO_STORE, syncAttrsToStore);

      return () => {
        emitter.off(EmitterEvents.RICH_TEXT_COMMAND, execCommand);
        emitter.off(EmitterEvents.SYNC_RICH_TEXT_ATTRS_TO_STORE, syncAttrsToStore);
      };
    }, [execCommand, syncAttrsToStore]);

    // Expose focus method
    useImperativeHandle(ref, () => ({
      focus: () => {
        if (editorView.current) {
          editorView.current.focus();
        }
      },
    }));

    return (
      <div
        ref={editorViewRef}
        className={`prosemirror-editor cursor-text ${textFormatPainter ? 'format-painter' : ''}`}
        onMouseDown={(e) => onMouseDown?.(e)}
      />
    );
  },
);

ProsemirrorEditor.displayName = 'ProsemirrorEditor';
