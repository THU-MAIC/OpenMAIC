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
 *  - ONE LIST: the conversations, newest first, like any chat app. Courses
 *    used to share the body with them behind a Chats | Courses switch; they
 *    now live on the My courses page in the main area, which carries the
 *    whole library (folders, import, filing, rename, delete, generating
 *    courses), so the rail is navigation and nothing else;
 *  - a chat row is its title and its relative time; only a state worth a mark
 *    replaces the time — a quiet spinner while it runs, a small alert when it
 *    failed. A finished run goes back to rest, with no "unread" dot;
 *  - long lists reveal one page at a time (`workspace-paging`), because this
 *    account can hold hundreds of chats and "reveal everything" is not a
 *    navigation;
 *  - above the list, the destinations: search (the global palette, ⌘K), my
 *    courses and the knowledge base (pages in the main area), then whatever
 *    the host registered (`lib/workbench/shell-extensions.tsx`);
 *  - at the foot, the account block. The workspace has no top bar, so its
 *    menu carries everything one would: language, theme, settings, the
 *    project's links, and the host's own entries (`WorkspaceAccount`);
 *  - rows are draggable: chats reorder against a hairline insertion line, and
 *    the resulting sequence is decided entirely by `workspace-order` — this
 *    file only wires the events;
 *  - every row carries the same hover-revealed ⋯ (`workspace-row-controls`):
 *    rename edits the name IN PLACE (the row becomes an input; Enter commits,
 *    Escape leaves it alone) and delete asks first.
 *
 * Collapsed, it becomes a 60px icon strip with the same items: the mark, the
 * expand button, new chat and search, one glyph per destination, the chat
 * list's glyph (which expands the rail into it), and the account avatar.
 *
 * It folds from its own header — the row with the wordmark —
 * with the same `PaneFoldButton` the conversation and the classroom use. It used
 * to fold from a pill floating in the middle of its seam, on the argument that
 * the rail had no header; that left one line carrying two meanings, because the
 * seam is also the rail's width drag. The seam now resizes and nothing else,
 * like the other two.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  BookOpen,
  Library,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  Search,
  SquarePen,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useBrand } from '@/lib/brand/brand-context';
import type { HomeDiscoveryState } from '@/lib/hooks/use-home-discovery';
import { cn } from '@/lib/utils/cn';
import { relativeBucket, type ProHomeSessionItem } from '@/lib/workbench/pro-home-data';
import {
  EMPTY_PAGES,
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
  SESSION_ORDER_STORAGE_KEY,
  type DropTarget,
} from '@/lib/workbench/workspace-order';
import { useTreeDrag, type DragKind } from './use-tree-drag';
import { PaneFoldButton } from './PaneFoldButton';
import { WorkspaceAccountBlock } from './WorkspaceAccount';
import {
  useWorkbenchShellExtensions,
  type WorkbenchShellIcon,
} from '@/lib/workbench/shell-extensions';
import { WORKSPACE_COURSES_VIEW, WORKSPACE_LIBRARY_VIEW } from '@/lib/workbench/workspace-panes';
import { deleteWorkspaceSession } from '@/lib/workbench/workspace-actions';
import { SESSION_TITLE_MAX_LENGTH, workbenchSessionTitle } from '@/lib/workbench/session-title';
import { InlineNameRow, WorkspaceRowMenu } from './workspace-row-controls';
import { shortcutLabel, useIsMac } from '@/lib/workbench/shortcuts';

/**
 * Rows the chat list shows before it pages: the list owns the rail's body,
 * and this is still a window, not a dump.
 */
const SESSION_ROW_LIMIT = 12;

export function WorkspaceRail({
  sessions,
  sessionState,
  onReloadSessions,
  activeSessionId,
  collapsed,
  onToggleCollapsed,
  onOpenSession,
  onNewSession,
  onGoHome,
  onSessionDeleted,
  onRenameSession,
  onOpenSearch,
  onOpenSettings,
  activeView,
  onOpenView,
  resizeHandle,
}: {
  readonly sessions: readonly ProHomeSessionItem[];
  readonly sessionState: HomeDiscoveryState;
  readonly onReloadSessions: () => void;
  readonly activeSessionId: string | null;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onOpenSession: (id: string) => void;
  /**
   * A new conversation in the middle column. Both entries below (the compose row
   * and its collapsed `+`) call this ONE handler, and it deliberately does not
   * touch the classroom pane — see `startNewConversation` in the shell.
   */
  readonly onNewSession: () => void;
  /** Back to the bare `/workspace` — the logo, and the shell's own handler. */
  readonly onGoHome: () => void;
  /** The shell drops the deleted chat's pane and URL param, once the server
   *  confirmed the delete. Rows are already gone optimistically down here. */
  readonly onSessionDeleted: (sessionId: string) => void;
  /**
   * Name a chat. The shell owns the write (one writer for this row and the
   * pane header both) and answers with a readable message when it is refused.
   */
  readonly onRenameSession: (sessionId: string, title: string) => Promise<string | null>;
  /** Open the global search palette (the shell owns it and its ⌘K). */
  readonly onOpenSearch: () => void;
  /** Open the model/provider settings (the shell owns the dialog: the search opens it too). */
  readonly onOpenSettings: () => void;
  /**
   * The main-area page on screen (`library`, `courses` or a host page id), or
   * null. Its destination row is marked current.
   */
  readonly activeView: string | null;
  /** Open a main-area page: my courses, the knowledge base, a host page. */
  readonly onOpenView: (view: string) => void;
  /** The width drag, owned by the shell (it writes the CSS variable on the root). */
  readonly resizeHandle: ReactNode;
}) {
  const { t } = useI18n();
  const brand = useBrand();

  // ── Row maintenance: rename in place, delete after a question ────────
  // Which row is currently an input: two rows cannot be renamed at once.
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);

  // "Search" opens the shell's global search palette (⌘K / Ctrl K), from the
  // expanded rail and the folded strip alike.
  const mac = useIsMac();
  const searchShortcut = shortcutLabel('search', mac);
  const newChatShortcut = shortcutLabel('newChat', mac);

  /*
   * The rail's destinations: the built-in pages, then whatever the host
   * registered (`WorkbenchShellExtensions.navItems`). A host item that renders
   * a page opens it in the main area like the built-ins do; one with a link
   * navigates.
   */
  const extensions = useWorkbenchShellExtensions();
  const destinations: readonly RailDestination[] = [
    {
      id: WORKSPACE_COURSES_VIEW,
      testId: 'pro-nav-my-courses',
      label: t('workspace.nav.myCourses'),
      icon: BookOpen,
      active: activeView === WORKSPACE_COURSES_VIEW,
      onSelect: () => onOpenView(WORKSPACE_COURSES_VIEW),
    },
    {
      id: WORKSPACE_LIBRARY_VIEW,
      testId: 'pro-nav-library',
      label: t('workspace.knowledgeBase.title'),
      icon: Library,
      active: activeView === WORKSPACE_LIBRARY_VIEW,
      onSelect: () => onOpenView(WORKSPACE_LIBRARY_VIEW),
    },
    ...(extensions.navItems ?? []).map(
      (item): RailDestination => ({
        id: item.id,
        testId: `pro-nav-host-${item.id}`,
        label: item.label,
        icon: item.icon,
        tag: item.tag,
        active: activeView === item.id,
        href: item.render ? undefined : item.href,
        external: item.external,
        onSelect: item.render ? () => onOpenView(item.id) : item.onSelect,
      }),
    ),
  ];

  // How many extra pages the list has revealed (see `workspace-paging`);
  // absent means "at rest".
  const [pages, setPages] = useState<PageMap>(EMPTY_PAGES);

  // ── Manual order ─────────────────────────────────────────────────────
  // A per-browser view preference (see `workspace-order`): read once on the
  // client, applied before the list is filtered.
  const [sessionOrder, setSessionOrder] = useState<readonly string[]>(EMPTY_ORDER);
  const [deletedSessionIds, setDeletedSessionIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    // localStorage does not exist during SSR and reading it while rendering
    // would make the first client paint disagree with the served HTML.
    setSessionOrder(parseOrder(readStored(SESSION_ORDER_STORAGE_KEY)));
  }, []);

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
  // to a concrete neighbour.
  const handleReorder = useCallback(
    (_kind: DragKind, dragId: string, target: DropTarget) => {
      const next = reorderIds(
        orderedSessions.map((session) => session.id),
        dragId,
        target,
      );
      setSessionOrder(next);
      writeStoredOrder(SESSION_ORDER_STORAGE_KEY, next);
    },
    [orderedSessions],
  );

  // Chats are never filed: a drop onto a folder cannot happen in this list.
  const drag = useTreeDrag({ onReorder: handleReorder, onMoveToFolder: () => {} });

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

  /**
   * The collapsed strip's chat glyph is a destination, not a second "expand"
   * button: it opens the rail onto the chat list it depicts.
   */

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
        <div className="flex shrink-0 flex-col items-center gap-1 pb-2 pt-3">
          <HomeLink testId="pro-nav-home-mini" onGoHome={onGoHome} className="mb-1 p-1">
            <img
              src={brand.markSrc}
              alt=""
              aria-hidden="true"
              className="size-7 shrink-0 object-contain"
            />
          </HomeLink>
          {/* The expanded header's fold keeps its slot's meaning here: the one
              control that brings the rail back as it was. */}
          <PaneFoldButton
            testId="pro-nav-expand"
            label={t('workspace.expandNav')}
            direction="right"
            expanded={false}
            className="ws-mini-btn"
            onClick={onToggleCollapsed}
          />
          <button
            type="button"
            data-testid="pro-workspace-new-session-mini"
            onClick={onNewSession}
            aria-keyshortcuts={newChatShortcut.aria}
            aria-label={t('workspace.newSession')}
            title={t('workspace.newSession')}
            className="ws-mini-btn"
          >
            <SquarePen className="size-[18px]" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="pro-nav-search-mini"
            onClick={onOpenSearch}
            aria-label={t('workspace.nav.search')}
            title={t('workspace.nav.search')}
            className="ws-mini-btn"
          >
            <Search className="size-[18px]" aria-hidden="true" />
          </button>
        </div>
        <div className="ws-mini-rule" aria-hidden="true" />
        <div className="flex flex-col items-center gap-1 py-2">
          {destinations.map((item) => (
            <RailDestinationButton key={item.id} item={item} mini />
          ))}
        </div>
        <div className="ws-mini-rule" aria-hidden="true" />
        <div className="flex flex-1 flex-col items-center gap-1 py-2">
          {/* The chat list is a destination too: its glyph reopens the rail. */}
          <button
            type="button"
            data-testid="pro-nav-mini-sessions"
            onClick={onToggleCollapsed}
            aria-label={expandLabel(t('workspace.sections.sessions'))}
            title={expandLabel(t('workspace.sections.sessions'))}
            aria-current={activeSessionId ? 'true' : undefined}
            aria-expanded={false}
            className="ws-mini-btn"
          >
            <MessagesSquare className="size-[18px]" aria-hidden="true" />
          </button>
        </div>
        <div
          aria-label={t('workspace.utilitiesAria')}
          data-testid="pro-rail-utilities-mini"
          className="flex shrink-0 flex-col items-center pb-3.5 pt-2"
        >
          <WorkspaceAccountBlock mini onOpenSettings={onOpenSettings} />
        </div>
      </nav>
    );
  }

  const renderSessionRow = (session: (typeof orderedSessions)[number]) => {
    const label = workbenchSessionTitle(session) ?? t('workspace.untitledSession');
    // Being renamed: the row IS the input, in place.
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
            orderedSessions.map((item) => item.id),
            delta,
          )
        }
        // A chat at rest shows when it last moved. A running one shows a quiet
        // spinner there instead, and a failed one a small alert; a run that
        // finished while the teacher was elsewhere simply returns to rest.
        meta={
          sessionRunning(session.status) || session.status === 'failed'
            ? null
            : relativeLabel(session.updatedAt || session.createdAt, t)
        }
        statusMark={
          sessionRunning(session.status) ? (
            <LoaderCircle
              role="img"
              aria-label={t(`workspace.sessionStatus.${session.status}`)}
              data-testid={`pro-nav-session-running-${session.id}`}
              className="ws-spin-live"
            />
          ) : session.status === 'failed' ? (
            <span
              role="img"
              aria-label={t('workspace.sessionStatus.failed')}
              title={t('workspace.sessionStatus.failed')}
              data-testid={`pro-nav-session-failed-${session.id}`}
              className="ws-row-fail"
            >
              <AlertCircle className="size-3.5" aria-hidden="true" />
            </span>
          ) : null
        }
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
      <div className="flex h-14 shrink-0 items-center gap-2 pl-4 pr-3">
        {/* The wordmark is the way home: back to the bare workspace. */}
        <HomeLink testId="pro-nav-home" onGoHome={onGoHome} className="-ml-1.5 px-1.5 py-1">
          <img
            src={brand.logoSrc}
            alt=""
            aria-hidden="true"
            className="ws-wordmark h-[22px] w-auto max-w-[128px] shrink-0"
          />
        </HomeLink>
        {/* THE rail's header, and therefore where the rail folds — the same
            button, in the same place, that the conversation and the classroom
            fold from. The seam only resizes. */}
        <PaneFoldButton
          testId="pro-nav-collapse"
          label={t('workspace.collapseNav')}
          direction="left"
          expanded
          className="ml-auto"
          onClick={onToggleCollapsed}
        />
      </div>

      {/* New chat: the one raised object in the rail. It starts a conversation
          and leaves an open classroom where it is (`startNewConversation`). */}
      <div className="shrink-0 px-2 pb-1.5 pt-1">
        <button
          type="button"
          data-testid="pro-workspace-new-session"
          onClick={onNewSession}
          aria-keyshortcuts={newChatShortcut.aria}
          className="ws-new flex h-[38px] w-full min-w-0 items-center gap-2.5 rounded-[10px] px-[9px] text-[13.5px] font-medium focus-visible:outline-none"
        >
          <SquarePen className="size-[18px] shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{t('workspace.newSession')}</span>
          <kbd
            data-testid="pro-workspace-new-session-shortcut"
            className="ws-kbd"
            aria-hidden="true"
          >
            {newChatShortcut.label}
          </kbd>
        </button>
      </div>

      {/* Destinations: search, the built-in pages, then the host's. */}
      <div
        className="flex shrink-0 flex-col gap-px px-2 pb-1 pt-1"
        data-testid="pro-nav-destinations"
      >
        <button
          type="button"
          data-testid="pro-nav-search"
          onClick={onOpenSearch}
          aria-keyshortcuts={searchShortcut.aria}
          className="ws-nav-item"
        >
          <Search className="size-[18px] shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-left">{t('workspace.nav.search')}</span>
          <kbd data-testid="pro-nav-search-shortcut" className="ws-kbd" aria-hidden="true">
            {searchShortcut.label}
          </kbd>
        </button>
        {destinations.map((item) => (
          <RailDestinationButton key={item.id} item={item} />
        ))}
      </div>

      <div className="ws-seam-rail mx-4 my-2 shrink-0" aria-hidden="true" />

      <div
        data-testid="pro-nav-list"
        className="ws-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2 pt-1.5"
      >
        <RailList
          id="sessions"
          title={t('workspace.sections.sessions')}
          count={sessions.length}
          state={sessionState}
          emptyLabel={t('workspace.sessionsEmpty')}
          onRetry={onReloadSessions}
        >
          <PagedRows
            id="sessions"
            items={orderedSessions}
            initial={SESSION_ROW_LIMIT}
            pages={pagesFor(pages, 'sessions')}
            onMore={() => openPage('sessions', orderedSessions, SESSION_ROW_LIMIT)}
            onCollapse={() => collapsePage('sessions')}
            render={(session) => renderSessionRow(session)}
          />
        </RailList>
      </div>

      {/* The account block: who is here, and the menu with everything a top
          bar would otherwise carry (language, theme, settings, the project's
          links, and the host's own entries). */}
      <div
        className="ws-rail-foot shrink-0 px-2.5 pb-2.5 pt-2"
        aria-label={t('workspace.utilitiesAria')}
        data-testid="pro-rail-utilities"
      >
        <WorkspaceAccountBlock onOpenSettings={onOpenSettings} />
      </div>

      {resizeHandle}
    </nav>
  );
}

/* ── Rail lists ───────────────────────────────────────────────────────── */

/**
 * The chat list, without a head of its own: the three states a list can be
 * in before it has any rows to show. `count` is read, not
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
  /** Names the region for assistive tech. */
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

function RailRow({
  testId,
  label,
  meta,
  metaTestId,
  statusMark,
  trailing,
  rowClassName,
  labelClassName,
  active = false,
  onClick,
  dragProps,
  dragging = false,
  dropEdge = null,
  onMove,
}: {
  readonly testId?: string;
  readonly label: string;
  readonly meta?: string | null;
  readonly metaTestId?: string;
  /** A state worth a mark (running, failed), in the metadata's place. */
  readonly statusMark?: ReactNode;
  readonly trailing?: ReactNode;
  readonly rowClassName?: string;
  readonly labelClassName?: string;
  readonly active?: boolean;
  /** Absent: the row is shown but cannot be acted on (`aria-disabled`). */
  readonly onClick?: () => void;
  /** `useTreeDrag`'s row hooks — data attributes plus the pointer-down. */
  readonly dragProps?: Record<string, unknown>;
  readonly dragging?: boolean;
  readonly dropEdge?: 'before' | 'after' | null;
  /** Alt+↑/↓, the keyboard's version of the drag. */
  readonly onMove?: (delta: -1 | 1) => void;
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
        aria-disabled={onClick ? undefined : true}
        className={cn(
          'ws-row flex min-w-0 flex-1 items-center px-2 text-left',
          // NO flex gap: `.ws-row-meta`'s margin is the only space after the name.
          'ws-tree-row',
          rowClassName,
          active && 'ws-row-active',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate', labelClassName ?? 'text-[13px]')}>{label}</span>
        </span>
        {meta ? (
          <span data-testid={metaTestId} className="ws-row-meta shrink-0">
            {meta}
          </span>
        ) : null}
        {statusMark ? (
          <span className="ws-row-meta ws-row-status shrink-0">{statusMark}</span>
        ) : null}
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
/* ── Destinations ─────────────────────────────────────────────────────── */

interface RailDestination {
  readonly id: string;
  readonly testId: string;
  readonly label: string;
  readonly icon: WorkbenchShellIcon;
  readonly active: boolean;
  readonly tag?: string;
  readonly href?: string;
  readonly external?: boolean;
  readonly onSelect?: () => void;
}

/**
 * One destination row (or, folded, one glyph): a page in the main area, or a
 * link out. The current page is marked `aria-current` and raised.
 */
function RailDestinationButton({
  item,
  mini = false,
}: {
  readonly item: RailDestination;
  readonly mini?: boolean;
}) {
  const Icon = item.icon;
  const className = mini ? cn('ws-mini-btn', item.active && 'ws-mini-on') : 'ws-nav-item';
  const content = mini ? (
    <Icon className="size-[18px]" aria-hidden />
  ) : (
    <>
      <Icon className="size-[18px] shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.tag ? <span className="ws-nav-tag">{item.tag}</span> : null}
    </>
  );
  if (item.href && !item.onSelect) {
    return (
      <a
        href={item.href}
        data-testid={item.testId}
        aria-label={mini ? item.label : undefined}
        title={mini ? item.label : undefined}
        className={className}
        {...(item.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      data-testid={item.testId}
      onClick={item.onSelect}
      aria-current={item.active ? 'page' : undefined}
      aria-label={mini ? item.label : undefined}
      title={mini ? item.label : undefined}
      className={className}
    >
      {content}
    </button>
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

/** A chat whose run is under way (the owner list's live statuses). */
function sessionRunning(status: ProHomeSessionItem['status']): boolean {
  return status === 'running' || status === 'queued';
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
