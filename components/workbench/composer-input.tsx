'use client';

/**
 * The composer's input: a small ProseMirror editor whose `/skill` handles and `@`
 * mentions are inline chips (`lib/workbench/composer-doc`).
 *
 * THE CALLER STILL HOLDS A PLAIN STRING. `value` and `onValueChange` carry the same
 * text a textarea would, `/deep-interactive` and `@name` included, so what is sent,
 * the drafts, the triggers and the send state know nothing of the editor. The
 * handle has a textarea's vocabulary for the same reason: `selectionStart`,
 * `setSelectionRange`, `focus`, all in offsets into that string.
 *
 * AN EDIT THAT COMES FROM OUTSIDE (a pick, a restore) arrives as a `value` that
 * differs from the document. It is applied as the smallest replacement, so a pick
 * is one undo step. An empty `value` starts over, undo history included: the
 * draft was sent or abandoned.
 *
 * THE IME IS PROSEMIRROR'S, and nothing here may disturb it. While a composition
 * is open nothing rewrites the document: chips are worked out when it ends, and
 * ProseMirror does not call `handleKeyDown` for a key that belongs to it, so the
 * Enter that commits a candidate cannot send.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import {
  chainCommands,
  deleteSelection,
  joinBackward,
  joinForward,
  selectAll,
  splitBlock,
} from 'prosemirror-commands';
import { closeHistory, history, redo, undo } from 'prosemirror-history';
import { keydownHandler } from 'prosemirror-keymap';
import {
  EditorState,
  Plugin,
  TextSelection,
  type Command,
  type Transaction,
} from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';

import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { useSkillChipNames } from '@/lib/workbench/use-skill-chip-names';
import {
  composerClipboardSerializer,
  composerSchema,
  docFromPlain,
  normalizeComposerDoc,
  offsetOfPos,
  plainOfDoc,
  plainOfSlice,
  posOfOffset,
  replaceComposerDoc,
  sliceOfPlainText,
  type ComposerChipSource,
} from '@/lib/workbench/composer-doc';
import type { InlineMention } from '@/lib/workbench/composer-mentions';
import { composerMentionIcon } from './composer-chip';

/** A textarea's vocabulary, in offsets into the composer's string. */
export interface ComposerInputHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
  /** Type at the selection, as a keystroke would. For tests and programmatic input. */
  insertText(text: string): void;
}

/** The element's handle: how a test, which has no keyboard, drives the real editor. */
const HANDLE = Symbol.for('openmaic.composer-input-handle');

export function composerInputHandleOf(element: Element): ComposerInputHandle | undefined {
  return (element as Element & { [HANDLE]?: ComposerInputHandle })[HANDLE];
}

/** A composer's input element, whichever the surface. */
export const COMPOSER_INPUT_SELECTOR = '[data-composer-input]';

const NO_MENTIONS: readonly InlineMention[] = [];
/** A transaction whose text came from outside: it must not be reported back as an edit. */
const EXTERNAL = 'composer-external';
/** A transaction whose text should become chips at once, caret or no caret. */
const SETTLE = 'composer-settle';
/** No edit of its own: the document owes a pass of the chip rule (a composition ended). */
const RECHECK = 'composer-recheck';

/**
 * Backspace or Delete beside a chip takes the chip. Backspace past the one space
 * a chip keeps after it takes the chip too: that space is the chip's gap, not a
 * thing the person typed, and a key that seems to do nothing is the wrong answer.
 */
function deleteChip(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const { selection, tr } = state;
    if (!selection.empty) return false;
    const { $from, from } = selection;
    const chipType = composerSchema.nodes.chip;
    let start = from;
    let end = from;
    if (direction > 0) {
      if ($from.nodeAfter?.type !== chipType) return false;
      end = from + $from.nodeAfter.nodeSize;
    } else if ($from.nodeBefore?.type === chipType) {
      start = from - $from.nodeBefore.nodeSize;
    } else if ($from.nodeBefore?.text === ' ' && $from.textOffset === 0) {
      const chip = state.doc.resolve(from - 1).nodeBefore;
      if (chip?.type !== chipType) return false;
      start = from - 1 - chip.nodeSize;
    } else {
      return false;
    }
    // Its own undo step, however quickly it follows the last edit.
    if (dispatch) dispatch(closeHistory(tr).delete(start, end).scrollIntoView());
    return true;
  };
}

/** Pasted or dropped text: plain, whatever else the clipboard offered. */
function pasteText(view: EditorView, text: string): void {
  const slice = sliceOfPlainText(text);
  if (slice.size === 0) return;
  view.dispatch(view.state.tr.replaceSelection(slice).setMeta(SETTLE, true).scrollIntoView());
}

/**
 * Home and End on a line that a chip begins or ends. The browser will not put the
 * caret outside a non-editable node at the edge of a line, so Home would stop after
 * a leading chip and Delete could never reach it. Declines where no chip is at the
 * edge: the browser's own movement stands.
 */
function moveToLineEdge(direction: -1 | 1): Command {
  return (state, dispatch, view) => {
    if (!view || !state.selection.empty) return false;
    const { $head } = state.selection;
    const start = $head.start();
    const end = $head.end();
    const lineTop = (pos: number) => view.coordsAtPos(pos, direction).top;
    const top = lineTop($head.pos);
    let edge = $head.pos;
    while (direction < 0 ? edge > start : edge < end) {
      const next = edge + direction;
      if (Math.abs(lineTop(next) - top) > 2) break;
      edge = next;
    }
    const $edge = state.doc.resolve(edge);
    const beyond = direction < 0 ? $edge.nodeAfter : $edge.nodeBefore;
    if (beyond?.type !== composerSchema.nodes.chip) return false;
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, edge)));
    return true;
  };
}

const KEYS = keydownHandler({
  Home: moveToLineEdge(-1),
  End: moveToLineEdge(1),
  'Mod-ArrowLeft': moveToLineEdge(-1),
  'Mod-ArrowRight': moveToLineEdge(1),
  'Mod-z': undo,
  'Mod-y': redo,
  'Shift-Mod-z': redo,
  'Mod-a': selectAll,
  Enter: splitBlock,
  'Shift-Enter': splitBlock,
  Backspace: chainCommands(deleteSelection, deleteChip(-1), joinBackward),
  Delete: chainCommands(deleteSelection, deleteChip(1), joinForward),
});

export function ComposerInput({
  value,
  onValueChange,
  inputRef,
  onCaretChange,
  onKeyDown,
  onPaste,
  mentions = NO_MENTIONS,
  onMentionRestored,
  placeholder,
  className,
  rows = 1,
  disabled = false,
  readOnly = false,
  testId,
  ariaKeyShortcuts,
}: {
  readonly value: string;
  readonly onValueChange: (text: string) => void;
  readonly inputRef?: RefObject<ComposerInputHandle | null>;
  /**
   * Where the caret is, and whether it stands against a chip: a chip is finished
   * text, so a caret beside one must not read the chip as a query being typed.
   */
  readonly onCaretChange?: (caret: number, besideChip: boolean) => void;
  readonly onKeyDown?: (event: KeyboardEvent) => void;
  /** Runs first; `preventDefault` means it took the paste (files, say). */
  readonly onPaste?: (event: ClipboardEvent) => void;
  readonly mentions?: readonly InlineMention[];
  /** An undo or redo brought back a chip whose mention had gone with it. */
  readonly onMentionRestored?: (mention: InlineMention) => void;
  readonly placeholder?: string;
  readonly className?: string;
  /** How many lines the empty box shows. */
  readonly rows?: number;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly testId?: string;
  readonly ariaKeyShortcuts?: string;
}) {
  const { t } = useI18n();
  const skillNames = useSkillChipNames(t);
  const source = useMemo<ComposerChipSource>(
    () => ({
      skills: skillNames,
      mentions: new Map(mentions.map((mention) => [mention.label, mention])),
      mentionIcon: composerMentionIcon,
    }),
    [skillNames, mentions],
  );

  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const resetRef = useRef<((text: string) => void) | null>(null);
  const compositionEndedAt = useRef(Number.NEGATIVE_INFINITY);
  // The handlers and props the long-lived editor reads when an event arrives.
  const latest = useRef({
    source,
    placeholder,
    onValueChange,
    onCaretChange,
    onKeyDown,
    onPaste,
    onMentionRestored,
  });
  useLayoutEffect(() => {
    latest.current = {
      source,
      placeholder,
      onValueChange,
      onCaretChange,
      onKeyDown,
      onPaste,
      onMentionRestored,
    };
  });

  const attributes = useMemo(
    () => ({
      class: cn('composer-input outline-none', className, disabled && 'opacity-60'),
      style: `--composer-rows: ${rows}`,
      role: 'textbox',
      'aria-multiline': 'true',
      'data-composer-input': '',
      // Moving the caret while typing a query is not a press "somewhere else":
      // see `CourseMentionMenu`'s outside press.
      'data-mention-keep-open': '',
      ...(testId ? { 'data-testid': testId } : {}),
      ...(ariaKeyShortcuts ? { 'aria-keyshortcuts': ariaKeyShortcuts } : {}),
      ...(placeholder ? { 'aria-placeholder': placeholder } : {}),
      ...(disabled ? { 'aria-disabled': 'true' } : {}),
    }),
    [ariaKeyShortcuts, className, disabled, placeholder, rows, testId],
  );

  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let view: EditorView | null = null;

    const reportCaret = (state: EditorState) => {
      const { $from } = state.selection;
      const beside =
        state.selection.empty &&
        ($from.nodeBefore?.type === composerSchema.nodes.chip ||
          $from.nodeAfter?.type === composerSchema.nodes.chip);
      latest.current.onCaretChange?.(offsetOfPos(state.doc, state.selection.from), !!beside);
    };

    const plugins = [
      history(),
      new Plugin({
        props: {
          decorations: (state) => {
            const { doc } = state;
            const text = latest.current.placeholder;
            if (!text || doc.childCount !== 1 || doc.firstChild!.content.size > 0) return null;
            return DecorationSet.create(doc, [
              Decoration.node(0, doc.firstChild!.nodeSize, {
                class: 'is-empty',
                'data-placeholder': text,
              }),
            ]);
          },
        },
        appendTransaction: (transactions, _old, state) => {
          if (view?.composing) return null;
          if (!transactions.some((tr) => tr.docChanged || tr.selectionSet || tr.getMeta(RECHECK))) {
            return null;
          }
          if (transactions.some((tr) => tr.getMeta(EXTERNAL))) return null;
          const settle = transactions.some((tr) => tr.getMeta(SETTLE));
          return normalizeComposerDoc(state, latest.current.source, {
            protectCaret:
              !settle && state.selection.empty
                ? offsetOfPos(state.doc, state.selection.from)
                : null,
          });
        },
      }),
    ];
    const createState = (text: string) =>
      EditorState.create({
        schema: composerSchema,
        doc: docFromPlain(text, latest.current.source),
        plugins,
      });

    const dispatchTransaction = (tr: Transaction) => {
      const current = view!;
      const before = current.state;
      const { state } = before.applyTransaction(tr);
      current.updateState(state);
      if (!state.doc.eq(before.doc)) {
        // A chip back from the undo stack brings its reference back with it, in
        // the same batch as the text that names it.
        const known = latest.current.source.mentions;
        state.doc.descendants((node) => {
          if (node.type !== composerSchema.nodes.chip || node.attrs.kind === 'skill') return;
          if (known.has(node.attrs.text)) return;
          latest.current.onMentionRestored?.({
            label: node.attrs.text,
            kind: node.attrs.kind,
            id: node.attrs.id,
            name: node.attrs.name,
          });
        });
        if (!tr.getMeta(EXTERNAL)) latest.current.onValueChange(plainOfDoc(state.doc));
      }
      if (!state.doc.eq(before.doc) || !state.selection.eq(before.selection)) reportCaret(state);
    };

    view = new EditorView(
      { mount },
      {
        state: createState(value),
        attributes,
        editable: () => !(disabled || readOnly),
        dispatchTransaction,
        clipboardTextSerializer: plainOfSlice,
        clipboardSerializer: composerClipboardSerializer,
        handleKeyDown: (_view, event) => {
          // ProseMirror also calls this with a synthetic Enter when a line break
          // turns up in the DOM around a composition: that is no key of a person's,
          // and it must not send. The line break it found stands.
          const composingKey =
            _view.composing ||
            event.isComposing ||
            event.keyCode === 229 ||
            (!(event instanceof KeyboardEvent) &&
              performance.now() - compositionEndedAt.current < 200);
          if (composingKey) return false;
          latest.current.onKeyDown?.(event);
          if (event.defaultPrevented) return true;
          return KEYS(_view, event);
        },
        handlePaste: (_view, event) => {
          latest.current.onPaste?.(event);
          if (event.defaultPrevented) return true;
          pasteText(_view, event.clipboardData?.getData('text/plain') ?? '');
          return true;
        },
        handleDOMEvents: {
          // The chips a composition left owing, once it has settled.
          compositionstart: () => {
            compositionEndedAt.current = Number.POSITIVE_INFINITY;
            return false;
          },
          compositionend: (_view) => {
            compositionEndedAt.current = performance.now();
            setTimeout(() => {
              if (viewRef.current === _view && !_view.composing) {
                _view.dispatch(_view.state.tr.setMeta(RECHECK, true));
                reportCaret(_view.state);
              }
            }, 40);
            return false;
          },
          focus: (_view) => {
            reportCaret(_view.state);
            return false;
          },
        },
      },
    );
    viewRef.current = view;
    const created = view;

    const handle: ComposerInputHandle = {
      get value() {
        return plainOfDoc(created.state.doc);
      },
      get selectionStart() {
        return offsetOfPos(created.state.doc, created.state.selection.from);
      },
      get selectionEnd() {
        return offsetOfPos(created.state.doc, created.state.selection.to);
      },
      setSelectionRange(start, end) {
        const { doc } = created.state;
        created.dispatch(
          created.state.tr.setSelection(
            TextSelection.create(doc, posOfOffset(doc, start), posOfOffset(doc, end)),
          ),
        );
      },
      focus() {
        created.focus();
      },
      insertText(text) {
        created.dispatch(created.state.tr.insertText(text));
      },
    };
    (created.dom as Element & { [HANDLE]?: ComposerInputHandle })[HANDLE] = handle;
    if (inputRef) inputRef.current = handle;

    // Applied here rather than in the effect below, which needs `createState`.
    resetRef.current = (text) => {
      created.updateState(createState(text));
    };

    return () => {
      viewRef.current = null;
      resetRef.current = null;
      if (inputRef) inputRef.current = null;
      created.destroy();
      view = null;
    };
    // The editor lives as long as this component; everything that changes is read
    // through `latest` or pushed in by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Going non-editable blurs a contenteditable, as `disabled` does a textarea but
  // `readOnly` does not. A box that was being typed in gets its focus back, unless
  // the person has since moved on to something else.
  const hadFocus = useRef(false);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const editable = !(disabled || readOnly);
    if (!editable && view.hasFocus()) hadFocus.current = true;
    view.setProps({ attributes, editable: () => editable });
    if (editable && hadFocus.current) {
      hadFocus.current = false;
      if (document.activeElement === document.body || document.activeElement === null) view.focus();
    }
  }, [attributes, disabled, readOnly]);

  // A new placeholder has to redraw the decoration that reads it.
  useEffect(() => {
    const view = viewRef.current;
    if (view && !view.composing) view.updateState(view.state);
  }, [placeholder]);

  /**
   * The caller's `value` and `mentions` are the truth. Before paint, and before the
   * caller's own effects, which place the caret in the new text.
   */
  const lastSource = useRef(source);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const sourceChanged = lastSource.current !== source;
    lastSource.current = source;
    const plain = plainOfDoc(view.state.doc);
    if (view.composing && value === plain) return;
    if (value !== plain) {
      if (value === '') {
        resetRef.current?.('');
        onCaretChange?.(0, false);
        return;
      }
      const tr = replaceComposerDoc(view.state, value, source);
      if (tr) {
        // A value set from outside leaves the caret at its end, as a textarea's
        // does; a caller with a better place says so in its own effect.
        tr.setSelection(TextSelection.atEnd(tr.doc));
        view.dispatch(closeHistory(tr).setMeta(EXTERNAL, true));
      }
    }
    const tr = normalizeComposerDoc(view.state, source, {
      unbind: sourceChanged || value !== plain,
      protectCaret:
        value === plain && view.state.selection.empty
          ? offsetOfPos(view.state.doc, view.state.selection.from)
          : null,
    });
    if (tr) view.dispatch(tr.setMeta(EXTERNAL, true).setMeta('addToHistory', false));
  }, [value, source, onCaretChange]);

  return <div ref={mountRef} />;
}

/**
 * Focus a composer once it can take focus. A request that arrives while its
 * pane is still hidden or mounting (a new chat started from an open one) would
 * otherwise be a silent no-op, so retry on the next frames until the box whose
 * test id is given actually holds focus. Returns a cancel function.
 */
export function focusComposerWhenShown(
  ref: { readonly current: ComposerInputHandle | null },
  testId: string,
): () => void {
  let frames = 0;
  let handle = 0;
  const attempt = () => {
    ref.current?.focus();
    if (document.activeElement?.closest(`[data-testid="${testId}"]`)) return;
    frames += 1;
    if (frames < 60) handle = requestAnimationFrame(attempt);
  };
  attempt();
  return () => cancelAnimationFrame(handle);
}
