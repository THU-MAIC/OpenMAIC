'use client';

/**
 * The knowledge base page (RFC #1716 §7): the material library, opened from
 * the foot of the rail, filling the main area. In the UI it is the Knowledge
 * base; code and APIs keep "material library" (§10).
 *
 * The shell mounts it only while `?view=library` is set and keeps the
 * conversation and classroom panes mounted, hidden, underneath it.
 *
 * One file-manager list (#1835 review): folders first, then the files in no
 * folder; a folder expands in place, one level deep, and pages on its own;
 * with a query, one flat list with each file's folder. A background refresh
 * keeps which folders are open (`useMaterialLibraryTree`). Three regions --
 * the header, the usage and the list -- and, below `md` where the rail is
 * gone, a compact header with the way back.
 *
 * Upload is ingest (§1): a file uploaded here becomes a source in no folder,
 * through the same request and admission as the composer's paperclip, but
 * without the composer's per-message cap -- that bounds one message's picks,
 * not the library, whose limits the server enforces.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  Info,
  LoaderCircle,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { MaterialExtractionReasonCode } from '@/lib/types/material-extraction-failure';
import { MEDIA_MAX_DURATION_SEC } from '@/lib/types/media-limits';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  createLibraryFolder,
  deleteLibraryFolder,
  deleteLibraryMaterial,
  formatMaterialBytes,
  MATERIAL_NAME_MAX_LENGTH,
  materialLibraryErrorKey,
  materialLibraryWriteErrorKey,
  moveLibraryMaterials,
  parseLibraryMaterial,
  renameLibraryFolder,
  renameLibraryMaterial,
  stagedMaterialOfView,
  type LibraryFolder,
  type LibraryLimits,
  type LibraryMaterial,
  type MaterialExtractionStatus,
} from '@/lib/workbench/material-library-client';
import {
  useMaterialLibraryTree,
  type LibraryNodeKey,
  type LibraryNodeView,
  type MaterialLibraryTree,
} from '@/lib/workbench/use-material-library-tree';
import { validateFolderName } from '@/lib/utils/folder-name-validation';
import {
  DeleteDialog,
  LibraryItemMenu,
  menuIcons,
  MoveDialog,
  type LibraryMenuItem,
} from './MaterialLibraryDialogs';
import { WORKBENCH_MATERIAL_ACCEPT } from '@/lib/workbench/material-upload-policy';
import {
  createMaterialUploadIdentityGate,
  retryMaterialUpload,
  scheduleMaterialUploadBatch,
  type MaterialUploadIdentityGate,
} from '@/lib/workbench/material-upload-scheduling';
import {
  uploadWorkbenchMaterial,
  WorkbenchMaterialUploadError,
  type WorkbenchMaterial,
} from '@/lib/workbench/session-store';

/** How long typing settles before the listing is asked again. */
const QUERY_DEBOUNCE_MS = 300;

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The RFC #1716 §1 label for a source's extraction state. */
export function extractionLabelKey(status: MaterialExtractionStatus): string {
  switch (status) {
    case 'pending':
    case 'running':
      return 'workspace.knowledgeBase.status.parsing';
    case 'done':
      return 'workspace.knowledgeBase.status.searchable';
    case 'failed':
      return 'workspace.knowledgeBase.status.failed';
    default:
      return 'workspace.knowledgeBase.status.stored';
  }
}

/** A day for the "Date" column: month and day this year, the year too otherwise. */
export function formatLibraryDate(value: number | string | undefined, locale: string): string {
  if (value === undefined || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const thisYear = date.getFullYear() === new Date().getFullYear();
  try {
    return new Intl.DateTimeFormat(
      locale,
      thisYear
        ? { month: '2-digit', day: '2-digit' }
        : { year: 'numeric', month: '2-digit', day: '2-digit' },
    ).format(date);
  } catch {
    return date.toISOString().slice(thisYear ? 5 : 0, 10);
  }
}

const parsing = (status: MaterialExtractionStatus) => status === 'pending' || status === 'running';

/**
 * One icon set for the list (#1835 review §2): chevrons, folders and files
 * share a size, a stroke and a colour, so a row's slots line up.
 */
const ROW_ICON = {
  className: 'size-4 shrink-0 text-[color:var(--ws-ink-mute)]',
  strokeWidth: 1.75,
  'aria-hidden': true,
} as const;

/** The chevron slot every row keeps: a folder's chevron, empty on a file. */
function RowChevron({ open }: { readonly open?: boolean }) {
  if (open === undefined) return <span className="size-4 shrink-0" aria-hidden="true" />;
  return open ? <ChevronDown {...ROW_ICON} /> : <ChevronRight {...ROW_ICON} />;
}

function MaterialIcon({ mime }: { readonly mime?: string }) {
  if (mime?.startsWith('image/')) return <FileImage {...ROW_ICON} />;
  if (mime?.startsWith('audio/')) return <FileAudio {...ROW_ICON} />;
  if (mime?.startsWith('video/')) return <FileVideo {...ROW_ICON} />;
  if (mime?.startsWith('text/') || mime === 'application/pdf' || mime?.includes('document')) {
    return <FileText {...ROW_ICON} />;
  }
  return <File {...ROW_ICON} />;
}

const failureCopy: Record<
  MaterialExtractionReasonCode,
  { label: string; description: string; values?: Record<string, unknown> }
> = {
  storage_full: {
    label: 'workspace.knowledgeBase.failure.storage_full.label',
    description: 'workspace.knowledgeBase.failure.storage_full.description',
  },
  source_unavailable: {
    label: 'workspace.knowledgeBase.failure.source_unavailable.label',
    description: 'workspace.knowledgeBase.failure.source_unavailable.description',
  },
  service_unavailable: {
    label: 'workspace.knowledgeBase.failure.service_unavailable.label',
    description: 'workspace.knowledgeBase.failure.service_unavailable.description',
  },
  media_too_long: {
    label: 'workspace.knowledgeBase.failure.media_too_long.label',
    description: 'workspace.knowledgeBase.failure.media_too_long.description',
    // The extractor's own limit, so the explanation cannot drift from it.
    values: { minutes: MEDIA_MAX_DURATION_SEC / 60 },
  },
  no_text_extracted: {
    label: 'workspace.knowledgeBase.failure.no_text_extracted.label',
    description: 'workspace.knowledgeBase.failure.no_text_extracted.description',
  },
  processing_interrupted: {
    label: 'workspace.knowledgeBase.failure.processing_interrupted.label',
    description: 'workspace.knowledgeBase.failure.processing_interrupted.description',
  },
};

/** Only known reasons get a user explanation; diagnostic text never enters the row. */
function StatusLabel({
  material,
  t,
  testId,
}: {
  readonly material: LibraryMaterial;
  readonly t: Translate;
  readonly testId?: string;
}) {
  const { status, reasonCode } = material.extraction;
  const failure = status === 'failed' && reasonCode ? failureCopy[reasonCode] : undefined;
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1 text-[12px]',
        status === 'failed'
          ? 'text-[color:var(--ws-fail)]'
          : status === 'done'
            ? 'text-[color:var(--ws-ink-soft)]'
            : 'text-[color:var(--ws-ink-mute)]',
      )}
    >
      {parsing(status) ? (
        <LoaderCircle
          data-testid={testId ? `${testId}-spinner` : undefined}
          className="size-3 shrink-0 animate-spin"
          aria-hidden="true"
        />
      ) : null}
      {t(failure ? failure.label : extractionLabelKey(status))}
      {failure ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t('workspace.knowledgeBase.failure.more', { reason: t(failure.label) })}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <Info className="size-3.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            aria-label={t(failure.label)}
            className="max-w-[calc(100vw-2rem)] text-sm"
            collisionPadding={16}
          >
            {t(failure.description, failure.values)}
          </PopoverContent>
        </Popover>
      ) : null}
    </span>
  );
}

/**
 * One group (#1835 review §2): "Used 781.7 KB of 2 GB · 1 of 100 files" and a
 * short bar beside it. The pool quota is not shown.
 */
function Usage({
  limits,
  locale,
  t,
}: {
  readonly limits: LibraryLimits;
  readonly locale: string;
  readonly t: Translate;
}) {
  const share =
    limits.maxTotalBytes > 0
      ? Math.min(1, Math.max(0, limits.usedBytes / limits.maxTotalBytes))
      : 0;
  const summary = t('workspace.knowledgeBase.usage.summary', {
    used: formatMaterialBytes(limits.usedBytes, locale),
    max: formatMaterialBytes(limits.maxTotalBytes, locale),
    count: limits.usedCount,
    maxCount: limits.maxCount,
  });
  return (
    <div
      data-testid="kb-usage"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[color:var(--ws-ink-soft)]"
    >
      <span data-testid="kb-usage-summary">{summary}</span>
      <div
        role="progressbar"
        aria-label={summary}
        aria-valuemin={0}
        aria-valuemax={limits.maxTotalBytes}
        aria-valuenow={limits.usedBytes}
        data-testid="kb-usage-bar"
        className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-[color:var(--ws-tint-strong)]"
      >
        <div
          className="h-full rounded-full bg-[color:var(--ws-accent)]"
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

interface UploadEntry {
  readonly id: string;
  readonly name: string;
  /** Why it failed; absent while it is still uploading. */
  readonly error?: string;
}

/**
 * The page's own uploads: each file is a row until it is stored (then the
 * listing shows it) or fails (then the row says why, until dismissed). Either
 * way the list is read again once the file is done.
 * Uploads are not cancelled by leaving the page; their rows go with it.
 */
function useLibraryUploads(onUploaded: () => void) {
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState<readonly UploadEntry[]>([]);
  const gate = useRef<MaterialUploadIdentityGate | null>(null);
  const sequence = useRef(0);

  const start = (files: readonly File[]) => {
    if (files.length === 0) return;
    // The first upload of a fresh identity waits for its cookie (see
    // `scheduleMaterialUploadBatch`), exactly as the composer's do.
    gate.current ??= createMaterialUploadIdentityGate();
    const jobs = files.map((file) => ({
      file,
      entry: { id: `upload-${(sequence.current += 1)}`, name: file.name },
    }));
    setEntries((current) => [...current, ...jobs.map((job) => job.entry)]);
    void scheduleMaterialUploadBatch(gate.current, jobs, async ({ file, entry }) => {
      try {
        await retryMaterialUpload(() => uploadWorkbenchMaterial(file));
        setEntries((current) => current.filter((item) => item.id !== entry.id));
        return true;
      } catch (error) {
        const message =
          error instanceof WorkbenchMaterialUploadError
            ? error.userMessage(t, locale)
            : error instanceof Error
              ? error.message
              : t('workbench.material.uploadFailed', { name: file.name });
        setEntries((current) =>
          current.map((item) => (item.id === entry.id ? { ...item, error: message } : item)),
        );
        return false;
      } finally {
        // Once per file, after its last attempt (the 503 retries are inside
        // `retryMaterialUpload`), whatever the answer: a failed answer can
        // still follow a stored file -- the publication committed, then the
        // reply was lost -- and only the listing can say which.
        onUploaded();
      }
    });
  };

  return {
    entries,
    pending: entries.some((entry) => entry.error === undefined),
    start,
    dismiss: (id: string) => setEntries((current) => current.filter((item) => item.id !== id)),
  };
}

/** The default name of a new folder, numbered when the folders shown already have it. */
export function newFolderName(base: string, folders: readonly LibraryFolder[]): string {
  // The server's comparison (the folders' normalized name); it stays the authority.
  const taken = new Set(folders.map((folder) => folder.name.toLocaleLowerCase('en-US')));
  if (!taken.has(base.toLocaleLowerCase('en-US'))) return base;
  for (let number = 2; ; number += 1) {
    const name = `${base} ${number}`;
    if (!taken.has(name.toLocaleLowerCase('en-US'))) return name;
  }
}

/** Where a file's name stops before its extension, for selecting it. */
const nameStemEnd = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
};

/** How an edit in place asked to be saved. */
type CommitCause = 'enter' | 'blur';

/**
 * A name edited in place, in its row (#1835 review §1): Enter or leaving the
 * field saves, Escape cancels. One edit asks once: the blur after Enter or
 * Escape, or while the answer is awaited, asks nothing, and the Enter that
 * ends an input method's composition belongs to the composition. What was
 * typed stays the field's own; an answer never rewrites it.
 */
function InlineName({
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

/**
 * Rows share one grid once the list itself is wide enough -- a container
 * query, not the window: the rail and the page's padding take their share,
 * so a 768 px window leaves the list far narrower than `md` implies. Below it
 * a row is the name with the state, size and date under it, and the ⋯
 * beside. The menu is the last child either way, so each row has one. A
 * search has one column more, so it waits for a wider list.
 */
/**
 * The column names stay at the top of the page's scroller while a long list
 * scrolls under them (#1835 review §6), on an opaque ground (the surface
 * over the canvas) so no row shows through. Only the grid has them: below
 * it each row says what it is, and nothing sticks.
 */
const STICKY_HEADER =
  'sticky top-0 z-10 hidden border-b border-[color:var(--ws-line)] [background:linear-gradient(var(--ws-surface),var(--ws-surface)),var(--ws-canvas-top)] px-3 py-2 text-[11px] text-[color:var(--ws-ink-mute)]';

const LAYOUT = {
  tree: {
    row: 'flex min-w-0 items-start gap-2 px-3 py-1.5 @2xl:grid @2xl:items-center @2xl:gap-3',
    columns: '@2xl:grid-cols-[minmax(0,1fr)_9rem_5.5rem_5.5rem_2rem]',
    cell: 'hidden truncate text-[12px] text-[color:var(--ws-ink-soft)] @2xl:block',
    narrowOnly: '@2xl:hidden',
    wideOnly: 'hidden @2xl:block',
    menu: 'ws-kb-row-menu shrink-0 @2xl:flex @2xl:justify-end',
    /** A folder's name takes the status column too; its count is in Size. */
    nameSpan: '@2xl:col-span-2',
    header: `${STICKY_HEADER} @2xl:grid @2xl:gap-3`,
  },
  search: {
    row: 'flex min-w-0 items-start gap-2 px-3 py-1.5 @3xl:grid @3xl:items-center @3xl:gap-3',
    columns: '@3xl:grid-cols-[minmax(0,1fr)_9rem_9rem_5.5rem_5.5rem_2rem]',
    cell: 'hidden truncate text-[12px] text-[color:var(--ws-ink-soft)] @3xl:block',
    narrowOnly: '@3xl:hidden',
    wideOnly: 'hidden @3xl:block',
    menu: 'ws-kb-row-menu shrink-0 @3xl:flex @3xl:justify-end',
    header: `${STICKY_HEADER} @3xl:grid @3xl:gap-3`,
  },
} as const;

export function MaterialLibraryPage({
  onChatWithMaterial,
  onLeave,
}: {
  /** Start a conversation with this source staged (the shell decides where). */
  readonly onChatWithMaterial: (material: WorkbenchMaterial) => void;
  /** Leave the page for what it covers (the compact header's way back). */
  readonly onLeave: () => void;
}) {
  const { t, locale } = useI18n();
  const [queryInput, setQueryInput] = useState('');
  /** The query the list is read for: settled while typing, cleared at once. */
  const [query, setQuery] = useState('');
  useEffect(() => {
    const value = queryInput.trim();
    if (!value) return;
    const timer = setTimeout(() => setQuery(value), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [queryInput]);
  const changeQuery = (value: string) => {
    setQueryInput(value);
    if (!value.trim()) setQuery('');
  };

  const fileInput = useRef<HTMLInputElement>(null);
  // The page's own changes read the list again (§7) -- but only while the
  // page is still there: an upload or a write can answer after the teacher
  // left, and then there is nothing to refresh.
  const reloadIfMounted = useRef<MaterialLibraryTree['reload']>(() => {});
  const uploads = useLibraryUploads(() => reloadIfMounted.current());
  const tree = useMaterialLibraryTree({ query, uploading: uploads.pending });
  useEffect(() => {
    reloadIfMounted.current = tree.reload;
    return () => {
      reloadIfMounted.current = () => {};
    };
  }, [tree.reload]);
  const limitsId = useId();

  // ── Focus ───────────────────────────────────────────────────────────
  // The control a dialog was opened from: the focus goes back to it when the
  // dialog closes, or to the heading once it is gone with its item -- at once
  // for a deletion, or when the list read after the change drops it (a source
  // moved out of an expanded folder, renamed out of the search).
  const opener = useRef<HTMLElement | null>(null);
  const returnedTo = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const openFrom = (open: () => void) => (trigger: HTMLElement | null) => {
    opener.current = trigger;
    open();
  };
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) {
      target.focus();
      returnedTo.current = target;
    } else {
      heading.current?.focus();
    }
  };
  /**
   * A folder just created, to show once the list has it: the focus goes to
   * it when its row appears, only if the teacher has not moved on meanwhile
   * -- the focus is still on the new-folder row, or nowhere (the row just
   * closed). A taken name is not a creation: nothing is pointed at.
   */
  const reveal = useRef<{ readonly folderId: string | null } | null>(null);
  useEffect(() => {
    // Stop following this creation once focus leaves its row, even if that
    // other control later disappears and focus returns to the body.
    const movedOn = (event: FocusEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest('[data-testid="kb-new-folder-row"]')
      ) {
        reveal.current = null;
      }
    };
    document.addEventListener('focusin', movedOn);
    return () => {
      document.removeEventListener('focusin', movedOn);
      reveal.current = null;
    };
  }, []);
  const folderToggle = (folderId: string) =>
    list.current?.querySelector<HTMLElement>(`[data-testid="kb-folder-toggle-${folderId}"]`) ??
    null;
  const focusIsFree = () => {
    const active = document.activeElement;
    return (
      active === null ||
      active === document.body ||
      (active instanceof Element && active.closest('[data-testid="kb-new-folder-row"]') !== null)
    );
  };
  const revealArrived = () => {
    const pending = reveal.current;
    if (!pending || !pending.folderId) return;
    if (!focusIsFree()) {
      // The teacher went elsewhere (typed a search, opened something): drop it.
      reveal.current = null;
      return;
    }
    const toggle = folderToggle(pending.folderId);
    if (!toggle) return;
    reveal.current = null;
    toggle.scrollIntoView?.({ block: 'nearest' });
    toggle.focus();
  };
  /** The row control an ended edit gives the focus back to, once rendered. */
  const editHome = useRef<string | null>(null);
  /** A ⋯ followed to its file's new row (Remove from folder), not to the heading. */
  const followsItsFile = useRef<HTMLElement | null>(null);
  useEffect(() => {
    revealArrived();
    const home = editHome.current;
    editHome.current = null;
    const back = home ? list.current?.querySelector<HTMLElement>(`[data-testid="${home}"]`) : null;
    if (back && (document.activeElement === null || document.activeElement === document.body)) {
      back.focus();
      // Followed like a dialog's opener: gone with its row, the heading takes it.
      returnedTo.current = back;
    }
    const target = returnedTo.current;
    if (!target) return;
    if (target.isConnected) {
      // The teacher moved on: stop following it.
      if (document.activeElement !== target) returnedTo.current = null;
      return;
    }
    returnedTo.current = null;
    const follow = followsItsFile.current === target;
    followsItsFile.current = null;
    if (document.activeElement === null || document.activeElement === document.body) {
      // A file taken out of its folder: the same ⋯ in its new row. Anything
      // else whose row left the view: the heading.
      const again =
        follow && target.dataset.testid
          ? list.current?.querySelector<HTMLElement>(`[data-testid="${target.dataset.testid}"]`)
          : null;
      (again ?? heading.current)?.focus();
    }
  });

  // ── Scroll position ─────────────────────────────────────────────────
  // A refresh that adds or drops rows above the viewport must not move what
  // the teacher is looking at. Native scroll anchoring differs across engines,
  // so the page anchors by hand and turns the native one off:
  // the first row in view is remembered with its offset, and after each
  // render the scroll moves by however far that row went.
  const scroller = useRef<HTMLElement>(null);
  const scrollAnchor = useRef<{ readonly row: Element; readonly top: number } | null>(null);
  const rememberScrollAnchor = () => {
    const main = scroller.current;
    const rows = list.current;
    if (!main || !rows || main.scrollTop <= 0) {
      // At the very top there is nothing to hold: new rows above show.
      scrollAnchor.current = null;
      return;
    }
    const viewTop = main.getBoundingClientRect().top;
    for (const row of rows.querySelectorAll('[data-kb-row]')) {
      const box = row.getBoundingClientRect();
      if (box.bottom > viewTop) {
        scrollAnchor.current = { row, top: box.top - viewTop };
        return;
      }
    }
    scrollAnchor.current = null;
  };
  useEffect(() => {
    const main = scroller.current;
    if (!main) return;
    main.addEventListener('scroll', rememberScrollAnchor, { passive: true });
    return () => main.removeEventListener('scroll', rememberScrollAnchor);
    // The listener reads refs only.
  }, []);
  useLayoutEffect(() => {
    const main = scroller.current;
    const held = scrollAnchor.current;
    if (main && held?.row.isConnected) {
      const moved =
        held.row.getBoundingClientRect().top - main.getBoundingClientRect().top - held.top;
      if (moved !== 0) main.scrollTop += moved;
    }
    rememberScrollAnchor();
  });

  // ── New folder, in a row of the list ────────────────────────────────
  const newFolderButton = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState<{
    /** One per draft: an answer is only its own draft's. */
    readonly id: number;
    readonly name: string;
    readonly error: string | null;
    readonly busy: boolean;
  } | null>(null);
  const creationSeq = useRef(0);
  const startCreating = () => {
    // One creation at a time: the row is busy until the server answers.
    if (creating?.busy) return;
    reveal.current = null;
    // A folder goes into the tree: leave a search for it, by the teacher's hand.
    changeQuery('');
    creationSeq.current += 1;
    setCreating({
      id: creationSeq.current,
      name: newFolderName(t('workspace.knowledgeBase.folder.new'), tree.folders),
      error: null,
      busy: false,
    });
  };
  const cancelCreating = (focusBack: boolean) => {
    reveal.current = null;
    setCreating(null);
    if (focusBack) newFolderButton.current?.focus();
  };
  const checkFolderName = (name: string) => {
    const checked = validateFolderName(name);
    if (checked.ok) return null;
    return checked.kind === 'empty'
      ? 'workspace.knowledgeBase.error.folderNameEmpty'
      : 'workspace.knowledgeBase.error.folderNameTooLong';
  };
  const commitCreating = async (typed: string, cause: CommitCause) => {
    const draft = creating;
    if (!draft || draft.busy) return;
    const name = typed.trim();
    // An empty name cancels, as Escape does.
    if (!name) return cancelCreating(cause === 'enter');
    const hint = checkFolderName(name);
    if (hint) {
      setCreating({ ...draft, error: hint });
      return;
    }
    const own = (change: (current: NonNullable<typeof creating>) => typeof creating) =>
      setCreating((current) => (current?.id === draft.id ? change(current) : current));
    // Left by a blur, the teacher has moved on (WebKit leaves a click's focus
    // on the body): only an Enter's creation takes the focus to its row.
    reveal.current = cause === 'enter' ? { folderId: null } : null;
    setCreating({ ...draft, busy: true, error: null });
    try {
      const { folderId, created } = await createLibraryFolder(name);
      if (created) {
        own(() => null);
        if (reveal.current) reveal.current = { folderId };
      } else {
        // That name is taken: the edit stays, saying so; the folder it names is not shown.
        reveal.current = null;
        own((current) => ({
          ...current,
          busy: false,
          error: 'workspace.knowledgeBase.error.nameTaken',
        }));
      }
    } catch (error) {
      reveal.current = null;
      own((current) => ({ ...current, busy: false, error: materialLibraryWriteErrorKey(error) }));
    } finally {
      reloadIfMounted.current();
    }
  };

  // ── Organizing (RFC #1716 §5) ───────────────────────────────────────
  const [moving, setMoving] = useState<LibraryMaterial | null>(null);
  // Deletion is page-only, after confirmation (RFC #1716 §5, §4).
  type DeleteRequest =
    | { readonly kind: 'material'; readonly material: LibraryMaterial }
    | { readonly kind: 'folder'; readonly folder: LibraryFolder };
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null);

  /** One write; the list is read again whatever it answered (§7). */
  const write = async (
    action: () => Promise<void>,
    options?: { readonly retryRefreshOnSuccess?: boolean },
  ): Promise<string | null> => {
    let succeeded = false;
    try {
      await action();
      succeeded = true;
      return null;
    } catch (error) {
      return materialLibraryWriteErrorKey(error);
    } finally {
      reloadIfMounted.current({ retryOnError: succeeded && options?.retryRefreshOnSuccess });
    }
  };
  const checkMaterialName = (name: string) => {
    const trimmed = name.trim();
    return trimmed.length === 0 || trimmed.length > MATERIAL_NAME_MAX_LENGTH
      ? 'workspace.knowledgeBase.error.invalidName'
      : null;
  };

  // ── Renaming, in place ──────────────────────────────────────────────
  interface Renaming {
    /** One per edit: an answer is only its own edit's. */
    readonly id: number;
    readonly kind: 'material' | 'folder';
    readonly targetId: string;
    /** The name when the edit began. */
    readonly name: string;
    /**
     * What is typed so far. The page keeps it, not the field: a run moving
     * the file between shown lists (the top level, an open folder) mounts
     * its row, and the field, anew.
     */
    readonly draft: string;
    /** Where the caret or selection was in it, once the field reported it. */
    readonly caret: readonly [number, number] | null;
    /** The field had the focus: a new row takes it again; one the teacher left, not. */
    readonly focused: boolean;
    /** How the attempt being answered was asked (an Enter's refusal takes the focus back). */
    readonly cause: CommitCause | null;
    /** The view the row was in: the tree or the results. */
    readonly mode: MaterialLibraryTree['mode'];
    readonly busy: boolean;
    readonly error: string | null;
  }
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const renamingNow = useRef<number | null>(null);
  const renameSeq = useRef(0);
  const startRenaming = (kind: Renaming['kind'], targetId: string, name: string) => {
    renameSeq.current += 1;
    renamingNow.current = renameSeq.current;
    setRenaming({
      id: renameSeq.current,
      kind,
      targetId,
      name,
      draft: name,
      caret: null,
      focused: true,
      cause: null,
      mode: tree.mode,
      busy: false,
      error: null,
    });
  };
  const ownRename = (id: number, change: (current: Renaming) => Renaming | null) =>
    setRenaming((current) => (current?.id === id ? change(current) : current));
  /** The focus is the edit's to place: still in its field, or nowhere. */
  const focusInEdit = () => {
    const active = document.activeElement;
    return (
      active === null ||
      active === document.body ||
      (active instanceof HTMLElement && active.dataset.kbInlineName !== undefined)
    );
  };
  const endRenaming = (edit: Renaming, focusBack: boolean) => {
    if (renamingNow.current === edit.id) renamingNow.current = null;
    ownRename(edit.id, () => null);
    // Back to the row: a folder's toggle, a file's ⋯.
    if (focusBack) {
      editHome.current =
        edit.kind === 'folder'
          ? `kb-folder-toggle-${edit.targetId}`
          : `kb-material-menu-${edit.targetId}`;
    }
  };
  const commitRenaming = async (edit: Renaming, typed: string, cause: CommitCause) => {
    if (edit.busy) return;
    const name = typed.trim();
    // An empty or unchanged name asks nothing.
    if (!name || name === edit.name) return endRenaming(edit, cause === 'enter');
    // Files may share a name (several versions of a handout); folders are the server's to refuse.
    const hint = edit.kind === 'material' ? checkMaterialName(name) : checkFolderName(name);
    if (hint) {
      ownRename(edit.id, (current) => ({ ...current, error: hint }));
      return;
    }
    ownRename(edit.id, (current) => ({ ...current, busy: true, error: null, cause }));
    const refusal = await write(() =>
      edit.kind === 'material'
        ? renameLibraryMaterial(edit.targetId, name)
        : renameLibraryFolder(edit.targetId, name),
    );
    if (renamingNow.current !== edit.id) {
      // A newer edit took over: it stays as it is; a refusal is still said.
      if (refusal) toast.error(t(refusal));
      return;
    }
    if (refusal) ownRename(edit.id, (current) => ({ ...current, busy: false, error: refusal }));
    else endRenaming(edit, cause === 'enter' && focusInEdit());
  };
  // The edited row is no longer shown: the edit ends. Only a folder gone
  // from the folders (all of them are listed) is said to be gone; a file can
  // leave its view without being deleted (moved into a closed folder, the
  // search typed or cleared), and a rename answered 404 says so itself. While
  // an answer is awaited, that answer decides.
  useEffect(() => {
    if (!renaming) return;
    const end = () => {
      renamingNow.current = null;
      setRenaming(null);
    };
    if (renaming.mode !== tree.mode) return end();
    if (renaming.busy) return;
    if (renaming.kind === 'folder') {
      if (tree.folders.some((folder) => folder.id === renaming.targetId)) return;
      end();
      toast.error(t('workspace.knowledgeBase.error.gone'));
      return;
    }
    const nodes =
      tree.mode === 'search'
        ? [tree.results]
        : [tree.root, ...tree.expanded.map((id) => tree.folder(id))];
    if (
      nodes.some((node) =>
        node?.files.some((material) => material.materialId === renaming.targetId),
      )
    ) {
      return;
    }
    end();
  }, [renaming, tree, t]);
  const renameField = (edit: Renaming, label: string, selectEnd?: number) => (
    <InlineName
      key={edit.id}
      testId="kb-rename-input"
      errorTestId="kb-rename-error"
      label={label}
      initialName={edit.draft}
      // At first the name (a file's up to its extension); in a new row, the
      // caret or selection where it was, so typing goes on where it left off.
      selection={edit.caret ?? [0, selectEnd ?? edit.name.length]}
      maxLength={edit.kind === 'material' ? MATERIAL_NAME_MAX_LENGTH : undefined}
      busy={edit.busy}
      error={edit.error ? t(edit.error) : null}
      onEdit={(value) =>
        ownRename(edit.id, (current) => ({ ...current, draft: value, error: null }))
      }
      onCaret={(caret) => ownRename(edit.id, (current) => ({ ...current, caret }))}
      onFocusChange={(focused) =>
        ownRename(edit.id, (current) =>
          current.focused === focused ? current : { ...current, focused },
        )
      }
      takeFocus={edit.focused}
      cause={edit.cause ?? undefined}
      onCommit={(name, cause) => void commitRenaming(edit, name, cause)}
      onCancel={() => endRenaming(edit, true)}
    />
  );

  /** Sources being taken out of their folder: one request each, however often it is chosen. */
  const removing = useRef(new Set<string>());
  const removeFromFolder = (material: LibraryMaterial, trigger: HTMLElement | null) => {
    if (removing.current.has(material.materialId)) return;
    removing.current.add(material.materialId);
    // Run once the menu has closed: the ⋯ gets the focus here, before the
    // list can move its row, and once it does the focus follows the file to
    // its new row (or goes to the heading) -- unless the teacher moved it on.
    if (trigger?.isConnected) {
      trigger.focus();
      returnedTo.current = trigger;
      followsItsFile.current = trigger;
    }
    void write(() => moveLibraryMaterials([material.materialId], null)).then((error) => {
      removing.current.delete(material.materialId);
      if (error) toast.error(t(error));
    });
  };

  const materialMenu = (material: LibraryMaterial) => {
    const items: LibraryMenuItem[] = [
      ...(material.extraction.status === 'idle' || material.extraction.status === 'failed'
        ? [
            {
              id: 'parse',
              label: t(
                material.extraction.status === 'failed'
                  ? 'workspace.knowledgeBase.actions.reparse'
                  : 'workspace.knowledgeBase.actions.parse',
              ),
              icon: menuIcons.parse,
              onSelect: openFrom(() => {
                // The menu itself restores its trigger; keep the existing refresh fallback.
                returnedTo.current = opener.current;
                opener.current = null;
                void write(() => parseLibraryMaterial(material.materialId), {
                  retryRefreshOnSuccess: true,
                }).then((error) => {
                  if (error) toast.error(t(error));
                });
              }),
            },
          ]
        : []),
      {
        // Inline types open in the tab; everything else downloads. The view's
        // `opensInline` is the route's own decision; without it, Download.
        id: 'open',
        label: t(
          material.opensInline
            ? 'workspace.knowledgeBase.actions.open'
            : 'workspace.knowledgeBase.actions.downloadOriginal',
        ),
        icon: material.opensInline ? menuIcons.open : menuIcons.download,
        href: `/api/materials/${encodeURIComponent(material.materialId)}/original`,
        onSelect: () => {},
      },
      {
        id: 'chat',
        label: t('workspace.knowledgeBase.actions.chat'),
        icon: menuIcons.chat,
        onSelect: () => onChatWithMaterial(stagedMaterialOfView(material)),
      },
      {
        id: 'rename',
        label: t('workspace.knowledgeBase.actions.rename'),
        icon: menuIcons.rename,
        afterClose: true,
        onSelect: () => startRenaming('material', material.materialId, material.name),
      },
      {
        id: 'move',
        label: t('workspace.knowledgeBase.actions.move'),
        icon: menuIcons.move,
        onSelect: openFrom(() => setMoving(material)),
      },
      // Out of its folder, to the top level (`folderId: null`); Move to… lists folders only.
      ...(material.folderId !== null
        ? [
            {
              id: 'remove-from-folder',
              label: t('workspace.knowledgeBase.actions.removeFromFolder'),
              icon: menuIcons.removeFromFolder,
              afterClose: true,
              onSelect: (trigger: HTMLElement | null) => removeFromFolder(material, trigger),
            },
          ]
        : []),
      {
        id: 'delete',
        label: t('workspace.knowledgeBase.actions.delete'),
        icon: menuIcons.delete,
        destructive: true,
        onSelect: openFrom(() => setDeleting({ kind: 'material', material })),
      },
    ];
    return (
      <LibraryItemMenu
        testId={`kb-material-menu-${material.materialId}`}
        label={t('workspace.knowledgeBase.actions.more', { name: material.name })}
        items={items}
      />
    );
  };
  const folderMenu = (folder: LibraryFolder) => (
    <LibraryItemMenu
      testId={`kb-folder-menu-${folder.id}`}
      label={t('workspace.knowledgeBase.actions.more', { name: folder.name })}
      items={[
        {
          id: 'rename',
          label: t('workspace.knowledgeBase.actions.rename'),
          icon: menuIcons.rename,
          afterClose: true,
          onSelect: () => startRenaming('folder', folder.id, folder.name),
        },
        // Only an empty folder can go (the server still decides).
        ...(folder.materialCount === 0
          ? [
              {
                id: 'delete',
                label: t('workspace.knowledgeBase.actions.delete'),
                icon: menuIcons.delete,
                destructive: true,
                onSelect: openFrom(() => setDeleting({ kind: 'folder', folder })),
              },
            ]
          : []),
      ]}
    />
  );

  // ── Rows ────────────────────────────────────────────────────────────
  /** A file's folder, when it is in one: a top-level file shows nothing (#1835 review §3). */
  const folderName = (material: LibraryMaterial) =>
    material.folderId === null ? null : (material.folderName ?? null);

  const fileRow = (material: LibraryMaterial, options: { nested?: boolean; search?: boolean }) => {
    const layout = options.search ? LAYOUT.search : LAYOUT.tree;
    const size = formatMaterialBytes(material.bytes, locale);
    const date = formatLibraryDate(material.createdAt, locale);
    const edit =
      renaming?.kind === 'material' && renaming.targetId === material.materialId ? renaming : null;
    return (
      <li
        key={material.materialId}
        data-testid={`kb-material-${material.materialId}`}
        data-kb-row=""
        className={cn(layout.row, layout.columns)}
      >
        <div className={cn('flex min-w-0 flex-1 items-start gap-2', options.nested && 'pl-6')}>
          <RowChevron />
          <MaterialIcon mime={material.mime} />
          <div className="min-w-0 flex-1">
            {edit ? (
              renameField(edit, t('workspace.knowledgeBase.actions.rename'), nameStemEnd(edit.name))
            ) : (
              // Double-click the name to rename it; touch screens use the ⋯.
              <span
                className="block break-words text-[13px]"
                title={material.name}
                onDoubleClick={() => startRenaming('material', material.materialId, material.name)}
              >
                {material.name}
              </span>
            )}
            <span
              className={cn(
                'mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[color:var(--ws-ink-mute)]',
                layout.narrowOnly,
              )}
            >
              <StatusLabel material={material} t={t} />
              <span>{size}</span>
              {date ? <span>{date}</span> : null}
              {options.search && folderName(material) ? <span>{folderName(material)}</span> : null}
            </span>
          </div>
        </div>
        {options.search ? <span className={layout.cell}>{folderName(material)}</span> : null}
        <span className={layout.wideOnly}>
          <StatusLabel material={material} t={t} testId={`kb-status-${material.materialId}`} />
        </span>
        <span className={layout.cell}>{size}</span>
        <span className={layout.cell}>{date}</span>
        <span className={layout.menu}>{materialMenu(material)}</span>
      </li>
    );
  };

  const loadMoreRow = (
    node: LibraryNodeView,
    key: LibraryNodeKey,
    testId: string,
    nested = false,
  ) =>
    node.hasMore ? (
      <li className={cn('py-2 pl-9 pr-3', nested && 'pl-15')}>
        <button
          type="button"
          data-testid={testId}
          // One read of the list at a time: not while a refresh rereads it.
          disabled={node.loadingMore || tree.refreshing}
          onClick={() => tree.loadMore(key)}
          className="ws-quiet text-[13px] underline disabled:opacity-60"
        >
          {node.loadingMore
            ? t('workspace.knowledgeBase.loading')
            : t('workspace.knowledgeBase.loadMore')}
        </button>
      </li>
    ) : null;

  const folderRow = (folder: LibraryFolder) => {
    const node = tree.folder(folder.id);
    const open = node !== null;
    const edit = renaming?.kind === 'folder' && renaming.targetId === folder.id ? renaming : null;
    const items = t('workspace.knowledgeBase.folder.items', { count: folder.materialCount });
    const date = formatLibraryDate(folder.updatedAt, locale);
    // Below the grid the count and the date go under the name, as a file's size does.
    const narrowMeta = (
      <span
        className={cn(
          'mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] font-normal text-[color:var(--ws-ink-mute)]',
          LAYOUT.tree.narrowOnly,
        )}
      >
        <span>{items}</span>
        {date ? <span>{date}</span> : null}
      </span>
    );
    return (
      <li key={folder.id} data-testid={`kb-folder-${folder.id}`}>
        <div data-kb-row="" className={cn(LAYOUT.tree.row, LAYOUT.tree.columns)}>
          {/* The toggle and the ⋯ are siblings: choosing from the menu never
              expands or collapses the folder. While the name is edited, the
              row holds the field instead of the toggle. */}
          {edit ? (
            <div
              className={cn(
                'flex min-w-0 flex-1 items-start gap-2 text-[13px] font-medium',
                LAYOUT.tree.nameSpan,
              )}
            >
              <RowChevron open={open} />
              <Folder {...ROW_ICON} />
              {renameField(edit, t('workspace.knowledgeBase.actions.rename'))}
            </div>
          ) : (
            <button
              type="button"
              data-testid={`kb-folder-toggle-${folder.id}`}
              aria-expanded={open}
              // The second click of a double-click renames instead (below).
              onClick={(event) => {
                if (event.detail > 1) return;
                if (open) tree.collapse(folder.id);
                else tree.expand(folder.id);
              }}
              className={cn(
                'flex min-w-0 flex-1 items-start gap-2 rounded-md text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ws-accent)]',
                LAYOUT.tree.nameSpan,
              )}
            >
              <RowChevron open={open} />
              <Folder {...ROW_ICON} />
              <span className="min-w-0 flex-1">
                <span
                  className="block break-words font-medium"
                  onDoubleClick={() => startRenaming('folder', folder.id, folder.name)}
                >
                  {folder.name}
                </span>
                {narrowMeta}
              </span>
            </button>
          )}
          <span data-testid={`kb-folder-items-${folder.id}`} className={LAYOUT.tree.cell}>
            {items}
          </span>
          <span className={LAYOUT.tree.cell}>{date}</span>
          <span className={LAYOUT.tree.menu}>{folderMenu(folder)}</span>
        </div>
        {node ? (
          <ul data-testid={`kb-folder-files-${folder.id}`}>
            {node.status === 'loading' ? (
              <li className="py-2 pl-15 text-[12px] text-[color:var(--ws-ink-mute)]">
                {t('workspace.knowledgeBase.loading')}
              </li>
            ) : node.status === 'error' ? (
              <li className="flex items-center gap-2 py-2 pl-15 text-[12px]" role="alert">
                <span>{t(materialLibraryErrorKey(node.error))}</span>
                <button type="button" onClick={() => tree.reload()} className="ws-quiet underline">
                  {t('workspace.knowledgeBase.retry')}
                </button>
              </li>
            ) : node.files.length === 0 ? (
              <li
                data-testid={`kb-folder-empty-${folder.id}`}
                className="py-2 pl-15 text-[12px] text-[color:var(--ws-ink-mute)]"
              >
                {t('workspace.knowledgeBase.empty.folder')}
              </li>
            ) : (
              node.files.map((material) => fileRow(material, { nested: true }))
            )}
            {loadMoreRow(node, { folderId: folder.id }, `kb-load-more-${folder.id}`, true)}
          </ul>
        ) : null}
      </li>
    );
  };

  const uploadRows = uploads.entries.map((entry) => (
    <li
      key={entry.id}
      data-testid={`kb-${entry.id}`}
      className="flex min-w-0 items-start gap-2 px-3 py-2 text-[13px]"
    >
      <RowChevron />
      {entry.error === undefined ? (
        <LoaderCircle {...ROW_ICON} className={cn(ROW_ICON.className, 'animate-spin')} />
      ) : (
        <X {...ROW_ICON} className="size-4 shrink-0 text-[color:var(--ws-fail)]" />
      )}
      <span className="min-w-0 flex-1 break-words">
        {entry.name}
        {' · '}
        {entry.error === undefined ? (
          <span className="text-[color:var(--ws-ink-mute)]">
            {t('workspace.knowledgeBase.status.uploading')}
          </span>
        ) : (
          <span className="text-[color:var(--ws-fail)]">{entry.error}</span>
        )}
      </span>
      {entry.error !== undefined ? (
        <button
          type="button"
          data-testid={`kb-${entry.id}-dismiss`}
          onClick={() => uploads.dismiss(entry.id)}
          className="ws-quiet shrink-0 text-[12px] underline"
        >
          {t('workspace.knowledgeBase.upload.dismiss')}
        </button>
      ) : null}
    </li>
  ));

  // The same row as a folder's, its name a field (#1835 review §1).
  const creatingRow = creating ? (
    <li data-testid="kb-new-folder-row">
      <div data-kb-row="" className={cn(LAYOUT.tree.row, LAYOUT.tree.columns)}>
        <div
          className={cn(
            'flex min-w-0 flex-1 items-start gap-2 text-[13px] font-medium',
            LAYOUT.tree.nameSpan,
          )}
        >
          <RowChevron open={false} />
          <Folder {...ROW_ICON} />
          <InlineName
            key={creating.id}
            testId="kb-new-folder-input"
            errorTestId="kb-new-folder-error"
            label={t('workspace.knowledgeBase.folder.new')}
            initialName={creating.name}
            busy={creating.busy}
            error={creating.error ? t(creating.error) : null}
            onEdit={() =>
              setCreating((current) => (current?.error ? { ...current, error: null } : current))
            }
            onCommit={(name, cause) => void commitCreating(name, cause)}
            onCancel={() => cancelCreating(true)}
          />
        </div>
        {/* Size and date: nothing yet. */}
        <span className={LAYOUT.tree.cell} />
        <span className={LAYOUT.tree.cell} />
        {/* Where a folder has its ⋯: the same room, so the row is as tall. */}
        <span className={LAYOUT.tree.menu}>
          <span className="ws-util-btn invisible shrink-0" aria-hidden="true" />
        </span>
      </div>
    </li>
  ) : null;

  // ── What the list region holds ──────────────────────────────────────
  const searching = tree.mode === 'search';
  const primary = searching ? tree.results : tree.root;
  const nothingAtAll =
    !searching &&
    tree.root.status === 'ready' &&
    tree.folders.length === 0 &&
    tree.root.files.length === 0 &&
    uploads.entries.length === 0 &&
    !creating;

  let body: ReactNode;
  if (primary.status === 'loading' && primary.files.length === 0) {
    body = (
      <p data-testid="kb-loading" className="px-3 py-3 text-[13px] text-[color:var(--ws-ink-mute)]">
        {t('workspace.knowledgeBase.loading')}
      </p>
    );
  } else if (primary.status === 'error') {
    body = (
      <div
        data-testid="kb-error"
        role="alert"
        className="flex flex-col items-start gap-2 px-3 py-3"
      >
        <p className="text-[13px]">{t(materialLibraryErrorKey(primary.error))}</p>
        <button
          type="button"
          data-testid="kb-retry"
          onClick={() => tree.reload()}
          className="ws-quiet text-[13px] underline"
        >
          {t('workspace.knowledgeBase.retry')}
        </button>
      </div>
    );
  } else if (nothingAtAll) {
    body = (
      <div data-testid="kb-onboarding" className="flex max-w-[520px] flex-col gap-2 px-3 py-4">
        <h2 className="text-[15px] font-medium">{t('workspace.knowledgeBase.empty.title')}</h2>
        <p className="text-[13px] leading-6 text-[color:var(--ws-ink-soft)]">
          {t('workspace.knowledgeBase.empty.body')}
        </p>
      </div>
    );
  } else if (searching) {
    body = (
      <>
        <ListHeader search t={t} />
        <ul data-testid="kb-results">
          {uploadRows}
          {tree.results.files.length === 0 ? (
            <li
              data-testid="kb-empty"
              className="px-3 py-3 text-[13px] text-[color:var(--ws-ink-mute)]"
            >
              {t('workspace.knowledgeBase.empty.query', { query })}
            </li>
          ) : (
            tree.results.files.map((material) => fileRow(material, { search: true }))
          )}
          {loadMoreRow(tree.results, 'results', 'kb-load-more')}
        </ul>
      </>
    );
  } else {
    body = (
      <>
        <ListHeader t={t} />
        <ul data-testid="kb-tree">
          {creatingRow}
          {tree.folders.map(folderRow)}
          {uploadRows}
          {tree.root.files.map((material) => fileRow(material, {}))}
          {loadMoreRow(tree.root, 'root', 'kb-load-more')}
        </ul>
      </>
    );
  }

  const perFileLimits = tree.limits
    ? t('workspace.knowledgeBase.limits.perFile', {
        document: formatMaterialBytes(tree.limits.documentMaxBytes, locale),
        media: formatMaterialBytes(tree.limits.mediaMaxBytes, locale),
      })
    : null;
  const uploadButton = (
    <button
      type="button"
      data-testid="kb-upload"
      onClick={() => fileInput.current?.click()}
      aria-describedby={perFileLimits ? limitsId : undefined}
      // The primary action: filled, as the composer's send is.
      className="flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ws-accent)] focus-visible:ring-offset-2"
    >
      <Upload className="size-4 shrink-0" aria-hidden="true" />
      {t('workspace.knowledgeBase.upload.button')}
    </button>
  );

  return (
    <main
      ref={scroller}
      data-testid="pro-workspace-library"
      aria-labelledby="pro-workspace-library-title"
      // Room for the sticky column names, so a row given the focus is not under them.
      className="ws-canvas relative flex min-w-0 flex-1 flex-col overflow-y-auto [overflow-anchor:none] [scroll-padding-top:2.75rem]"
    >
      {/* Below `md` the rail is gone, so the page carries its own way out. */}
      <div className="flex h-12 shrink-0 items-center px-4 md:hidden">
        <button
          type="button"
          data-testid="kb-back"
          onClick={onLeave}
          className="ws-quiet inline-flex h-8 items-center gap-1.5 text-[13px]"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('workspace.knowledgeBase.back')}
        </button>
      </div>

      {/* Three regions told apart by space, not rules (#1835 review §2). */}
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-4 pb-16 pt-2 sm:px-8 md:pt-8">
        <header data-testid="kb-header" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1
              ref={heading}
              id="pro-workspace-library-title"
              tabIndex={-1}
              className="mr-auto text-[20px] font-semibold outline-none"
            >
              {t('workspace.knowledgeBase.title')}
            </h1>
            {/* Outlined, as the buttons beside it are. */}
            <label className="flex h-9 w-full items-center gap-2 rounded-lg border border-[color:var(--ws-line)] bg-[color:var(--ws-surface)] px-3 text-[color:var(--ws-ink-mute)] transition-[border-color,box-shadow] focus-within:border-[color:var(--ws-accent-thread)] focus-within:shadow-[0_0_0_3px_var(--ws-accent-wash)] sm:w-64">
              <Search className="size-4 shrink-0" aria-hidden="true" />
              <input
                data-testid="kb-search"
                type="search"
                value={queryInput}
                onChange={(event) => changeQuery(event.target.value)}
                placeholder={t('workspace.knowledgeBase.search')}
                aria-label={t('workspace.knowledgeBase.search')}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[color:var(--ws-ink)] outline-none placeholder:text-[color:var(--ws-ink-mute)]"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                ref={newFolderButton}
                type="button"
                data-testid="kb-folder-new"
                disabled={creating?.busy}
                onClick={startCreating}
                className="ws-new flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] disabled:opacity-60"
              >
                <FolderPlus className="size-4 shrink-0 opacity-60" aria-hidden="true" />
                {t('workspace.knowledgeBase.folder.new')}
              </button>
              {perFileLimits ? (
                <Tooltip>
                  <TooltipTrigger asChild>{uploadButton}</TooltipTrigger>
                  <TooltipContent className="hidden md:block">{perFileLimits}</TooltipContent>
                </Tooltip>
              ) : (
                uploadButton
              )}
              <input
                ref={fileInput}
                data-testid="kb-upload-input"
                type="file"
                multiple
                accept={WORKBENCH_MATERIAL_ACCEPT}
                className="hidden"
                onChange={(event) => {
                  uploads.start(Array.from(event.target.files ?? []));
                  // The same file can be chosen again after a failure.
                  event.target.value = '';
                }}
              />
            </div>
          </div>
          {/* Touch screens have no hover: below `md` the per-file limits are
              written out; above it they are the upload button's tooltip.
              Either way the button is described by them. */}
          {perFileLimits ? (
            <p
              id={limitsId}
              data-testid="kb-upload-limits"
              className="text-[12px] text-[color:var(--ws-ink-mute)] md:hidden"
            >
              {perFileLimits}
            </p>
          ) : null}
        </header>

        {tree.limits ? (
          <section>
            <Usage limits={tree.limits} locale={locale} t={t} />
          </section>
        ) : null}

        <section aria-live="polite">
          {tree.error && primary.status === 'ready' ? (
            <div
              data-testid="kb-stale"
              role="alert"
              className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-[color:var(--ws-ink-soft)]"
            >
              <span>
                {t(materialLibraryErrorKey(tree.error))}
                {' · '}
                {t('workspace.knowledgeBase.error.stale')}
              </span>
              <button type="button" onClick={() => tree.reload()} className="ws-quiet underline">
                {t('workspace.knowledgeBase.retry')}
              </button>
            </div>
          ) : null}
          <div
            ref={list}
            data-testid="kb-list"
            // `clip`, not `hidden`: the rounded corners still clip, but the
            // list is no scroll container, so its column names can stick.
            className="@container overflow-clip rounded-xl border border-[color:var(--ws-line)] bg-[color:var(--ws-surface)]"
          >
            {body}
          </div>
        </section>
      </div>

      {deleting?.kind === 'material' ? (
        <DeleteDialog
          key={`material-${deleting.material.materialId}`}
          testId="kb-delete-dialog"
          title={t('workspace.knowledgeBase.delete.materialTitle', {
            name: deleting.material.name,
          })}
          lines={[
            t('workspace.knowledgeBase.delete.materialLinks'),
            t('workspace.knowledgeBase.delete.materialCourses'),
            t('workspace.knowledgeBase.delete.cannotUndo'),
          ]}
          remove={() => deleteLibraryMaterial(deleting.material.materialId)}
          onSettled={() => reloadIfMounted.current()}
          onDeleted={() => {
            opener.current = null;
          }}
          onClose={() => setDeleting(null)}
          returnFocus={returnFocus}
          t={t}
        />
      ) : deleting?.kind === 'folder' ? (
        <DeleteDialog
          key={`folder-${deleting.folder.id}`}
          testId="kb-delete-dialog"
          title={t('workspace.knowledgeBase.delete.folderTitle', { name: deleting.folder.name })}
          lines={[t('workspace.knowledgeBase.delete.folderOnlyEmpty')]}
          remove={() => deleteLibraryFolder(deleting.folder.id)}
          onSettled={() => reloadIfMounted.current()}
          onDeleted={() => {
            opener.current = null;
          }}
          onClose={() => setDeleting(null)}
          returnFocus={returnFocus}
          t={t}
        />
      ) : null}
      {moving ? (
        <MoveDialog
          key={moving.materialId}
          material={moving}
          folders={tree.folders}
          move={(folderId) => write(() => moveLibraryMaterials([moving.materialId], folderId))}
          onClose={() => setMoving(null)}
          returnFocus={returnFocus}
          t={t}
        />
      ) : null}
    </main>
  );
}

/** The column names, on a wide list (on a narrow one each row says what it is). */
function ListHeader({ search = false, t }: { readonly search?: boolean; readonly t: Translate }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        search ? LAYOUT.search.header : LAYOUT.tree.header,
        search ? LAYOUT.search.columns : LAYOUT.tree.columns,
      )}
    >
      <span>{t('workspace.knowledgeBase.column.name')}</span>
      {search ? <span>{t('workspace.knowledgeBase.column.folder')}</span> : null}
      <span>{t('workspace.knowledgeBase.column.status')}</span>
      <span>{t('workspace.knowledgeBase.column.size')}</span>
      <span>{t('workspace.knowledgeBase.column.date')}</span>
      <span />
    </div>
  );
}
