'use client';

/**
 * The knowledge base page's organizing controls (RFC #1716 §5): the ⋯ menus
 * on a source and on a folder, and the dialogs they open. Every action is
 * one of the shared operations' routes; the page reads the list again after
 * each, whatever the answer, and a refusal stays in its dialog in the
 * server's own terms, never as a success.
 */
import { useRef, useState, type ReactNode } from 'react';
import {
  Download,
  ExternalLink,
  FileText,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MaterialLibraryRequestError } from '@/lib/workbench/material-library-client';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Where the focus goes when a dialog closes. The page opens them by state, not
 * from a Radix trigger, so Radix has nothing to give it back to; the page knows
 * the control each was opened from.
 */
type ReturnFocus = (event: Event) => void;

/** One item of a ⋯ menu. */
export interface LibraryMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** Given the ⋯ button, for a dialog to give the focus back to. */
  readonly onSelect: (trigger: HTMLElement | null) => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** A link instead of an action: opened in a new tab. */
  readonly href?: string;
  /**
   * Runs once the menu has closed, and the focus is the action's to place
   * (an edit in place takes it) instead of going back to the ⋯ button.
   */
  readonly afterClose?: boolean;
}

/** A ⋯ button and its menu, for a source or a folder. */
export function LibraryItemMenu({
  testId,
  label,
  items,
}: {
  readonly testId: string;
  /** What the menu is for, as the button announces it. */
  readonly label: string;
  readonly items: readonly LibraryMenuItem[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const afterClose = useRef<(() => void) | null>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-ws-no-drag=""
          ref={trigger}
          type="button"
          data-testid={testId}
          aria-label={label}
          title={label}
          onClick={(event) => event.stopPropagation()}
          className="ws-util-btn inline-flex size-7 shrink-0 items-center justify-center rounded-md"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="pro-popover w-44"
        onCloseAutoFocus={(event) => {
          const run = afterClose.current;
          afterClose.current = null;
          if (!run) return;
          event.preventDefault();
          run();
        }}
      >
        {items.map((item) =>
          item.href ? (
            <DropdownMenuItem key={item.id} asChild onSelect={() => item.onSelect(trigger.current)}>
              <a
                data-testid={`${testId}-${item.id}`}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.icon}
                {item.label}
              </a>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={item.id}
              data-testid={`${testId}-${item.id}`}
              disabled={item.disabled}
              variant={item.destructive ? 'destructive' : 'default'}
              onSelect={() => {
                if (item.afterClose) afterClose.current = () => item.onSelect(trigger.current);
                else item.onSelect(trigger.current);
              }}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const menuIcons = {
  parse: <FileText className="size-3.5" aria-hidden="true" />,
  rename: <Pencil className="size-3.5" aria-hidden="true" />,
  delete: <Trash2 className="size-3.5" aria-hidden="true" />,
  open: <ExternalLink className="size-3.5" aria-hidden="true" />,
  download: <Download className="size-3.5" aria-hidden="true" />,
  chat: <MessageSquarePlus className="size-3.5" aria-hidden="true" />,
};

/**
 * How one delete attempt ended.
 *
 * - `deleted`: a 204 -- or a 404 after an attempt that FAILED: the deletion
 *   can commit and its reply still be lost (a 500), and the retry then finds
 *   nothing left to delete (#1805 review, notes for the confirmation UI).
 * - `gone`: a 404 on the first attempt. It was already deleted, elsewhere;
 *   not something this dialog did, so it is not reported as done.
 * - `notEmpty`: the folder still holds materials. The server decides, not
 *   the count the page shows.
 * - `identity`: the sign-in changed (401/403).
 * - `retry`: anything else -- busy (503), a server error, no answer. The
 *   deletion may or may not have happened; trying again settles it.
 */
export type DeleteOutcome =
  | { readonly outcome: 'deleted' }
  | {
      readonly outcome: 'gone' | 'notEmpty' | 'identity' | 'retry';
      readonly messageKey: string;
    };

export function deleteOutcomeOf(error: unknown, failedBefore: boolean): DeleteOutcome {
  if (error === null) return { outcome: 'deleted' };
  if (error instanceof MaterialLibraryRequestError) {
    if (error.status === 404) {
      return failedBefore
        ? { outcome: 'deleted' }
        : { outcome: 'gone', messageKey: 'workspace.knowledgeBase.error.gone' };
    }
    if (error.reason === 'not_empty') {
      return { outcome: 'notEmpty', messageKey: 'workspace.knowledgeBase.error.notEmpty' };
    }
    if (error.status === 401 || error.status === 403) {
      return { outcome: 'identity', messageKey: 'workspace.knowledgeBase.error.identity' };
    }
    if (error.status === 503) {
      return { outcome: 'retry', messageKey: 'workspace.knowledgeBase.error.busy' };
    }
  }
  return { outcome: 'retry', messageKey: 'workspace.knowledgeBase.error.save' };
}

/**
 * Confirm a deletion, say what it means, and see it through: a failed
 * attempt keeps the dialog open with a retry; a final refusal says why and
 * leaves only "Close". `onSettled` runs after every attempt (the page reads
 * the list again); `onDeleted` only once the deletion is known to be done.
 * Mounted per request (the page keys it).
 */
export function DeleteDialog({
  testId,
  title,
  lines,
  remove,
  onSettled,
  onDeleted,
  onClose,
  returnFocus,
  t,
}: {
  readonly testId: string;
  readonly title: string;
  /** What the deletion means, one sentence per line. */
  readonly lines: readonly string[];
  readonly remove: () => Promise<void>;
  readonly onSettled: () => void;
  readonly onDeleted: () => void;
  readonly onClose: () => void;
  readonly returnFocus: ReturnFocus;
  readonly t: Translate;
}) {
  const [phase, setPhase] = useState<
    | { readonly kind: 'confirm' | 'busy' }
    | { readonly kind: 'retry' | 'final'; readonly messageKey: string }
  >({ kind: 'confirm' });
  const failedBefore = useRef(false);

  const attempt = async () => {
    if (phase.kind === 'busy' || phase.kind === 'final') return;
    setPhase({ kind: 'busy' });
    let error: unknown = null;
    try {
      await remove();
    } catch (caught) {
      error = caught;
    }
    onSettled();
    const result = deleteOutcomeOf(error, failedBefore.current);
    if (result.outcome === 'deleted') {
      onDeleted();
      onClose();
      return;
    }
    if (result.outcome === 'retry') {
      failedBefore.current = true;
      setPhase({ kind: 'retry', messageKey: result.messageKey });
      return;
    }
    setPhase({ kind: 'final', messageKey: result.messageKey });
  };

  const busy = phase.kind === 'busy';
  return (
    <AlertDialog open onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <AlertDialogContent
        data-testid={testId}
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-[420px]"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-1">
              {lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {phase.kind === 'retry' || phase.kind === 'final' ? (
          <p data-testid={`${testId}-message`} role="alert" className="text-[12px] text-red-600">
            {t(phase.messageKey)}
          </p>
        ) : null}
        <AlertDialogFooter>
          {/* Radix's own cancel: it takes the focus when the dialog opens, and
              closes through `onOpenChange` (refused while an attempt runs). */}
          <AlertDialogCancel data-testid={`${testId}-cancel`} disabled={busy}>
            {t(
              phase.kind === 'final'
                ? 'workspace.knowledgeBase.dialog.close'
                : 'workspace.knowledgeBase.dialog.cancel',
            )}
          </AlertDialogCancel>
          {phase.kind === 'final' ? null : (
            <Button
              type="button"
              variant="destructive"
              data-testid={`${testId}-confirm`}
              disabled={busy}
              onClick={() => void attempt()}
            >
              {t(
                phase.kind === 'retry'
                  ? 'workspace.knowledgeBase.retry'
                  : 'workspace.knowledgeBase.actions.delete',
              )}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One file of a batch deletion, as it was named when the teacher confirmed. */
export interface BatchDeleteItem {
  readonly materialId: string;
  readonly name: string;
}

/**
 * Confirm deleting the selected files, naming each, and delete them one by
 * one through the single-source route: each deletion is its own, so some can
 * succeed while others fail. The list is fixed when the dialog opens; nothing
 * selected later joins it. Afterwards the dialog says how many were deleted
 * and which were not, and why, across every pass: "Retry" asks again only
 * for those that may still go through, and the others keep their result.
 * A 404 is read per file as `deleteOutcomeOf` reads it.
 * `onSettled` runs once after each pass, with the files that are now gone
 * (deleted, or already gone); `onDeleted` once all of them are.
 */
export function BatchDeleteDialog({
  items,
  remove,
  onSettled,
  onDeleted,
  onClose,
  returnFocus,
  t,
}: {
  readonly items: readonly BatchDeleteItem[];
  readonly remove: (materialId: string) => Promise<void>;
  readonly onSettled: (goneIds: readonly string[]) => void;
  readonly onDeleted: () => void;
  readonly onClose: () => void;
  readonly returnFocus: ReturnFocus;
  readonly t: Translate;
}) {
  type Failure = { readonly item: BatchDeleteItem; readonly result: DeleteOutcome };
  const [phase, setPhase] = useState<
    | { readonly kind: 'confirm' | 'busy' }
    | { readonly kind: 'result'; readonly deleted: number; readonly failures: readonly Failure[] }
  >({ kind: 'confirm' });
  /** Files whose earlier attempt may have committed: a 404 now means done. */
  const failedBefore = useRef(new Set<string>());
  /** Each file's latest result, over every pass: a retry replaces only its own. */
  const outcomes = useRef(new Map<string, DeleteOutcome>());

  const attempt = async (batch: readonly BatchDeleteItem[]) => {
    setPhase({ kind: 'busy' });
    const gone: string[] = [];
    let stopped: DeleteOutcome | null = null;
    for (const item of batch) {
      // A changed sign-in refuses every later request too: those are not sent.
      if (stopped) {
        outcomes.current.set(item.materialId, stopped);
        continue;
      }
      let error: unknown = null;
      try {
        await remove(item.materialId);
      } catch (caught) {
        error = caught;
      }
      const result = deleteOutcomeOf(error, failedBefore.current.has(item.materialId));
      outcomes.current.set(item.materialId, result);
      if (result.outcome === 'deleted' || result.outcome === 'gone') gone.push(item.materialId);
      if (result.outcome === 'retry') failedBefore.current.add(item.materialId);
      if (result.outcome === 'identity') stopped = result;
    }
    onSettled(gone);
    // The whole confirmed list decides, not this pass.
    const failures: Failure[] = [];
    let deleted = 0;
    for (const item of items) {
      const result = outcomes.current.get(item.materialId);
      if (result?.outcome === 'deleted') deleted += 1;
      else if (result) failures.push({ item, result });
    }
    if (failures.length === 0) {
      onDeleted();
      onClose();
      return;
    }
    setPhase({ kind: 'result', deleted, failures });
  };

  const busy = phase.kind === 'busy';
  const retryable =
    phase.kind === 'result'
      ? phase.failures.filter((failure) => failure.result.outcome === 'retry')
      : [];
  return (
    <AlertDialog open onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <AlertDialogContent
        data-testid="kb-batch-delete-dialog"
        onCloseAutoFocus={returnFocus}
        className="sm:max-w-[420px]"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('workspace.knowledgeBase.delete.batchTitle', { count: items.length })}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-1">
              <p>{t('workspace.knowledgeBase.delete.batchLinks')}</p>
              <p>{t('workspace.knowledgeBase.delete.batchPartial')}</p>
              <p>{t('workspace.knowledgeBase.delete.materialCourses')}</p>
              <p>{t('workspace.knowledgeBase.delete.cannotUndo')}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {phase.kind === 'result' ? (
          <div data-testid="kb-batch-delete-dialog-result" role="alert" className="text-[12px]">
            <p className="text-red-600">
              {t('workspace.knowledgeBase.delete.batchResult', {
                deleted: phase.deleted,
                total: items.length,
              })}
            </p>
            <ul className="mt-1 max-h-40 overflow-y-auto">
              {phase.failures.map(({ item, result }) => (
                <li
                  key={item.materialId}
                  data-testid={`kb-batch-delete-failed-${item.materialId}`}
                  className="break-words"
                >
                  {item.name}
                  {' · '}
                  {result.outcome === 'deleted' ? null : t(result.messageKey)}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ul
            data-testid="kb-batch-delete-dialog-items"
            aria-label={t('workspace.knowledgeBase.delete.batchTitle', { count: items.length })}
            className="max-h-40 overflow-y-auto rounded-md border px-3 py-2 text-[13px]"
          >
            {items.map((item) => (
              <li key={item.materialId} className="break-words">
                {item.name}
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="kb-batch-delete-dialog-cancel" disabled={busy}>
            {t(
              phase.kind === 'result'
                ? 'workspace.knowledgeBase.dialog.close'
                : 'workspace.knowledgeBase.dialog.cancel',
            )}
          </AlertDialogCancel>
          {phase.kind === 'result' && retryable.length === 0 ? null : (
            <Button
              type="button"
              variant="destructive"
              data-testid="kb-batch-delete-dialog-confirm"
              disabled={busy}
              onClick={() =>
                void attempt(
                  phase.kind === 'result' ? retryable.map((failure) => failure.item) : items,
                )
              }
            >
              {t(
                phase.kind === 'result'
                  ? 'workspace.knowledgeBase.retry'
                  : 'workspace.knowledgeBase.actions.delete',
              )}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
