'use client';

/**
 * Renaming on a phone.
 *
 * Below `md` the courses page used to rename in place: the name itself turned
 * into a field. That works in a full-width row, but a course card's name sits
 * under a 16:9 thumbnail, and the field is drawn over the card — on a phone the
 * thumbnail covered it and there was nothing to type into. This is the same
 * edit, in a dialog: the field, the refusal under it, confirm and cancel, all
 * owned by the page (it holds the edit and answers it).
 */

import { useLayoutEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';

export function RenameNameDialog({
  open,
  title,
  label,
  initialName,
  maxLength,
  busy,
  error,
  onCommit,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  /** What the field is called for assistive tech. */
  readonly label: string;
  readonly initialName: string;
  readonly maxLength?: number;
  readonly busy: boolean;
  /** Why the last attempt was refused, already translated. */
  readonly error: string | null;
  readonly onCommit: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialName);
  const field = useRef<HTMLInputElement>(null);
  const errorId = 'rename-name-dialog-error';

  // The field opens holding the name the edit began with, all selected so the
  // next attempt replaces rather than appends. What is typed stays the field's
  // own afterwards: a refusal re-renders the page, not this value.
  const focusField = () => {
    field.current?.focus();
    field.current?.setSelectionRange(0, field.current.value.length);
  };

  useLayoutEffect(focusField, []);

  const submit = () => {
    if (busy || !value.trim()) return;
    onCommit(value);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent
        data-testid="workspace-courses-rename-dialog"
        // A phone keyboard takes half the screen; keep the field near the top of
        // what is left rather than behind the keyboard.
        className="top-[12%] translate-y-0 sm:top-1/2 sm:-translate-y-1/2"
        onOpenAutoFocus={(event) => {
          // The effect above focuses the field and selects it; Radix's own
          // autofocus would land before that and undo the selection.
          event.preventDefault();
          focusField();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{label}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            ref={field}
            data-testid="workspace-courses-rename-dialog-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                if (!busy) onCancel();
              }
            }}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            maxLength={maxLength}
            disabled={busy}
            className="h-10 w-full rounded-lg border border-[color:var(--border)] bg-transparent px-3 text-[16px] outline-none focus:border-[color:var(--ws-accent)] disabled:opacity-60"
          />
          {error ? (
            <p
              id={errorId}
              data-testid="workspace-courses-rename-dialog-error"
              role="alert"
              className="mt-1 text-[12px] text-[color:var(--ws-fail)]"
            >
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-4 flex-row justify-end gap-2">
            <button
              type="button"
              data-testid="workspace-courses-rename-dialog-cancel"
              onClick={onCancel}
              disabled={busy}
              className="ws-page-btn"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              data-testid="workspace-courses-rename-dialog-confirm"
              disabled={busy || !value.trim()}
              className="ws-page-btn ws-page-btn-primary"
            >
              {t('common.confirm')}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
