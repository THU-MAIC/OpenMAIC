'use client';

/**
 * The workspace's navigation — the one tree for the whole Pro surface.
 *
 * There used to be two: this tree on `/workspace`, and a two-row rail beside
 * an attached session. They are the same navigation and are now the same
 * component: whatever is open (a course, a conversation, both) is marked
 * `aria-current` in this tree, and opening something is a click on a row here
 * rather than a route change to a different shell.
 *
 * Shape, deliberately:
 *  - TWO TABS over one body — chat and courses, a segmented control of two
 *    equal halves. The three used to be stacked peer sections, which meant
 *    three heads, three counts and three resting windows competing for one
 *    column; only one of the three is ever the thing you came for. Tabs make
 *    the active list own the rail's height (`workspace-paging` re-tuned with
 *    it);
 *  - the courses tab is ONE TREE, and only FOLDERS are containers in it. A
 *    course that is in no folder is a row at the tree's top level, under the
 *    folders — not a member of an "unfiled" group, which was a head, a count
 *    and a twisty around the absence of filing, and which let one press fold
 *    away the bulk of the list. There is still exactly one unbounded list in
 *    the rail, and therefore one pager;
 *  - course and chat rows are both compact, single-line entries. A course keeps
 *    the stronger name treatment and states its page count at the far edge,
 *    matching the folder/count rhythm above it; run state belongs to the chat
 *    row that is actually running;
 *  - the course list is `useHomeDiscovery`'s `classrooms`, never a second
 *    `GET /api/stages` — a rail that contradicts the grid beside it is worse
 *    than a rail that is one render late;
 *  - long lists reveal one page at a time (`workspace-paging`), because this
 *    account has 139 courses and "reveal everything" is not a navigation;
 *  - the header utilities the classic chrome carries — language, theme,
 *    feedback, community, account — survive at the foot, as the SAME
 *    components SiteHeader mounts, with the two least-pressed behind one ⋯;
 *  - rows are draggable: courses and sessions reorder against a hairline
 *    insertion line, a course dropped on a folder row is filed into it, a
 *    course dropped on the BLANK GROUND at the tree's foot is moved back out to
 *    the top level (Finder's own gesture — the tree lost its "unfiled" row,
 *    and with it the only place a filed course could be dropped to unfile it),
 *    and the resulting sequence is decided entirely by `workspace-order` — this
 *    file only wires the events;
 *  - every row you authored carries the same hover-revealed ⋯: rename edits
 *    the name IN PLACE (the row becomes an input; Enter commits, Escape leaves
 *    it alone) and delete asks first. Folders and courses answer to different
 *    endpoints — `PATCH /api/folders/:id` and `PATCH /api/stages/:id` — but not
 *    to different interactions.
 *
 * Collapsed, it becomes a 60px icon strip: an explicit expand button in the
 * header slot, a new-session button, one glyph per destination (which expands
 * the rail INTO that destination — the chat tab, the course tab), and the
 * utilities. The compact header is an action rather than a second brand/home
 * affordance, so the way back out is visible immediately.
 *
 * It folds from its own header — the row with the wordmark and the PRO pill —
 * with the same `PaneFoldButton` the conversation and the classroom use. It used
 * to fold from a pill floating in the middle of its seam, on the argument that
 * the rail had no header; that left one line carrying two meanings, because the
 * seam is also the rail's width drag. The seam now resizes and nothing else,
 * like the other two.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Folder,
  FolderOpen,
  FolderPlus,
  BookOpen,
  LoaderCircle,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useBrand } from '@/lib/brand/brand-context';
import type { HomeDiscoveryState, useHomeDiscovery } from '@/lib/hooks/use-home-discovery';
import { ProBadge } from '@/components/workbench/ProBadge';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeToggle } from '@/components/site-header/theme-toggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils/cn';
import {
  FloatingLayerOwner,
  installFloatingLayerDismissListeners,
} from '@/components/ui/floating-layer-owner';
import {
  newestFirst,
  relativeBucket,
  type ProHomeSessionItem,
} from '@/lib/workbench/pro-home-data';
import { filterByName, groupCoursesByFolder } from '@/lib/workbench/workspace-tree';
import {
  EMPTY_PAGES,
  RAIL_INITIAL_ROWS,
  nextPage,
  pageList,
  pagesFor,
  withPages,
  type PageMap,
} from '@/lib/workbench/workspace-paging';
import {
  applyCustomOrder,
  parseOrder,
  reorderIds,
  serializeOrder,
  COURSE_ORDER_STORAGE_KEY,
  SESSION_ORDER_STORAGE_KEY,
  type DropTarget,
} from '@/lib/workbench/workspace-order';
import {
  RAIL_TAB_STORAGE_KEY,
  resolveRailTab,
  type RailTab,
} from '@/lib/workbench/workspace-rail-tab';
import { useTreeDrag, type DragKind } from './use-tree-drag';
import { PaneFoldButton } from './PaneFoldButton';
import { deleteWorkspaceSession } from '@/lib/workbench/workspace-actions';
import { apiRenameStage, StageRenameError, STAGE_NAME_MAX_LENGTH } from '@/lib/live/server-api';
import { SESSION_TITLE_MAX_LENGTH, workbenchSessionTitle } from '@/lib/workbench/session-title';
import {
  displayNameWidth,
  FOLDER_COUNT_LIMIT,
  FOLDER_NAME_MAX_WIDTH,
  validateFolderName,
} from '@/lib/utils/folder-name-validation';
import {
  workspaceFolderAdapter,
  workspaceFoldersAvailable,
  WorkspaceFolderNameError,
} from './workspace-folder-seam';

type Discovery = ReturnType<typeof useHomeDiscovery>;
type StageListItem = Discovery['classrooms'][number];

/**
 * Rows a chat list shows before it pages.
 *
 * Twelve against the courses' ten (`RAIL_INITIAL_ROWS`). Both numbers grew
 * with the tab switch — one list on screen instead of three sections sharing
 * it — and both are still a window, not a dump.
 */
const SESSION_ROW_LIMIT = 12;

export function WorkspaceRail({
  courses,
  sessions,
  sessionState,
  onReloadSessions,
  activeCourseId,
  activeSessionId,
  collapsed,
  onToggleCollapsed,
  onOpenCourse,
  onOpenSession,
  onNewSession,
  onGoHome,
  onExitPro,
  onSessionDeleted,
  onRenameSession,
  onDeleteCourse,
  resizeHandle,
}: {
  readonly courses: Discovery;
  readonly sessions: readonly ProHomeSessionItem[];
  readonly sessionState: HomeDiscoveryState;
  readonly onReloadSessions: () => void;
  readonly activeCourseId: string | null;
  readonly activeSessionId: string | null;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onOpenCourse: (id: string) => void;
  readonly onOpenSession: (id: string) => void;
  /**
   * A new conversation in the middle column. Both entries below (the compose row
   * and its collapsed `+`) call this ONE handler, and it deliberately does not
   * touch the classroom pane — see `startNewConversation` in the shell.
   */
  readonly onNewSession: () => void;
  /** Back to the bare `/workspace` — the logo, and the shell's own handler. */
  readonly onGoHome: () => void;
  readonly onExitPro: () => void;
  /** The shell drops the deleted chat's pane and URL param, once the server
   *  confirmed the delete. Rows are already gone optimistically down here. */
  readonly onSessionDeleted: (sessionId: string) => void;
  /**
   * Name a chat. The shell owns the write (one writer for this row and the
   * pane header both) and answers with a readable message when it is refused.
   */
  readonly onRenameSession: (sessionId: string, title: string) => Promise<string | null>;
  /** The shell deletes the course AND closes its classroom tab on success. */
  readonly onDeleteCourse: (courseId: string) => Promise<void> | void;
  /** The width drag, owned by the shell (it writes the CSS variable on the root). */
  readonly resizeHandle: ReactNode;
}) {
  const { t } = useI18n();
  const brand = useBrand();
  const foldersAvailable = workspaceFoldersAvailable();

  const coursesSection = useListSearch();
  const sessionsSection = useListSearch();

  // The rail survives while the home surface is unmounted, so folder creation
  // belongs to this tree. It is an inline row at the top of the course tree:
  // creating organization should not interrupt navigation with a modal.
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const handleCreateFolder = useCallback(
    async (name: string) => {
      if (!workspaceFolderAdapter) return;
      await workspaceFolderAdapter.create(name);
      courses.reload();
    },
    [courses],
  );

  // ── Row maintenance: rename in place, delete after a question ────────
  // Which row is currently an input. One id each, because two rows cannot be
  // renamed at once and a rename that survived a tab switch would be an input
  // hovering over a list it no longer belongs to.
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingCourseId, setRenamingCourseId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  /** The folder whose delete has been asked for, and not yet answered. */
  const [folderToDelete, setFolderToDelete] = useState<{ id: string; name: string } | null>(null);

  /**
   * Commit a folder rename. Returns null when it landed and a readable message
   * when the name was refused — the same three refusals the create row maps
   * (`PATCH /api/folders/:id` answers 409 `FOLDER_NAME_DUPLICATE` / 400
   * validation, and the live adapter turns both into `FolderNameError`).
   *
   * The duplicate check runs here as well as on the server: a name the local
   * list already holds should not cost a round trip to be told so.
   */
  const submitFolderRename = useCallback(
    async (folderId: string, name: string): Promise<string | null> => {
      const widthCheck = validateFolderName(name);
      if (!widthCheck.ok) {
        return widthCheck.kind === 'empty'
          ? t('classroom.folderNameEmpty')
          : t('classroom.folderWidth', { width: widthCheck.width, max: FOLDER_NAME_MAX_WIDTH });
      }
      const trimmed = name.trim();
      // Unchanged is not a rename; leave editing without writing anything.
      if (courses.folders.find((folder) => folder.id === folderId)?.name === trimmed) return null;
      if (
        courses.folders.some(
          (folder) => folder.id !== folderId && folder.name.toLowerCase() === trimmed.toLowerCase(),
        )
      ) {
        return t('classroom.folderNameExists');
      }
      try {
        if (!workspaceFolderAdapter) return t('workspace.foldersUnavailable');
        await workspaceFolderAdapter.rename(folderId, trimmed);
        await courses.reload();
        return null;
      } catch (caught) {
        if (caught instanceof WorkspaceFolderNameError) {
          if (caught.kind === 'duplicate') return t('classroom.folderNameExists');
          if (caught.kind === 'tooLong') {
            return t('classroom.folderWidth', {
              width: displayNameWidth(trimmed),
              max: FOLDER_NAME_MAX_WIDTH,
            });
          }
          if (caught.kind === 'empty') return t('classroom.folderNameEmpty');
          return t('classroom.folderNameHint');
        }
        return t('classroom.folderRenameFailed');
      }
    },
    [courses, t],
  );

  /**
   * Commit a course rename through `PATCH /api/stages/:id` — the route owns the
   * owner gate and the write, so this only maps its refusals onto copy. NOT the
   * storage boundary's `renameStage`: that reads and rewrites the whole document
   * client-side, which a name change in a list has no reason to do.
   */
  const submitCourseRename = useCallback(
    async (courseId: string, name: string): Promise<string | null> => {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > STAGE_NAME_MAX_LENGTH) {
        return t('workspace.renameInvalid');
      }
      if (courses.classrooms.find((course) => course.id === courseId)?.name === trimmed)
        return null;
      try {
        await apiRenameStage(courseId, trimmed);
        // The authoritative list is what every surface reads a course's name
        // from — the rail row, the classroom tab strip, an in-chat course link.
        // One reload renames all of them.
        await courses.reload();
        return null;
      } catch (caught) {
        if (caught instanceof StageRenameError) {
          if (caught.kind === 'invalidName') return t('workspace.renameInvalid');
          if (caught.kind === 'forbidden') return t('workspace.renameForbidden');
          if (caught.kind === 'notFound') return t('workspace.renameGone');
        }
        return t('classroom.renameFailed');
      }
    },
    [courses, t],
  );

  /**
   * Delete a folder, keeping its courses (`mode=ungroup`, the endpoint's
   * default): they return to the tree's top level. The destructive mode that
   * also deletes the courses is deliberately NOT offered here — the rail is
   * navigation, and a container's ⋯ must not be able to destroy work.
   */
  const deleteFolderKeepingCourses = useCallback(
    async (folderId: string) => {
      try {
        if (!workspaceFolderAdapter) return;
        await workspaceFolderAdapter.removeKeepingCourses(folderId);
      } catch {
        toast.error(t('classroom.folderDeleteFailed'));
      } finally {
        // Either way: the tree must show what the server actually has.
        await courses.reload();
      }
    },
    [courses, t],
  );

  // ── Which list is on screen ──────────────────────────────────────────
  // A view preference, read from storage after mount (see the shell's own
  // collapse state for why never during render), and written on every press.
  const [tab, setTab] = useState<RailTab>('sessions');
  const tabResolved = useRef(false);
  useEffect(() => {
    if (tabResolved.current) return;
    tabResolved.current = true;
    setTab(
      resolveRailTab({
        stored: readStored(RAIL_TAB_STORAGE_KEY),
        hasOpenCourse: Boolean(activeCourseId),
      }),
    );
  }, [activeCourseId]);

  const selectTab = useCallback((next: RailTab) => {
    // A press is a preference even before the stored one was read: it must not
    // be overwritten by a late first-visit resolution.
    tabResolved.current = true;
    // An open rename belongs to a row on the tab being left. Leaving it armed
    // would put an input back into a list the user has since walked away from.
    if (next !== 'courses') {
      setNewFolderOpen(false);
      setRenamingFolderId(null);
      setRenamingCourseId(null);
    }
    if (next !== 'sessions') setRenamingSessionId(null);
    setTab(next);
    writeStored(RAIL_TAB_STORAGE_KEY, next);
  }, []);

  // Which folders are open. One set keyed by id, so adding a folder costs no
  // new state.
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(() => new Set());

  // How many extra pages each capped list has revealed. One integer per list
  // (see `workspace-paging`); absent means "at rest".
  const [pages, setPages] = useState<PageMap>(EMPTY_PAGES);

  const toggleIn = (
    set: ReadonlySet<string>,
    apply: (next: ReadonlySet<string>) => void,
    id: string,
  ) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    apply(next);
  };

  // ── Manual order ─────────────────────────────────────────────────────
  // A per-browser view preference (see `workspace-order`): read once on the
  // client, applied before anything filters or groups, so every sub-list the
  // tree derives inherits it.
  const [courseOrder, setCourseOrder] = useState<readonly string[]>(EMPTY_ORDER);
  const [sessionOrder, setSessionOrder] = useState<readonly string[]>(EMPTY_ORDER);
  const [deletedSessionIds, setDeletedSessionIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    // localStorage does not exist during SSR and reading it while rendering
    // would make the first client paint disagree with the served HTML.
    setCourseOrder(parseOrder(readStored(COURSE_ORDER_STORAGE_KEY)));
    setSessionOrder(parseOrder(readStored(SESSION_ORDER_STORAGE_KEY)));
  }, []);

  // ── The course tree ──────────────────────────────────────────────────
  // Sorted once, ordered, then filtered, then grouped. There is no ownership
  // split to make first: the home/workspace listing is owner-scoped, so every
  // course in it is the user's own and the whole list is one tree.
  const sortedCourses = useMemo(() => newestFirst(courses.classrooms), [courses.classrooms]);
  const orderedCourses = useMemo(
    () => applyCustomOrder(sortedCourses, courseOrder),
    [sortedCourses, courseOrder],
  );
  const orderedSessions = useMemo(
    () =>
      applyCustomOrder(sessions, sessionOrder).filter((item) => !deletedSessionIds.has(item.id)),
    [deletedSessionIds, sessions, sessionOrder],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      setDeletedSessionIds((current) => new Set(current).add(sessionId));
      try {
        const result = await deleteWorkspaceSession(sessionId);
        if (!result.deleted) throw new Error('session was not found');
        onReloadSessions();
        // The delete landed: if this was the open chat, the shell drops its
        // pane and URL param now (not optimistically — a failed delete must
        // leave everything exactly where it was, with the row restored).
        onSessionDeleted(sessionId);
      } catch {
        setDeletedSessionIds((current) => {
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
        toast.error(t('workspace.deleteFailed'));
      }
    },
    [onReloadSessions, onSessionDeleted, t],
  );
  const courseQuery = coursesSection.query;
  const searchingCourses = courseQuery.trim().length > 0;
  const matchedOwned = useMemo(
    () => filterByName(orderedCourses, courseQuery),
    [orderedCourses, courseQuery],
  );
  const tree = useMemo(
    () => groupCoursesByFolder(matchedOwned, courses.folders),
    [matchedOwned, courses.folders],
  );

  const matchedSessions = useMemo(
    () =>
      filterByName(
        // Search what the row SHOWS: a renamed chat has to be findable by the
        // name the user gave it, not only by its first message.
        orderedSessions.map((session) => ({
          ...session,
          name: workbenchSessionTitle(session) ?? '',
        })),
        sessionsSection.query,
      ),
    [orderedSessions, sessionsSection.query],
  );

  // ── Paging × search ──────────────────────────────────────────────────
  // Typing a query builds a different list under the same list ids, so the
  // pages a user opened on the unfiltered list must not carry over: five open
  // pages on 139 courses would otherwise cash themselves in the moment the
  // query was cleared. Adjusting state during render (React's own recipe for
  // "derived from a prop that changed") rather than in an effect, so the tree
  // never paints one frame with the stale window.
  const querySignature = `${courseQuery.trim()}\u0000${sessionsSection.query.trim()}`;
  const [pagedFor, setPagedFor] = useState(querySignature);
  if (pagedFor !== querySignature) {
    setPagedFor(querySignature);
    setPages(EMPTY_PAGES);
  }

  const openPage = useCallback((id: string, items: readonly unknown[], initial: number) => {
    setPages((current) =>
      withPages(current, id, nextPage(items, pagesFor(current, id), { initial })),
    );
  }, []);

  const collapsePage = useCallback((id: string) => {
    setPages((current) => withPages(current, id, 0));
  }, []);

  // ── Drag to reorder ──────────────────────────────────────────────────
  // The rail wires events and renders; every decision about the resulting
  // sequence is made by the pure module. A drop is always expressed relative
  // to a concrete neighbour, so reordering inside one folder cannot disturb
  // any other list even though the persisted sequence is flat.
  const handleReorder = useCallback(
    (kind: DragKind, dragId: string, target: DropTarget) => {
      if (kind === 'course') {
        const next = reorderIds(
          orderedCourses.map((course) => course.id),
          dragId,
          target,
        );
        setCourseOrder(next);
        writeStoredOrder(COURSE_ORDER_STORAGE_KEY, next);
      } else {
        const next = reorderIds(
          orderedSessions.map((session) => session.id),
          dragId,
          target,
        );
        setSessionOrder(next);
        writeStoredOrder(SESSION_ORDER_STORAGE_KEY, next);
      }
    },
    [orderedCourses, orderedSessions],
  );

  const handleDropIntoFolder = useCallback(
    (courseId: string, folderId: string | undefined) => {
      // Filing belongs to the tree: dropping a course onto a folder row files
      // it there, and dropping it onto the tree's blank ground (`folderId ===
      // undefined`, decoded from the empty drop zone at the foot) unfiles it.
      // A drop onto the folder the course already lives in is not a move, and
      // neither is dropping an already-loose course onto the blank ground.
      const current = courses.classrooms.find((course) => course.id === courseId)?.folderId;
      if (current === folderId) return;
      void courses.moveCourse(courseId, folderId);
    },
    [courses],
  );

  const drag = useTreeDrag({ onReorder: handleReorder, onMoveToFolder: handleDropIntoFolder });

  /**
   * The keyboard's version of the same gesture: Alt+↑/↓ on a focused row moves
   * it past its neighbour *in the list it is displayed in*, which is what the
   * user can see. React keys rows by id, so the focused button survives the
   * move and focus travels with it.
   */
  const moveWithKeyboard = useCallback(
    (kind: DragKind, id: string, siblings: readonly string[], delta: -1 | 1) => {
      const index = siblings.indexOf(id);
      if (index < 0) return;
      const neighbour = siblings[index + delta];
      if (!neighbour) return;
      handleReorder(kind, id, delta < 0 ? { before: neighbour } : { after: neighbour });
    },
    [handleReorder],
  );

  // A folder holding the open course opens itself, once: the row must be
  // reachable after a refresh that restored `?course=` without any clicks.
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeCourseId || revealedFor.current === activeCourseId) return;
    const folderId = courses.classrooms.find((c) => c.id === activeCourseId)?.folderId;
    revealedFor.current = activeCourseId;
    if (!folderId) return;
    // Syncing a disclosure to an external fact (the URL), which is exactly
    // what an effect is for: the folder is not derivable during render
    // because the course list arrives asynchronously.
    setOpenFolders((open) => (open.has(folderId) ? open : new Set(open).add(folderId)));
  }, [activeCourseId, courses.classrooms]);

  /**
   * The collapsed strip's glyphs are DESTINATIONS, not one repeated "expand"
   * button: each opens the rail onto the thing it depicts. A strip whose three
   * marks all did the same thing would be describing a structure the expanded
   * rail no longer has.
   *
   * Each still reopens the rail into its destination. The compact header now
   * carries a separate, unambiguous expand control, while these shortcuts keep
   * their more specific "expand into this section" behavior.
   */
  const expandInto = (destination: RailTab) => {
    selectTab(destination);
    onToggleCollapsed();
  };

  /**
   * What a collapsed glyph says it will do — BOTH halves of it. Naming only the
   * destination ("chat") hid the fact that the press also reopens the rail,
   * which is the one thing a reader of a 60px strip needs to be told.
   */
  const expandLabel = (section: string) => t('workspace.expandNavInto', { section });

  if (collapsed) {
    return (
      <nav
        data-testid="pro-nav-rail-mini"
        aria-label={t('workspace.navAria')}
        className="ws-rail ws-mini relative z-10 hidden h-full shrink-0 flex-col items-center md:flex"
      >
        <div className="flex h-16 shrink-0 items-center">
          {/* The expanded header's fold stays in the same spatial slot when the
              rail closes. The mark disappears so this compact state exposes
              its primary recovery action without changing the logo's meaning. */}
          <PaneFoldButton
            testId="pro-nav-expand"
            label={t('workspace.expandNav')}
            direction="right"
            expanded={false}
            className="ws-mini-btn"
            onClick={onToggleCollapsed}
          />
        </div>
        <div className="ws-seam-rail w-8 shrink-0" aria-hidden="true" />
        <div className="flex flex-1 flex-col items-center gap-1 pt-3">
          <button
            type="button"
            data-testid="pro-workspace-new-session-mini"
            onClick={onNewSession}
            aria-label={t('workspace.newSession')}
            title={t('workspace.newSession')}
            className="ws-mini-btn"
          >
            <Plus className="size-4" aria-hidden="true" />
          </button>
          <div className="my-1 h-px w-6 bg-[color:var(--ws-line-soft)]" aria-hidden="true" />
          <button
            type="button"
            data-testid="pro-nav-mini-sessions"
            onClick={() => expandInto('sessions')}
            aria-label={expandLabel(t('workspace.sections.sessions'))}
            title={expandLabel(t('workspace.sections.sessions'))}
            aria-current={activeSessionId ? 'true' : undefined}
            aria-expanded={false}
            className="ws-mini-btn"
          >
            <MessagesSquare className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="pro-nav-mini-courses"
            onClick={() => expandInto('courses')}
            aria-label={expandLabel(t('workspace.sections.courses'))}
            title={expandLabel(t('workspace.sections.courses'))}
            aria-current={activeCourseId ? 'true' : undefined}
            aria-expanded={false}
            className="ws-mini-btn"
          >
            <BookOpen className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="ws-seam-rail w-8 shrink-0" aria-hidden="true" />
        <div
          aria-label={t('workspace.utilitiesAria')}
          data-testid="pro-rail-utilities-mini"
          className="ws-utils flex shrink-0 flex-col items-center gap-0.5 py-2.5"
        >
          {/* 60px of width does not hold five controls, so at this size the
              overflow is where everything but the two most-used entries
              lives — including the locale switcher. */}
          <RailOverflow testId="pro-rail-more-mini" mini withLanguage />
          <ThemeToggle />
        </div>
      </nav>
    );
  }

  const renderCourseRow = (course: StageListItem, siblings: readonly string[]) => {
    const label = course.name || t('workspace.untitledCourse');
    // Being renamed: the row IS the input, in place, at the row's own height.
    // Not a dialog — the thing being edited is the row you are looking at.
    if (course.id === renamingCourseId) {
      return (
        <InlineNameRow
          key={course.id}
          testId={`pro-nav-course-rename-${course.id}`}
          initialName={course.name}
          placeholder={t('classroom.renamePlaceholder')}
          ariaLabel={t('classroom.rename')}
          maxLength={STAGE_NAME_MAX_LENGTH}
          inputClassName="ws-course-name"
          onSubmit={(name) => submitCourseRename(course.id, name)}
          onClose={() => setRenamingCourseId(null)}
        />
      );
    }
    return (
      <RailRow
        key={course.id}
        testId={`pro-nav-course-${course.id}`}
        label={label}
        labelClassName="ws-course-name"
        course
        active={course.id === activeCourseId}
        dragProps={drag.rowProps('course', course.id)}
        dragging={drag.dragId === course.id}
        dropEdge={drag.indicator?.rowId === course.id ? drag.indicator.edge : null}
        onMove={(delta) => moveWithKeyboard('course', course.id, siblings, delta)}
        // The page count takes the same trailing slot as a folder's count.
        // On actionable rows the hover-only menu overlays this slot while the
        // count fades, so the resting layout never reserves an action column.
        meta={t('workspace.sceneCount', { count: course.sceneCount })}
        metaTestId={`pro-nav-course-meta-${course.id}`}
        onClick={() => onOpenCourse(course.id)}
        trailing={
          // Rename and one quiet destructive entry; filing is the tree's drag
          // interaction, so it is not repeated behind a nested "move" path.
          <WorkspaceRowMenu
            testId={`pro-nav-course-more-${course.id}`}
            label={label}
            onRename={() => setRenamingCourseId(course.id)}
            onDelete={() => onDeleteCourse(course.id)}
          />
        }
      />
    );
  };

  const renderCourseList = (list: readonly StageListItem[], listId: string) => {
    // The sibling sequence the keyboard move walks: the whole sub-list, not
    // just the rows currently inside the page window.
    const siblings = list.map((course) => course.id);
    return (
      <PagedRows
        id={listId}
        items={list}
        initial={RAIL_INITIAL_ROWS}
        pages={pagesFor(pages, listId)}
        onMore={() => openPage(listId, list, RAIL_INITIAL_ROWS)}
        onCollapse={() => collapsePage(listId)}
        render={(course) => renderCourseRow(course, siblings)}
      />
    );
  };

  const renderSessionRow = (session: (typeof matchedSessions)[number]) => {
    const label = workbenchSessionTitle(session) ?? t('workspace.untitledSession');
    // Being renamed: the row IS the input, in place, exactly as a course row is.
    if (session.id === renamingSessionId) {
      return (
        <InlineNameRow
          key={session.id}
          testId={`pro-nav-session-rename-${session.id}`}
          // The stored name only. An unnamed chat opens EMPTY, with its derived
          // title as the placeholder, so the box says what it will fall back to
          // rather than pre-filling a whole first message to delete.
          initialName={session.title ?? ''}
          placeholder={label}
          ariaLabel={t('workspace.renameSession')}
          maxLength={SESSION_TITLE_MAX_LENGTH}
          // Unlike a course or a folder, a chat may be left nameless: clearing
          // the box drops the override and the derived title comes back.
          allowEmpty
          inputClassName="ws-chat-name"
          onSubmit={(name) => onRenameSession(session.id, name)}
          onClose={() => setRenamingSessionId(null)}
        />
      );
    }
    return (
      <RailRow
        key={session.id}
        testId={`pro-nav-session-${session.id}`}
        label={label}
        // Lighter than a course row, and lighter than it used to be:
        // a chat is a trace of process, so the list reads as a
        // time-ordered stream of ticks rather than a shelf.
        rowClassName="ws-chat-row"
        labelClassName="ws-chat-name"
        active={session.id === activeSessionId}
        dragProps={drag.rowProps('session', session.id)}
        dragging={drag.dragId === session.id}
        dropEdge={drag.indicator?.rowId === session.id ? drag.indicator.edge : null}
        onMove={(delta) =>
          moveWithKeyboard(
            'session',
            session.id,
            matchedSessions.map((item) => item.id),
            delta,
          )
        }
        meta={relativeLabel(session.updatedAt || session.createdAt, t)}
        trailingMark={<SessionDot status={session.status} />}
        statusLabel={t(`workspace.sessionStatus.${session.status}`)}
        onClick={() => onOpenSession(session.id)}
        trailing={
          <WorkspaceRowMenu
            testId={`pro-nav-more-session-${session.id}`}
            label={label}
            onRename={() => setRenamingSessionId(session.id)}
            onDelete={() => deleteSession(session.id)}
          />
        }
      />
    );
  };

  return (
    <nav
      data-testid="pro-nav-rail"
      aria-label={t('workspace.navAria')}
      // `z-10`: the resize handle straddles the rail's right edge, and the
      // panes are later positioned siblings — without a stacking order the
      // canvas paints over the handle and swallows the drag.
      className="ws-rail ws-enter-rail relative z-10 hidden h-full shrink-0 flex-col md:flex"
      style={{ width: 'var(--ws-rail-w)' }}
    >
      <div className="flex h-16 shrink-0 items-center gap-2 px-4">
        {/* The wordmark is the way home; the PRO pill beside it is the switch
            that leaves Pro. Two different destinations, so two hit targets —
            never one control wearing both meanings. */}
        <HomeLink testId="pro-nav-home" onGoHome={onGoHome} className="-ml-1.5 px-1.5 py-1">
          <img
            src={brand.logoSrc}
            alt=""
            aria-hidden="true"
            className="h-[21px] w-auto max-w-[110px] shrink-0"
          />
        </HomeLink>
        <ProBadge active onToggle={onExitPro} />
        {/* THE rail's header, and therefore where the rail folds — the same
            button, in the same place, that the conversation and the classroom
            fold from. It used to be a pill floating in the middle of the rail's
            own seam, which made one line mean two things: that seam also drags
            the rail's width. The seam now only resizes. */}
        <PaneFoldButton
          testId="pro-nav-collapse"
          label={t('workspace.collapseNav')}
          direction="left"
          expanded
          className="ml-auto"
          onClick={onToggleCollapsed}
        />
      </div>

      {/* A hairline that fades before the rail's right edge, rather than a
          full-width border: the rail already has one edge, and two hard
          rules meeting in a corner is the boxy look this pass removes. */}
      <div className="ws-seam-rail mx-4 shrink-0" aria-hidden="true" />

      {/* Compose, one row to itself — the prototype's newrow shape. Find is no
          longer its square sibling: a search box is an action on the LIST, not
          on the act of starting one, so it moved under the tab strip, where it
          filters whichever list the active tab shows (see the findrow below). */}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-3 pt-3">
        <button
          type="button"
          data-testid="pro-workspace-new-session"
          onClick={onNewSession}
          className="ws-new flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-[13px] font-medium focus-visible:outline-none"
        >
          <Plus className="size-4 shrink-0 opacity-50" aria-hidden="true" />
          <span className="min-w-0 truncate">{t('workspace.newSession')}</span>
        </button>
      </div>

      {/* ── Two tabs, one body ───────────────────────────────────────────
          Chat and courses are both yours and both maintained, so they are two
          VIEWS OF ONE REGION rather than two stacked lists dividing one
          column between them — at rest the old shape gave each of them five
          rows and spent the difference on heads. */}
      <RailTabs
        active={tab}
        onSelect={selectTab}
        tabs={[
          {
            id: 'sessions',
            label: t('workspace.sections.sessions'),
          },
          {
            id: 'courses',
            label: t('workspace.sections.courses'),
          },
        ]}
      />

      {/* Find, under the tabs — the prototype's findrow in form and density:
          one ALWAYS-VISIBLE icon+input row heading the tab content, filtering
          whichever list is on screen. Each tab keeps its own query (the two
          sections' hooks are untouched), so a search typed on one tab stays
          put while the other is visited. On the courses tab the row also
          carries a new-folder button as an icon button grouped with the input:
          the prototype hangs it at the tree's foot, where in this rail it read
          as a row the tree contained; in the header row it reads as an action
          on the whole
          list, which is what it is. */}
      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2 pt-2.5">
        <div className="ws-find min-w-0 flex-1">
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <input
            data-testid={`pro-nav-search-input-${tab}`}
            value={tab === 'sessions' ? sessionsSection.query : coursesSection.query}
            onChange={(event) => {
              const value = event.target.value;
              if (tab === 'sessions') sessionsSection.setQuery(value);
              else {
                // Searching switches to a flat result list. End inline folder
                // creation, and any folder rename, explicitly before changing
                // that tree structure — neither row exists in the flat list.
                if (value && newFolderOpen) setNewFolderOpen(false);
                if (value && renamingFolderId) setRenamingFolderId(null);
                coursesSection.setQuery(value);
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              if (tab === 'sessions') sessionsSection.setQuery('');
              else coursesSection.setQuery('');
            }}
            placeholder={t('workspace.searchPlaceholder')}
            aria-label={t('workspace.searchAria', {
              section:
                tab === 'sessions'
                  ? t('workspace.sections.sessions')
                  : t('workspace.sections.courses'),
            })}
            className="ws-find-input min-w-0 flex-1"
          />
        </div>
        {tab === 'courses' ? (
          <>
            <button
              type="button"
              data-testid="pro-nav-import-course"
              onClick={() => {
                coursesSection.setQuery('');
                courses.triggerImport();
              }}
              disabled={courses.importing}
              aria-label={t('import.classroom')}
              title={t('import.classroom')}
              className="ws-find-icon disabled:pointer-events-none disabled:opacity-50"
            >
              <Upload className="size-4" aria-hidden="true" />
            </button>
            {foldersAvailable ? (
              <button
                type="button"
                data-testid="pro-nav-new-folder"
                onClick={() => {
                  coursesSection.setQuery('');
                  setNewFolderOpen(true);
                }}
                aria-expanded={newFolderOpen}
                aria-controls={newFolderOpen ? 'pro-nav-inline-new-folder' : undefined}
                aria-label={t('classroom.newFolderTitle')}
                title={t('classroom.newFolderTitle')}
                className="ws-find-icon"
              >
                <FolderPlus className="size-4" aria-hidden="true" />
              </button>
            ) : null}
          </>
        ) : null}
      </div>

      <div
        role="tabpanel"
        id="pro-nav-tabpanel"
        data-testid="pro-nav-tabpanel"
        aria-labelledby={`pro-nav-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2 pt-1.5"
      >
        {tab === 'sessions' ? (
          <RailList
            id="sessions"
            title={t('workspace.sections.sessions')}
            count={sessions.length}
            state={sessionState}
            emptyLabel={t('workspace.sessionsEmpty')}
            onRetry={onReloadSessions}
          >
            {sessionsSection.query.trim() && matchedSessions.length === 0 ? (
              <RailEmpty label={t('workspace.searchEmpty')} />
            ) : (
              <PagedRows
                id="sessions"
                items={matchedSessions}
                initial={SESSION_ROW_LIMIT}
                pages={pagesFor(pages, 'sessions')}
                onMore={() => openPage('sessions', matchedSessions, SESSION_ROW_LIMIT)}
                onCollapse={() => collapsePage('sessions')}
                render={(session) => renderSessionRow(session)}
              />
            )}
          </RailList>
        ) : (
          <RailList
            id="courses"
            title={t('workspace.sections.courses')}
            count={orderedCourses.length}
            state={courses.state}
            emptyLabel={t('workspace.coursesEmpty')}
            onRetry={courses.reload}
          >
            {!foldersAvailable ? (
              renderCourseList(matchedOwned, 'unfiled')
            ) : searchingCourses ? (
              // Flattened: folders are not a filter, they are a location, and a
              // search that only looked inside the open one would lie. It stays
              // inside this tab's own population — searching your work does not
              // silently start returning other people's.
              matchedOwned.length === 0 ? (
                <RailEmpty label={t('workspace.searchEmpty')} />
              ) : (
                renderCourseList(matchedOwned, 'search-owned')
              )
            ) : (
              <>
                {newFolderOpen ? (
                  <InlineNewFolderRow
                    folders={courses.folders}
                    onCreate={handleCreateFolder}
                    onCancel={() => setNewFolderOpen(false)}
                  />
                ) : null}

                {tree.groups.map((group) => {
                  const open = openFolders.has(group.folder.id);
                  return (
                    <div key={group.folder.id}>
                      {group.folder.id === renamingFolderId ? (
                        <InlineNameRow
                          testId={`pro-nav-folder-rename-${group.folder.id}`}
                          initialName={group.folder.name}
                          placeholder={t('classroom.folderNamePlaceholder')}
                          ariaLabel={t('classroom.folderNameLabel')}
                          maxLength={80}
                          leading={<span className="ws-tree-lead" aria-hidden="true" />}
                          inputClassName="ws-folder-name"
                          onSubmit={(name) => submitFolderRename(group.folder.id, name)}
                          onClose={() => setRenamingFolderId(null)}
                        />
                      ) : (
                        // The wrapper, not the button, carries the drop target and
                        // the hover state: the ⋯ is a SIBLING of the disclosure
                        // button (never a button inside a button), and a course
                        // dropped anywhere on the row — glyph, name, count, menu —
                        // is filed into this folder.
                        <div
                          {...(drag.folderProps(group.folder.id) as Record<string, string>)}
                          className={cn(
                            'ws-row-wrap ws-row-wrap-actionable group relative flex items-center',
                            drag.folderTarget === group.folder.id && 'ws-drop-into',
                          )}
                        >
                          <button
                            type="button"
                            data-testid={`pro-nav-folder-${group.folder.id}`}
                            aria-expanded={open}
                            onClick={() => toggleIn(openFolders, setOpenFolders, group.folder.id)}
                            title={group.folder.name}
                            className="ws-row ws-folder-row ws-tree-row flex min-w-0 flex-1 items-center px-2 text-left"
                          >
                            {/* The one leading glyph in the tree. A folder is the
                                only row kind that carries one, and its name
                                therefore sits one glyph in — that offset IS the
                                hierarchy. Courses and chats reserve nothing, so
                                their names start at the panel's own edge. Open /
                                closed is the disclosure state; there is no
                                separate twisty to read as well. */}
                            <span className="ws-tree-lead" aria-hidden="true">
                              {open ? (
                                <FolderOpen className="size-4" aria-hidden="true" />
                              ) : (
                                <Folder className="size-4" aria-hidden="true" />
                              )}
                            </span>
                            {/* A folder heads the group beneath it, so it carries a
                                touch more weight than the rows it contains — without
                                becoming a second section label. */}
                            <span className="ws-folder-name min-w-0 flex-1 truncate">
                              {group.folder.name}
                            </span>
                            {group.courses.length > 0 ? (
                              // Same class as a course's page count, so the numbers
                              // land in one right column.
                              <span className="ws-row-meta shrink-0">{group.courses.length}</span>
                            ) : null}
                          </button>
                          <div data-ws-no-drag="true" className="ws-row-trailing absolute right-1">
                            <WorkspaceRowMenu
                              testId={`pro-nav-folder-more-${group.folder.id}`}
                              label={group.folder.name}
                              onRename={() => setRenamingFolderId(group.folder.id)}
                              // Asked as a question rather than confirmed in the
                              // menu: unlike a row delete this one moves courses,
                              // and that consequence needs a sentence.
                              onDelete={() => setFolderToDelete(group.folder)}
                              deleteAsksElsewhere
                            />
                          </div>
                        </div>
                      )}
                      {open ? (
                        <div className="ws-nest">
                          {group.courses.length === 0 ? (
                            <RailEmpty label={t('classroom.emptyFolderHint')} />
                          ) : (
                            renderCourseList(group.courses, `folder-${group.folder.id}`)
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}

                {/* Courses that are in no folder are not a group: they are
                    ROWS, flat at the tree's top level, under the folders. The
                    tree used to wrap them in an "unfiled" container — a head, a
                    count and a twisty around "everything that has no head" —
                    which made the common case (an account with a few folders
                    and a hundred loose courses) pay a collapsible section for
                    the absence of filing, and let one press hide the bulk of
                    the list behind a row that names nothing. Filed courses sit
                    inside their folder; everything else sits in the tree. The
                    page window is still one per list (`unfiled`), because this
                    is still exactly one unbounded list.

                    NOT indented: an inset would put these rows at the same
                    depth as a folder's members and read as membership in the
                    folder directly above them, which is the one thing the
                    retired head was good for. A hair of space says "different
                    kind of row" without claiming a container. */}
                <div className={cn('space-y-px', tree.groups.length > 0 && 'ws-loose')}>
                  {renderCourseList(tree.ungrouped, 'unfiled')}
                </div>
              </>
            )}
          </RailList>
        )}
        {/* The tree's blank ground, as a destination — Finder's own gesture.
            Filing is a drop onto a folder row; UNFILING needs somewhere to drop
            too, and the row that used to serve ("unfiled") is gone. So the
            empty space below the tree takes the drop: it is armed only while a
            course is in flight, it says what it will do, and it lights up whole
            when the pointer is actually over it. It is pinned to the panel's
            foot
            (see `.ws-ground-drop`) because a tree this deep would otherwise put
            it out of reach exactly when it is needed.

            It is a SIBLING of the rows, never their ancestor — `useTreeDrag`
            hit-tests with `closest()`, so a zone wrapping the tree would turn
            every row into an unfile target and break reordering outright. And
            the 1px gaps between rows are not inside it, which is why hovering
            between two rows still commits nothing. */}
        {tab === 'courses' && foldersAvailable ? (
          <TreeGroundDrop
            armed={drag.dragKind === 'course'}
            active={drag.folderTarget === ''}
            dropProps={drag.folderProps()}
          />
        ) : null}
      </div>

      <RailUtilities />

      {resizeHandle}

      {/* Deleting a folder does something to the courses inside it, so it is
          asked as a question with that consequence stated — not the two-press
          confirm a row delete gets. Only the keeping mode is offered (see
          `deleteFolderKeepingCourses`). */}
      <AlertDialog
        open={folderToDelete !== null}
        onOpenChange={(next) => {
          if (!next) setFolderToDelete(null);
        }}
      >
        <AlertDialogContent data-testid="pro-nav-folder-delete-dialog" className="sm:max-w-[400px]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('classroom.deleteFolderTitle', { name: folderToDelete?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('workspace.folderDeleteHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="pro-nav-folder-delete-confirm"
              onClick={() => {
                const folder = folderToDelete;
                setFolderToDelete(null);
                if (folder) void deleteFolderKeepingCourses(folder.id);
              }}
            >
              {t('workspace.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}

/* ── Rail lists ───────────────────────────────────────────────────────── */

interface ListSearch {
  readonly query: string;
  readonly setQuery: (value: string) => void;
  readonly searchOpen: boolean;
  readonly openSearch: () => void;
  readonly closeSearch: () => void;
}

/**
 * One list's filter state. Called once per list, and per-list is the point:
 * each tab keeps its own query, so switching tabs does not carry a search
 * across to a population it was never typed against.
 *
 * Collapse used to live here too. It does not any more — the chat and course
 * lists are collapsed by choosing the OTHER tab.
 */
function useListSearch(): ListSearch {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  return {
    query,
    setQuery,
    searchOpen,
    openSearch: () => setSearchOpen(true),
    closeSearch: () => {
      setSearchOpen(false);
      setQuery('');
    },
  };
}

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
function InlineNameRow({
  testId,
  initialName,
  placeholder,
  ariaLabel,
  maxLength,
  leading,
  inputClassName,
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
        className="ws-row ws-inline-folder ws-tree-row flex w-full items-center px-2"
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
 * The blank ground under the tree, as the place a course is dropped to leave
 * its folder.
 *
 * Invisible and inert at rest — it is just the breathing room at the foot of
 * the list. While a course is being carried it becomes a stated destination
 * (a dashed outline and one line of copy), and it fills whole the moment the
 * pointer is over it, which is the same "this is a container, not an insertion
 * point" language a folder row speaks.
 */
function TreeGroundDrop({
  armed,
  active,
  dropProps,
}: {
  readonly armed: boolean;
  readonly active: boolean;
  readonly dropProps: Record<string, unknown>;
}) {
  const { t } = useI18n();
  return (
    <div
      data-testid="pro-nav-tree-ground-drop"
      data-armed={armed ? 'true' : 'false'}
      {...(dropProps as Record<string, string>)}
      className={cn('ws-ground-drop', armed && 'ws-ground-drop-armed', active && 'ws-drop-into')}
    >
      {armed ? <span className="ws-ground-drop-label">{t('workspace.dropToUnfile')}</span> : null}
    </div>
  );
}

/** A folder row in the course tree while its name is being entered. */
function InlineNewFolderRow({
  folders,
  onCreate,
  onCancel,
}: {
  readonly folders: readonly { readonly name: string }[];
  readonly onCreate: (name: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    if (submitting) return;

    const widthCheck = validateFolderName(name);
    if (!widthCheck.ok) {
      setError(
        widthCheck.kind === 'empty'
          ? t('classroom.folderNameEmpty')
          : t('classroom.folderWidth', {
              width: widthCheck.width,
              max: FOLDER_NAME_MAX_WIDTH,
            }),
      );
      return;
    }

    const trimmed = name.trim();
    if (folders.some((folder) => folder.name.toLowerCase() === trimmed.toLowerCase())) {
      setError(t('classroom.folderNameExists'));
      return;
    }
    if (folders.length >= FOLDER_COUNT_LIMIT) {
      setError(t('classroom.folderCountLimit'));
      return;
    }

    setSubmitting(true);
    try {
      await onCreate(trimmed);
      onCancel();
    } catch (caught) {
      if (caught instanceof WorkspaceFolderNameError) {
        setError(
          caught.kind === 'duplicate'
            ? t('classroom.folderNameExists')
            : caught.kind === 'tooLong'
              ? t('classroom.folderWidth', {
                  width: displayNameWidth(trimmed),
                  max: FOLDER_NAME_MAX_WIDTH,
                })
              : caught.kind === 'limit'
                ? t('classroom.folderCountLimit')
                : t('classroom.folderNameHint'),
        );
      } else {
        setError(t('classroom.folderCreateFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div id="pro-nav-inline-new-folder">
      <form
        data-testid="pro-nav-inline-new-folder"
        className="ws-row ws-inline-folder ws-tree-row flex w-full items-center px-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {/* The tree's leading slot, with the glyph inside it: a creation row keeps
            saying WHAT is being created, and its input still starts in the same
            column as every name in the list. */}
        <span className="ws-tree-lead" aria-hidden="true">
          <Folder className="ws-glyph size-4" aria-hidden="true" />
        </span>
        <input
          ref={inputRef}
          data-testid="pro-nav-inline-new-folder-input"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            onCancel();
          }}
          placeholder={t('classroom.folderNamePlaceholder')}
          aria-label={t('classroom.folderNameLabel')}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'pro-nav-inline-new-folder-error' : undefined}
          maxLength={80}
          disabled={submitting}
          className="ws-inline-folder-input min-w-0 flex-1"
        />
        <button
          type="submit"
          data-testid="pro-nav-inline-new-folder-confirm"
          disabled={!name.trim() || submitting}
          aria-label={t('classroom.folderCreate')}
          title={t('classroom.folderCreate')}
          className="ws-inline-folder-action"
        >
          <Check className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          aria-label={t('common.cancel')}
          title={t('common.cancel')}
          className="ws-inline-folder-action"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </form>
      {error ? (
        <p
          id="pro-nav-inline-new-folder-error"
          role="alert"
          className="ws-inline-folder-error pb-1 pr-2 pt-0.5"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One tab's list, without a head of its own.
 *
 * The tab above it already carries the name, so repeating it here would rebuild
 * the stacked-section shape this pass replaced. The filter lives in the findrow
 * under the tab strip (see the rail's render); what is left here is the three
 * states a list can be in before it has any rows to show. `count` is read, not
 * rendered — it is how this component knows the list is empty.
 */
function RailList({
  id,
  title,
  state,
  count,
  emptyLabel,
  onRetry,
  children,
}: {
  readonly id: string;
  /** Names the region for assistive tech; the tab states it on screen. */
  readonly title: string;
  readonly state: HomeDiscoveryState;
  readonly count: number;
  readonly emptyLabel: string;
  readonly onRetry: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  const empty = count === 0;

  return (
    <section data-testid={`pro-nav-section-${id}`} aria-label={title} className="flex flex-col">
      <div className="space-y-px pb-1">
        {children}
        {empty && state === 'loading' ? (
          <div className="flex h-8 items-center gap-2 px-2">
            <span className="ws-skeleton h-2 w-24 animate-pulse rounded-full" />
          </div>
        ) : null}
        {empty && state === 'ready' ? <RailEmpty label={emptyLabel} /> : null}
        {empty && state === 'error' ? (
          <button
            type="button"
            onClick={onRetry}
            className="ws-row flex h-8 w-full items-center gap-1.5 px-2 text-left text-[12px]"
          >
            <span className="min-w-0 flex-1 truncate">{t('workspace.loadFailed')}</span>
            <RefreshCw className="size-3 shrink-0 opacity-60" aria-hidden="true" />
            <span className="sr-only">{t('workspace.retry')}</span>
          </button>
        ) : null}
      </div>
    </section>
  );
}

/* ── The tab switch ───────────────────────────────────────────────────── */

export interface RailTabSpec {
  readonly id: RailTab;
  readonly label: string;
}

/**
 * Chat | courses, over one body — a SEGMENTED CONTROL of two equal halves.
 *
 * It used to be an underline strip sized to its own labels and parked at the
 * left, on the reasoning that a filled segment reads as a mode while tabs read
 * as views. Two lists that take turns owning the whole body ARE a mode, and at
 * rail width the underline was the quietest mark in a column of louder ones:
 * the selected tab got a 2px hairline while every row beneath it could take a
 * filled pill. So the switch spends the width it has — one track, two halves,
 * the selected half on a raised solid ground — and becomes the first thing the
 * eye lands on under the compose button.
 *
 * The truncation the old shape was avoiding is real and is paid for in TYPE,
 * not in width: "COURSES" as a 10px uppercase label with 0.145em of tracking
 * does not fit in half of a 200px rail, so the label drops the case transform
 * and the tracking (see `.ws-navtab-label`). Same two words, a third narrower,
 * and still legible at the narrowest rail.
 *
 * NOTHING but the label. Each half used to carry its list's total; a switch is
 * for choosing which list you are looking at, and how many things are in the
 * other one is not part of that choice — the totals said nothing you could act
 * on and were the loudest numerals in the rail. No glyph either, for the same
 * reason: a two-word text label does not need one. Run state is likewise not
 * summarized here; it stays on the chat row inside the chat list.
 */
function RailTabs({
  tabs,
  active,
  onSelect,
}: {
  readonly tabs: readonly RailTabSpec[];
  readonly active: RailTab;
  readonly onSelect: (tab: RailTab) => void;
}) {
  const { t } = useI18n();
  const buttons = useRef(new Map<RailTab, HTMLButtonElement | null>());

  const step = (delta: 1 | -1) => {
    const index = tabs.findIndex((tab) => tab.id === active);
    if (index < 0) return;
    // Wraps, as the ARIA tabs pattern expects of a horizontal tablist.
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (!next) return;
    onSelect(next.id);
    buttons.current.get(next.id)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={t('workspace.tabsAria')}
      data-testid="pro-nav-tablist"
      className="ws-navtabs mx-3 flex shrink-0 items-stretch"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        step(event.key === 'ArrowRight' ? 1 : -1);
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              buttons.current.set(tab.id, node);
            }}
            type="button"
            role="tab"
            id={`pro-nav-tab-${tab.id}`}
            data-testid={`pro-nav-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls="pro-nav-tabpanel"
            // Roving tabindex: one stop for the whole strip, arrows inside.
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            title={tab.label}
            className="ws-navtab flex min-w-0 flex-1 items-center justify-center"
          >
            <span className="ws-navtab-label min-w-0 truncate">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function RailEmpty({ label }: { readonly label: string }) {
  return <p className="px-2 py-1.5 text-[12px] text-[color:var(--ws-ink-mute)]">{label}</p>;
}

/**
 * A list that reveals itself one page at a time.
 *
 * The arithmetic — how many rows are visible, how many the next press adds,
 * whether a collapse control belongs beside it — is `workspace-paging`'s; this
 * only renders it. Page counts are owned by the caller and keyed by `id`, so
 * every paged list in the rail shares one map instead of inventing its own
 * state.
 *
 * It composes with the two things around it because it touches neither:
 *  - SEARCH filters the array before it arrives here, and the caller resets
 *    every page count when a query changes, so a page window is never a window
 *    onto a list the user has since replaced;
 *  - DRAG-REORDER writes the full flat sequence through `workspace-order`, and
 *    the keyboard move walks the whole sub-list, not the visible slice — so a
 *    row can be moved past the window's edge, exactly as it could past the old
 *    cap, and the persisted order is never a function of what was on screen.
 */
function PagedRows<T>({
  id,
  items,
  initial,
  pages,
  onMore,
  onCollapse,
  render,
}: {
  readonly id: string;
  readonly items: readonly T[];
  readonly initial: number;
  readonly pages: number;
  readonly onMore: () => void;
  readonly onCollapse: () => void;
  readonly render: (item: T) => ReactNode;
}) {
  const { t } = useI18n();
  const { visible, nextCount, canCollapse } = pageList(items, pages, { initial });

  return (
    <>
      {visible.map(render)}
      {nextCount > 0 ? (
        <button
          type="button"
          data-testid={`pro-nav-show-more-${id}`}
          onClick={onMore}
          className="ws-more flex h-7 w-full items-center px-2 text-left text-[12px]"
        >
          {/* The count is what THIS press adds, not what the list is hiding:
              the old label offered "show more (124)" and meant it. */}
          {t('workspace.showMore', { count: nextCount })}
        </button>
      ) : null}
      {canCollapse ? (
        <button
          type="button"
          data-testid={`pro-nav-show-less-${id}`}
          onClick={onCollapse}
          className="ws-more flex h-7 w-full items-center px-2 text-left text-[12px]"
        >
          {t('workspace.showLess')}
        </button>
      ) : null}
    </>
  );
}

/**
 * The ⋯ shared by folder rows, authored course rows and chat rows.
 *
 * One menu shape for every maintainable row in the rail: rename first (it is
 * the one you press on purpose), then the destructive entry. The delete answers
 * in one of two places — in the menu, as a second press on the same item, or
 * elsewhere entirely (`deleteAsksElsewhere`) when the consequence needs a
 * sentence, as a folder's does.
 */
function WorkspaceRowMenu({
  testId,
  label,
  onRename,
  onDelete,
  deleteAsksElsewhere = false,
}: {
  readonly testId: string;
  readonly label: string;
  /** Absent on rows that cannot be renamed (a course somebody else authored). */
  readonly onRename?: () => void;
  readonly onDelete: () => Promise<void> | void;
  /** True when `onDelete` opens its own confirmation instead of deleting. */
  readonly deleteAsksElsewhere?: boolean;
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
          className="ws-row-action inline-flex size-6 shrink-0 items-center justify-center rounded-md"
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
            <DropdownMenuSeparator />
          </>
        ) : null}
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

function RailRow({
  testId,
  label,
  meta,
  metaTestId,
  leading,
  trailing,
  statusLabel,
  course = false,
  rowClassName,
  labelClassName,
  active = false,
  onClick,
  dragProps,
  dragging = false,
  dropEdge = null,
  onMove,
  trailingMark,
}: {
  readonly testId?: string;
  readonly label: string;
  readonly meta?: string | null;
  readonly metaTestId?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly statusLabel?: string;
  /** Course entries use the rail's tighter artifact row and stronger name. */
  readonly course?: boolean;
  readonly rowClassName?: string;
  readonly labelClassName?: string;
  readonly active?: boolean;
  readonly onClick: () => void;
  /** `useTreeDrag`'s row hooks — data attributes plus the pointer-down. */
  readonly dragProps?: Record<string, unknown>;
  readonly dragging?: boolean;
  readonly dropEdge?: 'before' | 'after' | null;
  /** Alt+↑/↓, the keyboard's version of the drag. */
  readonly onMove?: (delta: -1 | 1) => void;
  /**
   * A mark that belongs with the row's metadata, not before its name — a chat's
   * status dot / spinner. It renders after `meta` so a chat name and a course
   * name begin in the same column; a leading mark is what made the two tabs
   * disagree about where the column is.
   */
  readonly trailingMark?: ReactNode;
}) {
  return (
    // The row is a button; `trailing` (a menu) is a sibling, not a child, so
    // the markup never nests one button inside another.
    <div
      {...(dragProps as ComponentProps<'div'> | undefined)}
      className={cn(
        'ws-row-wrap group relative flex items-center',
        // Only a row that HAS an action hides its metadata to make room for it.
        trailing && 'ws-row-wrap-actionable',
        dragging && 'ws-row-dragging',
        dropEdge === 'before' && 'ws-drop-before',
        dropEdge === 'after' && 'ws-drop-after',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        onKeyDown={(event) => {
          // Alt, so the arrows keep moving the caret / the focus ring for
          // everyone who is merely reading the tree.
          if (!onMove || !event.altKey) return;
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          onMove(event.key === 'ArrowUp' ? -1 : 1);
        }}
        data-testid={testId}
        title={label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'ws-row flex min-w-0 flex-1 items-center px-2 text-left',
          // NO flex gap, on either row kind: the leading slot's own width is the
          // only space before the name and `.ws-row-meta`'s margin the only
          // space after it, so the whole leading column is one number and a
          // chat's name lands in the same column as a course's.
          'ws-tree-row',
          course && 'ws-course',
          rowClassName,
          active && 'ws-row-active',
        )}
      >
        {/* No leading slot on a course or a chat row: the name starts at the
            row's own `px-2`, which is the panel edge the eye is already on. Only
            a folder carries a glyph, and only a folder's name is offset by it.
            Nothing is drawn outside the row either — hover and selection are one
            pill filling it, so neither state can move the text by a pixel. */}
        {leading}
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate', labelClassName ?? 'text-[13px]')}>{label}</span>
        </span>
        {statusLabel ? <span className="sr-only">{statusLabel}</span> : null}
        {meta ? (
          <span data-testid={metaTestId} className="ws-row-meta shrink-0">
            {meta}
          </span>
        ) : null}
        {trailingMark}
      </button>
      {trailing ? (
        // Its own pointer semantics — a press here opens the menu, it never
        // starts a drag.
        <div data-ws-no-drag="true" className="ws-row-trailing absolute right-1">
          {trailing}
        </div>
      ) : null}
    </div>
  );
}

function SessionDot({ status }: { readonly status: ProHomeSessionItem['status'] }) {
  // Live states spin; EVERY other status — failed and the rest of the
  // terminal set — is a static dot, so a dead session can never render a
  // spinner even before the store's failure-status fix lands. Both marks sit
  // in the row's TRAILING metadata (`ws-status-slot`), beside the timestamp: a
  // chat's status is metadata like its time, and a leading mark was what made
  // every chat name start a slot right of every course name. The box is fixed
  // width so the spinner and the dot hold identical footprint and a running row
  // does not shift its neighbours.
  const live = status === 'running' || status === 'queued';
  return (
    <span aria-hidden="true" className="ws-status-slot">
      {live ? (
        <LoaderCircle className="ws-spin-live" />
      ) : (
        <span className={cn('ws-dot', status === 'failed' ? 'ws-dot-fail' : undefined)} />
      )}
    </span>
  );
}

/* ── Rail foot ────────────────────────────────────────────────────────── */

/**
 * The classic header's utilities, at the rail's foot.
 *
 * These are SiteHeader's own components — locale, theme, feedback, community
 * and the account entry each keep exactly one implementation. Nothing the
 * classic chrome offers is dropped; what changes is only which of them are on
 * the surface. Theme and account are one press away because they are pressed
 * daily; feedback and the community links are a press further, behind one
 * quiet ⋯, because a rail is navigation first and a settings bar second.
 *
 * The product ships no reusable notification bell (the only Bell in the tree
 * belongs to the community dialog), so there is nothing to cluster here for
 * notifications.
 */
function RailUtilities() {
  const { t } = useI18n();
  return (
    <div className="shrink-0" data-testid="pro-rail-utilities">
      <div className="ws-seam-rail mx-4" aria-hidden="true" />
      <div
        aria-label={t('workspace.utilitiesAria')}
        className="ws-utils flex items-center gap-0.5 px-3 py-2.5"
      >
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
    </div>
  );
}

/**
 * Widest the one-row panel can get (locale + feedback + separator + three
 * community icons). Only the viewport clamp uses it, so an estimate on the
 * generous side is exactly right — the panel itself is `max-content`.
 */
const OVERFLOW_WIDTH_PX = 240;

/**
 * The ⋯ at the foot, and the small panel it opens.
 *
 * Portalled to `.ws-root` rather than rendered in place, for two reasons that
 * are both about the rail: the rail carries `backdrop-filter`, which makes it
 * the containing block for any `position: fixed` descendant, and the rail is a
 * narrow column whose scrolling body clips. Escaping to the shell root fixes
 * both while keeping the `--ws-*` tokens (they are declared on `.ws-root`) and
 * the dark-mode variants in scope.
 */
export function RailOverflow({
  testId,
  mini = false,
  withLanguage = false,
}: {
  readonly testId: string;
  readonly mini?: boolean;
  /** Collapsed rails have no room for the locale switcher on the surface. */
  readonly withLanguage?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const ownerId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    const trigger = triggerRef.current;
    const rect = trigger?.getBoundingClientRect();
    if (!trigger || !rect) return;
    // Opens upward: this sits at the bottom of a full-height rail.
    setAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - OVERFLOW_WIDTH_PX - 8)),
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
    });
    setHost(trigger.closest<HTMLElement>('.ws-root') ?? document.body);
    setOpen(true);
  };

  // Focus moves into the panel on open: it is portalled to the end of the
  // tree, so Tab from the trigger would otherwise walk past it entirely.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (first ?? panel)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // The anchor is a snapshot of the trigger's box; anything that moves the
    // trigger (a resize, a pane scrolling) invalidates it, and a stale panel
    // is worse than no panel.
    return installFloatingLayerDismissListeners({
      ownerId,
      roots: () => [panelRef.current, triggerRef.current],
      onDismiss: close,
    });
  }, [open, close, ownerId]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t('workspace.moreUtilities')}
        title={t('workspace.moreUtilities')}
        className={mini ? 'ws-mini-btn' : 'ws-util-btn'}
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </button>
      {open && host && anchor
        ? createPortal(
            <FloatingLayerOwner ownerId={ownerId}>
              <div
                ref={panelRef}
                role="group"
                tabIndex={-1}
                data-testid={`${testId}-panel`}
                aria-label={t('workspace.moreUtilities')}
                className="ws-pop ws-utils"
                style={{ left: anchor.left, bottom: anchor.bottom }}
              >
                {withLanguage ? (
                  <span className="ws-pop-item" data-testid={`${testId}-language`}>
                    <LanguageSwitcher />
                  </span>
                ) : null}
              </div>
            </FloatingLayerOwner>,
            host,
          )
        : null}
    </>
  );
}

/**
 * The wordmark, as the way back to a bare `/workspace`.
 *
 * A real `<a>`, so the browser's own middle-click and ⌘-click still open a new
 * tab; a plain left click is intercepted and handed to the shell, which drops
 * `?session=` and `?course=` without a document load.
 */
function HomeLink({
  testId,
  onGoHome,
  className,
  children,
}: {
  readonly testId: string;
  readonly onGoHome: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <a
      href="/workspace"
      data-testid={testId}
      aria-label={t('workspace.homeAria')}
      title={t('workspace.homeAria')}
      onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onGoHome();
      }}
      className={cn('ws-home inline-flex shrink-0 items-center', className)}
    >
      {children}
    </a>
  );
}

/* ── Persisted view preferences ───────────────────────────────────────── */

const EMPTY_ORDER: readonly string[] = [];

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private mode, or storage disabled by policy: no preference, no crash.
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The change still took effect in this session; it just will not survive.
  }
}

function writeStoredOrder(key: string, order: readonly string[]): void {
  writeStored(key, serializeOrder(order));
}

/** Bucket → locale copy. The bucketing itself lives in `pro-home-data`, tested. */
function relativeLabel(
  timestamp: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const bucket = relativeBucket(timestamp, Date.now());
  if (!bucket) return null;
  switch (bucket.unit) {
    case 'now':
      return t('workspace.time.justNow');
    case 'minutes':
      return t('workspace.time.minutesAgo', { count: bucket.count });
    case 'hours':
      return t('workspace.time.hoursAgo', { count: bucket.count });
    case 'days':
      return t('workspace.time.daysAgo', { count: bucket.count });
    case 'date':
      return new Date(bucket.at).toLocaleDateString();
  }
}
