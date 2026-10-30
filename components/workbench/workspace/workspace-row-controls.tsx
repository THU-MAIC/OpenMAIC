'use client';

/**
 * The two row controls the workspace's lists share: the rename-in-place row
 * and the hover ⋯ menu. The rail's chat rows and the My courses page's folder
 * and course cards both maintain their entries through them, so a rename or a
 * delete reads and confirms the same way wherever it is done.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * A row being renamed, in place.
 *
 * The row you are editing IS the row you were looking at: same height, same
 * indent, same type — a dialog would move the name somewhere else to change it,
 * and at rail width there is nothing a dialog could show that the row cannot.
 * Enter commits, Escape leaves the name alone, and a refusal from the server
 * (a duplicate folder name, a course that is not yours) is shown under the row
 * with the input still holding what was typed, so it can be fixed rather than
 * retyped.
 *
 * `onSubmit` returns the message to show, or null when the rename landed.
 */
export function InlineNameRow({
  testId,
  initialName,
  placeholder,
  ariaLabel,
  maxLength,
  leading,
  inputClassName,
  className,
  allowEmpty = false,
  onSubmit,
  onClose,
}: {
  readonly testId: string;
  readonly initialName: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly maxLength: number;
  /** Glyphs the row carries before the name, so the input lines up with it. */
  readonly leading?: ReactNode;
  readonly inputClassName?: string;
  /** Replaces the rail row's own frame, for a host that is not a rail row. */
  readonly className?: string;
  /**
   * An empty box is a legal answer. False for a folder or a course, whose names
   * are required; true for a chat, where clearing the box drops the override
   * and the title goes back to being derived from the first message.
   */
  readonly allowEmpty?: boolean;
  readonly onSubmit: (name: string) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = `${testId}-error`;

  useEffect(() => {
    // Selected, not just focused: renaming usually means replacing.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const message = await onSubmit(name);
      if (message) {
        setError(message);
        return;
      }
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <form
        data-testid={testId}
        className={cn(
          className ?? 'ws-row ws-tree-row',
          'ws-inline-folder flex w-full items-center px-2',
        )}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {leading}
        <input
          ref={inputRef}
          data-testid={`${testId}-input`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            onClose();
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          maxLength={maxLength}
          disabled={submitting}
          className={cn('ws-inline-folder-input min-w-0 flex-1', inputClassName)}
        />
        <button
          type="submit"
          data-testid={`${testId}-confirm`}
          disabled={(!allowEmpty && !name.trim()) || submitting}
          aria-label={t('common.confirm')}
          title={t('common.confirm')}
          className="ws-inline-folder-action"
        >
          <Check className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid={`${testId}-cancel`}
          onClick={onClose}
          disabled={submitting}
          aria-label={t('common.cancel')}
          title={t('common.cancel')}
          className="ws-inline-folder-action"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </form>
      {error ? (
        <p id={errorId} role="alert" className="ws-inline-folder-error pb-1 pr-2 pt-0.5">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The ⋯ shared by every maintainable entry: chat rows in the rail, and the
 * folder and course cards on the My courses page.
 *
 * One menu shape for all of them: rename first (it is
 * the one you press on purpose), then the destructive entry. The delete answers
 * in one of two places — in the menu, as a second press on the same item, or
 * elsewhere entirely (`deleteAsksElsewhere`) when the consequence needs a
 * sentence, as a folder's does.
 */
export function WorkspaceRowMenu({
  testId,
  label,
  onRename,
  extraItems,
  onDelete,
  deleteAsksElsewhere = false,
  triggerClassName,
}: {
  readonly testId: string;
  readonly label: string;
  /** Absent on rows that cannot be renamed (a course somebody else authored). */
  readonly onRename?: () => void;
  /** Entries between rename and delete (a course's "move to folder"). */
  readonly extraItems?: ReactNode;
  readonly onDelete: () => Promise<void> | void;
  /** True when `onDelete` opens its own confirmation instead of deleting. */
  readonly deleteAsksElsewhere?: boolean;
  /** Replaces the rail's trigger styling, for a host drawn differently. */
  readonly triggerClassName?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirming(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label={t('workspace.rowMore', { name: label })}
          title={t('workspace.rowMore', { name: label })}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          className={cn(
            triggerClassName ?? 'ws-row-action',
            'inline-flex size-6 shrink-0 items-center justify-center rounded-md',
          )}
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="pro-popover w-40"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {onRename ? (
          <>
            <DropdownMenuItem
              data-testid={`${testId}-rename`}
              onSelect={() => {
                setOpen(false);
                onRename();
              }}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              {t('classroom.rename')}
            </DropdownMenuItem>
          </>
        ) : null}
        {extraItems}
        {onRename || extraItems ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          data-testid={`${testId}-${confirming ? 'confirm-delete' : 'delete'}`}
          variant="destructive"
          disabled={deleting}
          onSelect={(event) => {
            if (deleteAsksElsewhere) {
              setOpen(false);
              onDelete();
              return;
            }
            if (!confirming) {
              event.preventDefault();
              setConfirming(true);
              return;
            }
            setDeleting(true);
            void Promise.resolve(onDelete()).finally(() => {
              setDeleting(false);
              setOpen(false);
            });
          }}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          {deleting
            ? t('workspace.deleting')
            : confirming
              ? t('workspace.confirmDelete')
              : t('workspace.delete')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
