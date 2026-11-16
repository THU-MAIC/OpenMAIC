'use client';

/**
 * Editing a name in place, the way the knowledge base does it and My courses
 * borrows it: a new folder appears as a row (or card) whose name is a field,
 * already holding a de-duplicated default and selected; a rename turns the
 * name itself into that field. Enter or leaving the field saves, Escape
 * cancels, and a refusal is said under the field without losing what was
 * typed.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** The default name of a new folder, numbered when the folders shown already have it. */
export function newFolderName(base: string, folders: readonly { readonly name: string }[]): string {
  // The server's comparison (the folders' normalized name); it stays the authority.
  const taken = new Set(folders.map((folder) => folder.name.toLocaleLowerCase('en-US')));
  if (!taken.has(base.toLocaleLowerCase('en-US'))) return base;
  for (let number = 2; ; number += 1) {
    const name = `${base} ${number}`;
    if (!taken.has(name.toLocaleLowerCase('en-US'))) return name;
  }
}

/** How an edit in place asked to be saved. */
export type CommitCause = 'enter' | 'blur';

/**
 * A name edited in place, in its row: Enter or leaving the
 * field saves, Escape cancels. One edit asks once: the blur after Enter or
 * Escape, or while the answer is awaited, asks nothing, and the Enter that
 * ends an input method's composition belongs to the composition. What was
 * typed stays the field's own; an answer never rewrites it.
 */
export function InlineName({
  testId,
  errorTestId,
  label,
  initialName,
  selection,
  maxLength,
  busy,
  error,
  onEdit,
  onCaret,
  onFocusChange,
  takeFocus = true,
  cause,
  onCommit,
  onCancel,
}: {
  readonly testId: string;
  readonly errorTestId: string;
  readonly label: string;
  readonly initialName: string;
  /** What is selected when the field appears; all of it unless given. */
  readonly selection?: readonly [number, number];
  readonly maxLength?: number;
  readonly busy: boolean;
  /** Why the last attempt was refused, already translated. */
  readonly error: string | null;
  /** What is typed, as it is typed: a page keeping it can show it again in a new row. */
  readonly onEdit: (value: string) => void;
  /** Where the caret or selection is, whenever it changes, for the same reason. */
  readonly onCaret?: (selection: readonly [number, number]) => void;
  /** Whether the field has the focus, whenever that changes, for the same reason. */
  readonly onFocusChange?: (focused: boolean) => void;
  /** Take the focus when it appears: not in a new row for a field the teacher had left. */
  readonly takeFocus?: boolean;
  /** How the attempt being answered was asked, for a field that appears while it is. */
  readonly cause?: CommitCause;
  readonly onCommit: (name: string, cause: CommitCause) => void;
  readonly onCancel: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);
  const firstSelection = useRef(selection);
  /** Enter or a blur asked; nothing asks again until the page has answered. */
  const asked = useRef(false);
  /** Escape ended the edit: the blur that follows saves nothing. */
  const cancelled = useRef(false);
  const wasBusy = useRef(false);
  const reportCaret = (input: HTMLInputElement) =>
    onCaret?.([
      input.selectionStart ?? input.value.length,
      input.selectionEnd ?? input.value.length,
    ]);
  /** How the answered attempt was asked: only an Enter's refusal takes the focus back. */
  const lastCause = useRef<CommitCause>(cause ?? 'enter');
  const focusOnMount = useRef(takeFocus);
  useLayoutEffect(() => {
    const input = field.current;
    if (!input) return;
    // Not from a field the teacher is typing in elsewhere (the search).
    const active = document.activeElement;
    const typing =
      active instanceof HTMLElement &&
      active !== input &&
      (active.isContentEditable ||
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement);
    if (typing || !focusOnMount.current) return;
    input.focus();
    const [start, end] = firstSelection.current ?? [0, input.value.length];
    input.setSelectionRange(start, end);
  }, []);
  // Every render the page answered in: a kept edit can ask again, and after
  // an Enter's refusal it takes the focus back if nothing else has it.
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    asked.current = false;
    if (!wasBusy.current) return;
    wasBusy.current = false;
    if (
      lastCause.current === 'enter' &&
      (document.activeElement === null || document.activeElement === document.body)
    ) {
      field.current?.focus();
    }
  });
  return (
    <div className="min-w-0 flex-1">
      <input
        ref={field}
        data-testid={testId}
        data-kb-inline-name=""
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={value}
        maxLength={maxLength}
        disabled={busy}
        onChange={(event) => {
          setValue(event.target.value);
          onEdit(event.target.value);
          reportCaret(event.target);
        }}
        onSelect={(event) => reportCaret(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelled.current = true;
            onCancel();
            return;
          }
          if (event.key !== 'Enter') return;
          // WebKit sends the composition's Enter after compositionend, as 229.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (asked.current) return;
          asked.current = true;
          lastCause.current = 'enter';
          onCommit(value, 'enter');
        }}
        onFocus={() => onFocusChange?.(true)}
        onBlur={(event) => {
          // A row taken out of the page blurs nothing the teacher did.
          if (event.currentTarget.isConnected) onFocusChange?.(false);
          if (cancelled.current || asked.current || busy || !event.currentTarget.isConnected) {
            return;
          }
          asked.current = true;
          lastCause.current = 'blur';
          onCommit(event.currentTarget.value, 'blur');
        }}
        className="-my-1 h-7 w-full min-w-0 rounded-md border border-[color:var(--ws-accent)] bg-transparent px-1.5 text-[13px] outline-none disabled:opacity-60"
      />
      {error ? (
        <p
          data-testid={errorTestId}
          role="alert"
          className="mt-1 text-[12px] text-[color:var(--ws-fail)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
