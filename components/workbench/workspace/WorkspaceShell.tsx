'use client';

/**
 * The Pro workspace — `/workspace`, and the only Pro surface there is.
 *
 * Three independent panes: navigation, the agent conversation, the classroom.
 * Full-viewport, no global header (`AppChrome` suppresses SiteHeader on this
 * path), which is the whole reason Pro mode became a route instead of a
 * `useState` on the homepage.
 *
 * ── What is open is mirrored into the URL ────────────────────────────────
 *
 *   /workspace                               home (hero + composer + discover)
 *   /workspace?session=<id>                  navigation + conversation
 *   /workspace?course=<stageId>              navigation + classroom
 *   /workspace?session=<id>&course=<stageId> all three
 *
 * The mounted workspace owns the live pane state; the two params are its
 * deep-link/history projection. Query-only changes use the native History API
 * rather than starting a new App Router navigation. The params are independent,
 * and that independence is the point: an
 * agent session and a course are MANY-TO-MANY here. A session's server-side
 * stage never moves — the runner writes where it always wrote — but what the
 * classroom pane shows is the user's choice, made in the tree. Opening a
 * session therefore mounts the conversation and nothing else; the course
 * beside it is opened, switched and closed independently, and the
 * conversation does not so much as re-render when it changes (the panes are
 * siblings, so a course switch cannot unmount the chat and lose its draft).
 *
 * A course opened with NO session is the one asymmetry: a Pro editing bench with
 * no conversation beside it cannot be talked to at all, so `?course=` alone
 * carries the user's most recent conversation into the middle column — or, for a
 * user who has none, shows an empty composer whose first message creates one.
 * The one exception is an explicit "new chat", which keeps the classroom and puts
 * that empty composer in the middle column instead of carrying anything over.
 * Nothing is minted on arrival, and it is never "the session that owns this
 * course". The classroom keeps rendering (and reading) throughout. See
 * `lib/workbench/course-chat-bootstrap.ts`.
 *
 * ── What the panes are made of ───────────────────────────────────────────
 *
 * Nothing here is a second implementation. The conversation is
 * `WorkbenchChat` on the same session store and the same SSE attach; the
 * classroom is `ClassroomSurface`, the exact component `/classroom/[id]`
 * mounts, hosted through `WorkbenchPanelProvider` so it drops the chrome the
 * pane already provides. The visual layer is `workspace-shell.css`, scoped
 * under `.ws-root` and imported from this file so it never reaches `/`.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
// The workspace's visual layer. Imported HERE rather than from `globals.css`
// so it lands in this route's CSS chunk only — `/` must not receive it.
import '../workspace-shell.css';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useHomeDiscovery, type HomeDiscoveryState } from '@/lib/hooks/use-home-discovery';
import {
  reconcileAttachedSessionStatus,
  type ProHomeSessionItem,
} from '@/lib/workbench/pro-home-data';
import { OwnerSessionClient } from '@/lib/workbench/owner-session-client';
import { resolveCourseChatBootstrap } from '@/lib/workbench/course-chat-bootstrap';
import { startConversationWithFirstMessage } from '@/lib/workbench/first-message-session';
import { startProSwap } from '@/lib/workbench/pro-swap';
import { createdCourseTabsToOpen } from '@/lib/workbench/created-course-tabs';
import {
  clampRailWidth,
  parseRailWidth,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_STORAGE_KEY,
} from '@/lib/workbench/workspace-navigation';
import {
  activateCourseTab,
  CHAT_COLLAPSED_STORAGE_KEY,
  CHAT_WIDTH_DEFAULT,
  CHAT_WIDTH_STORAGE_KEY,
  CLASSROOM_COLLAPSED_STORAGE_KEY,
  clampChatWidth,
  closeCourseTab,
  NAV_COLLAPSED_STORAGE_KEY,
  NO_COURSE_TABS,
  openCourseTab,
  openCourseTabs,
  parseChatWidth,
  parseCollapsed,
  readWorkspacePanes,
  resolveWorkspaceRender,
  restoreCourseTabs,
  samePanes,
  withCourse,
  withSession,
  type WorkspacePanes,
} from '@/lib/workbench/workspace-panes';
import { useWorkspacePaneNavigation } from '@/lib/workbench/use-workspace-pane-navigation';
import { readCourseTabsMemory, writeCourseTabsMemory } from '@/lib/workbench/workspace-course-tabs';
import {
  forgetWorkspaceSession,
  readLastWorkspaceSessionId,
  rememberWorkspaceHome,
  rememberWorkspaceSession,
  validateRememberedWorkspaceSession,
} from '@/lib/workbench/workspace-session-memory';
import type { WorkbenchCourseSummary } from '@/lib/workbench/panel-context';
import { useWorkbenchStore, type WorkbenchMaterial } from '@/lib/workbench/session-store';
import { renameWorkbenchSession } from '@/lib/workbench/session-store';
import { commitSessionRename, createSessionRenameQueue } from '@/lib/workbench/session-title';
import type { ElementRef } from '@/lib/workbench/element-refs';
import type { CourseRef } from '@/lib/workbench/course-refs';
import { useStageFreshnessSync, useWorkbenchStream } from '@/lib/workbench/use-workbench-session';
import { useGeneratedCourseDiscoverySync } from '@/lib/workbench/course-discovery-sync';
import { useStageStore } from '@/lib/store/stage';
import { WorkspaceRail } from './WorkspaceRail';
import { WorkspaceHome } from './WorkspaceHome';
import { WorkspaceChatPane } from './WorkspaceChatPane';
import { WorkspaceClassroomPane } from './WorkspaceClassroomPane';
import { PaneTab } from './PaneTab';
import { ResizeHandle } from './ResizeHandle';

const EMPTY_SESSIONS: ProHomeSessionItem[] = [];

/**
 * Below this width the conversation and the classroom no longer both fit at
 * their minimums, so they become mutually exclusive: one is shown, the other
 * leaves its reopen tab. Deliberately not an overlay — a modal chat over a
 * classroom is a third layout to reason about, and this surface already has
 * three panes.
 */
const BOTH_PANES_MIN_PX = 1024;
const SESSION_LIST_TIMEOUT_MS = 15_000;
// A shell is replaceable navigation UI, not a persistence boundary. Keeping the
// queue in this client module preserves one writer per session across remounts.
const sessionRenameQueue = createSessionRenameQueue();

async function fetchSessions(): Promise<ProHomeSessionItem[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SESSION_LIST_TIMEOUT_MS);
  try {
    const response = await fetch('/api/agent/sessions', {
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('invalid list response');
    return body as ProHomeSessionItem[];
  } finally {
    clearTimeout(timeout);
  }
}

function syncAttachedSessionTitle(sessionId: string, title: string | null): void {
  const store = useWorkbenchStore.getState();
  if (store.sessionId !== sessionId) return;
  store.setSessionTitle(title);
}

/**
 * Route seam: capture the deep link exactly once. Native History API writes
 * update Next's search-param readers, while the controller below keeps its own
 * live pane state and never treats those mirrored values as a second writer.
 */
export function WorkspaceShell() {
  const searchParams = useSearchParams();
  const [initialPanes] = useState(() => readWorkspacePanes(searchParams));
  return <WorkspaceShellController initialPanes={initialPanes} />;
}

function WorkspaceShellController({ initialPanes }: { readonly initialPanes: WorkspacePanes }) {
  const { t } = useI18n();
  const router = useRouter();
  const navigation = useWorkspacePaneNavigation(initialPanes);

  // Discover-only: course management lives in the navigation tree.
  const courses = useHomeDiscovery({ mode: 'discover-only' });
  const [sessions, setSessions] = useState<ProHomeSessionItem[]>(EMPTY_SESSIONS);
  /**
   * The latest list, readable from queued callbacks without waiting for React
   * to commit another render. The owner publisher updates it before setState.
   */
  const sessionsRef = useRef(sessions);
  const [sessionState, setSessionState] = useState<HomeDiscoveryState>('loading');
  const [composerReset, setComposerReset] = useState(0);
  /**
   * The user asked for a NEW conversation and a classroom is open beside it.
   *
   * Needed because dropping `?session=` is not by itself a request for a new
   * chat: `resolveCourseChatBootstrap` would adopt the most recent conversation,
   * which is the one just left, and the button would read as doing nothing. Set
   * by the new-chat action, cleared by anything that explicitly puts a
   * conversation back in the column.
   */
  const [newConversationRequested, setNewConversationRequested] = useState(false);
  const ownerSessionClient = useRef<OwnerSessionClient | null>(null);
  const shellGeneration = useRef(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const railWidth = useRailWidth(rootRef);
  const chatWidth = useChatWidth();

  const panes = navigation.panes;
  const [rememberedResumeSessionId] = useState(() => {
    const remembered = readLastWorkspaceSessionId();
    return initialPanes.courseId === null && initialPanes.sessionId === remembered
      ? remembered
      : null;
  });
  useEffect(() => {
    if (panes.sessionId) {
      rememberWorkspaceSession(panes.sessionId);
    } else if (!panes.courseId) {
      rememberWorkspaceHome();
    }
  }, [panes.courseId, panes.sessionId]);
  const collapse = usePaneCollapse();
  const [courseTabs, setCourseTabs] = useState(() => restoreCourseTabs(null, panes.courseId));
  const narrow = useNarrowViewport();
  // Which of the two content panes has the column, on a window too narrow for
  // both. Not persisted: it is a consequence of the window, not a preference.
  const [narrowFocus, setNarrowFocus] = useState<'chat' | 'classroom'>('classroom');

  const playbackOn = useWorkbenchStore((s) => s.playbackOn);
  // Read here rather than beside the other session wires below: what the store is
  // attached to decides whether the middle column has a conversation at all, and
  // therefore feeds the layout.
  const attachedSessionId = useWorkbenchStore((s) => s.sessionId);

  /* ── A course opened on its own gets its conversation ──────────────────
     `?course=` with no `?session=` used to be "nav + classroom": a Pro editing
     bench with no agent beside it. Then it minted a conversation on arrival,
     which produced a fresh empty session every time the user opened a course —
     open, close the chat, open again, three rows in the rail.

     Now NOTHING is created here. A conversation already in the middle column is
     used as-is; otherwise the user's most recent conversation is carried over;
     and a user with no conversations at all gets an empty composer whose first
     message mints the session (`draftConversation`, further down, is that
     composer's creation path). Two consequences worth naming: there is no POST to
     coalesce or remember any more, so both idempotence guards are gone, and there
     is nothing for the server to refuse, so the refusal bookkeeping is gone with
     them.

     It still does NOT hunt for "the session that owns this course": the two
     columns are independent, and an agent is pointed at a classroom by being
     told (an `@course` mention), not by a stage id matching.
     See `lib/workbench/course-chat-bootstrap.ts`.

     The classroom keeps rendering throughout. Its own load and the manifest
     freshness stream are independent of which conversation sits beside it. */
  const courseChatBootstrap = useMemo(
    () =>
      resolveCourseChatBootstrap({
        courseId: panes.courseId,
        sessionId: panes.sessionId,
        attachedSessionId,
        newConversationRequested,
        sessions,
        sessionsLoaded: sessionState === 'ready',
      }),
    [
      attachedSessionId,
      newConversationRequested,
      panes.courseId,
      panes.sessionId,
      sessions,
      sessionState,
    ],
  );
  /** The course an empty, not-yet-created conversation is sitting beside. */
  const draftCourseId = courseChatBootstrap.kind === 'draft' ? courseChatBootstrap.courseId : null;

  const render = useMemo(
    () =>
      resolveWorkspaceRender({
        panes,
        collapse: collapse.value,
        playback: playbackOn,
        draftConversation: draftCourseId !== null,
      }),
    [panes, collapse.value, draftCourseId, playbackOn],
  );

  /**
   * The viewport override, applied on top of the resolved render so the pure
   * rules stay free of measurement.
   *
   * Below `BOTH_PANES_MIN_PX` the conversation and the classroom are mutually
   * EXCLUSIVE — but exclusive is not "one of them is gone": whichever is not
   * showing leaves its tab, and clicking a tab moves the focus to it. (An
   * earlier cut simply forced the chat closed at this width, which made its
   * reopen tab a button that did nothing.)
   */
  const exclusive = narrow && render.chat && render.classroom;
  const chatOpen = exclusive ? narrowFocus === 'chat' : render.chat;
  const classroomOpen = exclusive ? narrowFocus === 'classroom' : render.classroom;
  const chatTab = render.chatTab || (exclusive && narrowFocus !== 'chat');
  const classroomTab = render.classroomTab || (exclusive && narrowFocus !== 'classroom');
  /**
   * Who may fold, and what the seam is for.
   *
   * Each pane folds from ITS OWN header (`PaneFoldButton`), never from the seam:
   * a seam sits between two collapsible panes, so a fold on it can only speak
   * for one of them, and putting both there produced two reversed chevrons at one
   * height beside a third (the slide navigator's). The seam is now purely the
   * resize control, and it exists only while both panes are on screen — a folded
   * pane has no width to drag.
   */
  const bothPanesOnScreen = chatOpen && classroomOpen;

  const focusChat = () => {
    // The strip is the folded conversation's ONE way back, and it must work
    // whichever reason folded it: a narrow window's exclusivity, or the user's
    // own fold on the seam.
    collapse.expandChat();
    setNarrowFocus('chat');
  };
  const focusClassroom = () => {
    setNarrowFocus('classroom');
    collapse.expandClassroom();
  };

  /**
   * MOUNTED is not VISIBLE. A collapsed pane is hidden, never unmounted: the
   * conversation would lose its composer draft and its scroll position, and
   * the classroom would run its whole load again (clearing the media store and
   * the whiteboard history on the way) for a course that never changed. The
   * tab beside it is the affordance; `display: none` is the mechanism.
   */
  const chatMounted = panes.sessionId !== null || draftCourseId !== null;

  // The right pane has two lifecycle states: content, or no pane. When it is
  // closed (or no course has ever been opened for this conversation), chat
  // owns the main column; there is no synthetic empty right-hand surface.
  const chatFills = !classroomOpen;

  const loadSessions = useCallback((showLoading = false) => {
    ownerSessionClient.current?.requestFullFetch(showLoading);
  }, []);

  const publishOwnerSessions = useCallback(
    (next: readonly ProHomeSessionItem[], source?: 'incremental' | 'snapshot') => {
      const snapshot = [...next];
      sessionsRef.current = snapshot;
      setSessions(snapshot);
      // Sparse owner events carry only their own field. A status publication
      // therefore has no authority over the title it happens to copy from the
      // client's current row; only a complete list snapshot may repair the
      // attached header here. Local renames and title events use their explicit
      // paths below.
      if (source !== 'snapshot') return;
      const attachedId = useWorkbenchStore.getState().sessionId;
      const attached = snapshot.find((session) => session.id === attachedId);
      if (attached) syncAttachedSessionTitle(attached.id, attached.title ?? null);
    },
    [],
  );

  useEffect(() => {
    const client = new OwnerSessionClient({
      fetchSessions,
      createEventSource: (url) => new EventSource(url),
      onSessions: publishOwnerSessions,
      onSessionTitle: syncAttachedSessionTitle,
      onState: setSessionState,
    });
    ownerSessionClient.current = client;
    client.start();
    return () => {
      shellGeneration.current += 1;
      ownerSessionClient.current = null;
      client.stop();
    };
  }, [publishOwnerSessions]);

  useEffect(() => {
    if (
      sessionState !== 'ready' ||
      !rememberedResumeSessionId ||
      panes.sessionId !== rememberedResumeSessionId
    ) {
      return;
    }
    if (
      validateRememberedWorkspaceSession(
        rememberedResumeSessionId,
        sessions.map((session) => session.id),
      )
    ) {
      return;
    }
    navigation.replace({ sessionId: null, courseId: null });
  }, [navigation, panes.sessionId, rememberedResumeSessionId, sessions, sessionState]);

  // ── Navigation ────────────────────────────────────────────────────────
  const goTo = useCallback(
    (next: WorkspacePanes) => {
      if (samePanes(next, panes)) return;
      navigation.push(next);
    },
    [navigation, panes],
  );

  const persistCourseTabs = useCallback((next: typeof courseTabs) => {
    writeCourseTabsMemory(next);
  }, []);

  /**
   * Reconcile the arrival URL's active course with local browser memory.
   * A pasted `?course=` always wins as active and joins the remembered set.
   * No `?course=` means the classroom is CLOSED, including on first arrival:
   * a remembered tab must never turn a session-only entry back into both panes.
   * After arrival, a missing course is an explicit close/home/history snapshot
   * and must never be overwritten by storage.
   * Session changes are irrelevant: every chat sees the same right-hand tab set.
   * The global minimise flag is intentionally untouched, so a remembered set
   * restores behind its reopen tab when that flag is set.
   */
  const courseTabsHydrated = useRef(false);
  useLayoutEffect(() => {
    // Storage restoration is an arrival concern, not a standing instruction.
    // Once mounted, a URL with no course means "the classroom is closed" — in
    // particular after Logo/home and browser Back. Re-reading storage on every
    // param change used to reopen the course and start a URL write-back loop.
    if (courseTabsHydrated.current) {
      const reconciled = panes.courseId
        ? restoreCourseTabs(courseTabs, panes.courseId)
        : courseTabs.activeCourseId === null
          ? courseTabs
          : NO_COURSE_TABS;
      if (reconciled !== courseTabs) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- browser history is an external system being reconciled into the local tab model
        setCourseTabs(reconciled);
        writeCourseTabsMemory(reconciled);
      }
      return;
    }

    // Pane presence comes from the URL, not storage. In particular the classic
    // homepage enters Pro with `?session=<last-opened>`; restoring an unrelated
    // remembered classroom here would immediately violate that explicit intent.
    if (!panes.courseId) {
      courseTabsHydrated.current = true;
      return;
    }

    // An explicit URL course opens even when it is absent from the rail; memory
    // only contributes the rest of the tab set around that explicit active id.
    const restored = restoreCourseTabs(readCourseTabsMemory(), panes.courseId);
    courseTabsHydrated.current = true;
    setCourseTabs(restored);
    writeCourseTabsMemory(restored);
    if (restored.activeCourseId !== panes.courseId) {
      navigation.replace(withCourse(panes, restored.activeCourseId));
    }
  }, [courseTabs, navigation, panes]);

  const openCourse = useCallback(
    (courseId: string) => {
      const next = openCourseTab(courseTabs, courseId);
      setCourseTabs(next);
      persistCourseTabs(next);
      collapse.expandClassroom();
      goTo(withCourse(panes, next.activeCourseId));
    },
    [collapse, courseTabs, goTo, panes, persistCourseTabs],
  );

  /**
   * Reconcile a BATCH of agent-created courses into the tab strip.
   *
   * An existing active classroom is explicit user intent and keeps focus; the
   * new courses join in the background. Only an empty classroom pane activates
   * the newest arrival. Historical `stage_link` replay used to steal focus from
   * a pasted/selected course and rewrite `?course=` a second time.
   */
  const openCourses = useCallback(
    (courseIds: readonly string[]) => {
      const opened = openCourseTabs(courseTabs, courseIds);
      const next = courseTabs.activeCourseId
        ? activateCourseTab(opened, courseTabs.activeCourseId)
        : opened;
      if (next === courseTabs) return;
      setCourseTabs(next);
      persistCourseTabs(next);
      if (!courseTabs.activeCourseId) {
        collapse.expandClassroom();
        goTo(withCourse(panes, next.activeCourseId));
      }
    },
    [collapse, courseTabs, goTo, panes, persistCourseTabs],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      setNewConversationRequested(false);
      collapse.expandChat();
      goTo(withSession(panes, sessionId));
    },
    [collapse, goTo, panes],
  );

  const openCreatedSession = useCallback(
    (sessionId: string) => {
      // Opening the pane is immediate, but the rail still needs a pull fallback
      // when the owner EventSource is reconnecting or missed session_created.
      loadSessions();
      openSession(sessionId);
    },
    [loadSessions, openSession],
  );

  const activateCourse = useCallback(
    (courseId: string) => {
      const next = activateCourseTab(courseTabs, courseId);
      if (next === courseTabs) return;
      setCourseTabs(next);
      persistCourseTabs(next);
      goTo(withCourse(panes, next.activeCourseId));
    },
    [courseTabs, goTo, panes, persistCourseTabs],
  );

  const closeCourse = useCallback(
    (courseId: string) => {
      const next = closeCourseTab(courseTabs, courseId);
      if (next === courseTabs) return;
      setCourseTabs(next);
      persistCourseTabs(next);
      goTo(withCourse(panes, next.activeCourseId));
    },
    [courseTabs, goTo, panes, persistCourseTabs],
  );

  /**
   * The attached chat was deleted from the rail. The URL is the only thing
   * still holding it open, so it has to move: the session param is dropped —
   * the course pane, its tabs, and its browser memory are independent and stay.
   * The rail's own row is already gone optimistically; this runs only after the
   * server confirmed the delete, so a failed delete never navigates (the row
   * comes back and the toast explains why).
   */
  const handleSessionDeleted = useCallback(
    (sessionId: string) => {
      forgetWorkspaceSession(sessionId);
      if (sessionId !== panes.sessionId) return;
      setNewConversationRequested(false);
      goTo(withSession(panes, null));
    },
    [goTo, panes],
  );

  /**
   * The title a chat is displaying right now, wherever it is displayed: the
   * rail row and — when this is the attached conversation — the pane header,
   * which reads its own copy out of the session store.
   */
  const applySessionTitle = useCallback(
    (sessionId: string, title: string | null, settled: boolean) => {
      syncAttachedSessionTitle(sessionId, title);
      const client = ownerSessionClient.current;
      const revision = client?.updateSessionTitle(sessionId, title, settled) ?? null;
      return { client, revision };
    },
    [],
  );

  /**
   * Rename a conversation. ONE writer for both surfaces that offer it — the
   * rail row's menu and the pane header — because two would be two chances for
   * the header and the list to end up showing different names for the same
   * chat. The sequence itself (optimistic write, settle on what the server
   * stored, roll back on refusal) lives in `commitSessionRename`.
   *
   * An empty box clears the override rather than storing a blank name: the
   * title goes back to being derived from the first message. Returns a message
   * on failure, null otherwise — the same contract the rail's course and folder
   * renames use.
   */
  const renameSession = useCallback(
    (sessionId: string, raw: string): Promise<string | null> => {
      const generation = shellGeneration.current;
      const isOriginCurrent = () => shellGeneration.current === generation;
      return sessionRenameQueue.run(sessionId, async (queued) => {
        const row = sessionsRef.current.find((session) => session.id === sessionId);
        const store = useWorkbenchStore.getState();
        const attached = store.sessionId === sessionId;
        let decision: ReturnType<typeof applySessionTitle> | null = null;
        const outcome = await commitSessionRename({
          current: {
            title: row?.title ?? (attached ? store.sessionTitle : null),
            prompt: row?.prompt ?? (attached ? store.sessionPrompt : null),
          },
          raw,
          apply: (title, settled) => {
            if (!isOriginCurrent()) return;
            decision = applySessionTitle(sessionId, title, settled);
          },
          save: (title) => renameWorkbenchSession(sessionId, title),
          isCurrent: () => {
            if (!isOriginCurrent() || !decision?.client || decision.revision === null) {
              return false;
            }
            return (
              ownerSessionClient.current === decision.client &&
              decision.client.isSessionTitleRevisionCurrent(sessionId, decision.revision)
            );
          },
          // A queued value that looks unchanged may be the user's explicit
          // attempt to undo the still-ambiguous write ahead of it.
          forceSave: queued,
        });
        // A failed write is still ambiguous at the transport boundary: the
        // database may have committed before the response was lost, and an
        // optimistic mutation may have hidden a newer snapshot while it was in
        // flight. Reconcile every attempted change; unchanged input did no IO.
        if (isOriginCurrent() && outcome !== 'unchanged') {
          ownerSessionClient.current?.requestFullFetch();
        }
        if (outcome !== 'failed') return null;
        const message = t('workspace.renameSessionFailed');
        if (isOriginCurrent()) toast.error(message);
        return message;
      });
    },
    [applySessionTitle, t],
  );

  /**
   * A course was deleted from the rail. `deleteCourse` already removed the
   * row optimistically and rolls the list back (plus toast) on failure; the
   * shell's part is the classroom pane: on success the course's tab closes,
   * handing the pane to its neighbour, or shutting the pane entirely when it
   * was the last tab. A background tab just disappears; a course that was not
   * open at all never touches the pane.
   */
  const handleCourseDeleted = useCallback(
    async (courseId: string) => {
      const deleted = await courses.deleteCourse(courseId);
      if (deleted) closeCourse(courseId);
    },
    [closeCourse, courses],
  );

  // Leaving Pro is a state change: the two surfaces crossfade while the
  // lockup stays fixed. `startProSwap` falls back to a plain push where the
  // browser has no View Transitions or the user asked for less motion, and
  // swallows a second click while one swap is already running.
  const exitPro = () => startProSwap('/', (href) => router.push(href));
  /**
   * Back to the bare workspace: both panes dropped, the composer refocused.
   *
   * The LOGO, and only the logo. It used to be the rail's "new chat" button as
   * well, which made starting a conversation close whatever classroom was open —
   * the two columns are independent, and a new chat is not a reason to put the
   * course away. That is `startNewConversation` below.
   */
  const goHome = () => {
    if (panes.sessionId || panes.courseId) navigation.push({ sessionId: null, courseId: null });
    setCourseTabs(NO_COURSE_TABS);
    persistCourseTabs(NO_COURSE_TABS);
    setNewConversationRequested(false);
    setComposerReset((value) => value + 1);
  };

  /**
   * A new conversation in the middle column. THE CLASSROOM PANE IS LEFT ALONE.
   *
   * Only `?session=` is dropped — `?course=` and this chat's tab set stay, so the
   * classroom keeps its `ClassroomSurface` mounted at the page it was on. That is
   * not cosmetic: remounting it would run the whole classroom load again and clear
   * the media store and the whiteboard history for a course that never changed.
   *
   * Nothing is created here. `newConversationRequested` sends the middle column to
   * its empty-composer state (lazy creation) and the session is minted by the
   * first message. With no classroom open this is the home surface, which is where
   * the empty composer already lives.
   */
  const startNewConversation = () => {
    setNewConversationRequested(true);
    collapse.expandChat();
    if (panes.courseId) {
      if (panes.sessionId) navigation.push({ sessionId: null, courseId: panes.courseId });
    } else {
      if (panes.sessionId) navigation.push({ sessionId: null, courseId: null });
      setCourseTabs(NO_COURSE_TABS);
      persistCourseTabs(NO_COURSE_TABS);
    }
    setComposerReset((value) => value + 1);
  };

  // ── The session wires ─────────────────────────────────────────────────
  //
  // Both live here rather than inside a pane: the SSE attach must survive the
  // classroom pane opening, closing and switching courses, and a wire that
  // unmounts with a pane would replay the whole event log every time.
  const attach = useWorkbenchStore((s) => s.attach);
  const detach = useWorkbenchStore((s) => s.detach);
  const attachedSessionStatus = useWorkbenchStore((s) => s.status);
  const attachedSessionConnected = useWorkbenchStore((s) => s.attached);
  const attachedSessionPendingWork = useWorkbenchStore(
    (s) => s.generationOpen || s.waitingKey !== null || s.waitingArmed,
  );
  const sessionStageId = useWorkbenchStore((s) => s.stageId);
  // How many stage/folder writes this run has made — the trigger that puts an
  // agent-created course or folder in the left rail without a page reload.
  const libraryRevision = useWorkbenchStore((s) => s.libraryRevision);
  // Course links in first-seen order — each stage opens at most once per session.
  const stageLinkStageIds = useWorkbenchStore((s) => s.stageLinkStageIds);
  const attachedSessionReplaying = useWorkbenchStore((s) => s.replaying);
  const replayedStageLinkCount = useWorkbenchStore((s) => s.replayedStageLinkCount);
  const pageCount = useWorkbenchStore((s) => Object.keys(s.pages).length);
  const paneSessionStageId = useMemo(
    () => sessions.find((session) => session.id === panes.sessionId)?.stageId ?? null,
    [panes.sessionId, sessions],
  );

  /**
   * One LIVE first-seen course link, one tab/open action. Links rebuilt from a
   * chat's history are transcript content, not right-pane navigation. Later
   * links for a stage are inert, so a user who manually switches away is not
   * pulled back.
   *
   * Immutable first-link history is reconciled against three durable facts:
   * server-backed classrooms, remembered open tabs, and explicitly closed tabs.
   * The replay baseline plus durable tab memory prevent a refresh or A -> B -> A
   * navigation from opening related classrooms, reviving closed tabs, or
   * replacing the remembered active tab.
   *
   */
  useEffect(() => {
    const open = createdCourseTabsToOpen({
      sessionId: attachedSessionId === panes.sessionId ? panes.sessionId : null,
      createdCourseIds: stageLinkStageIds,
      replayedCourseCount: replayedStageLinkCount,
      availableCourseIds:
        courses.state === 'ready' ? courses.classrooms.map((course) => course.id) : [],
      openCourseIds: courseTabs.courseIds,
      closedCourseIds: courseTabs.closedCourseIds ?? [],
      replaying: attachedSessionReplaying,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a durable library write is the external event being synchronized into URL/tab state
    if (open.length > 0) openCourses(open);
  }, [
    attachedSessionId,
    attachedSessionReplaying,
    courseTabs,
    courses.classrooms,
    courses.state,
    stageLinkStageIds,
    openCourses,
    panes.sessionId,
    replayedStageLinkCount,
  ]);

  useGeneratedCourseDiscoverySync({
    sessionId: attachedSessionId,
    stageId: sessionStageId,
    pageCount,
    status: attachedSessionStatus,
    libraryRevision,
    reload: courses.reload,
  });

  useEffect(() => {
    if (!panes.sessionId) {
      detach();
      return;
    }
    // The stage is looked up from the list when it is loaded, and filled by
    // the meta fetch otherwise — a `?session=` deep link has neither yet, and
    // the chat needs neither.
    attach(panes.sessionId, paneSessionStageId);
    // A rename can still be awaiting its PATCH (or the confirming list read)
    // when the user leaves this chat and comes back. The detail GET started by
    // the new attachment may overtake that PATCH, so preserve the client's
    // unconfirmed decision even when the owner row has not reached the list.
    // The object wrapper distinguishes a real clear (`title: null`) from no
    // decision. Otherwise the owner row is the title bootstrap authority.
    const mutation = ownerSessionClient.current?.getUnconfirmedSessionTitle(panes.sessionId);
    const attached = sessionsRef.current.find((session) => session.id === panes.sessionId);
    if (mutation) {
      syncAttachedSessionTitle(panes.sessionId, mutation.title);
    } else if (attached) {
      // Apply even an equal null: the revision records that an owner title
      // source exists, so an older detail response cannot fill it back in.
      syncAttachedSessionTitle(attached.id, attached.title ?? null);
    }
  }, [panes.sessionId, paneSessionStageId, attach, detach]);

  // Attachment is workspace-scoped view state. Clear it when the shell leaves
  // the tree so a subsequent standalone `/classroom/:id` route cannot inherit
  // hosted/edit intent from the previous SPA screen.
  useEffect(
    () => () => {
      detach();
    },
    [detach],
  );

  useWorkbenchStream(panes.sessionId);

  useEffect(() => {
    if (courseChatBootstrap.kind !== 'adopt') return;
    // Carrying an existing conversation over is pure navigation: no request, and
    // idempotent by construction — the URL it writes makes this branch settle.
    navigation.replace({
      sessionId: courseChatBootstrap.sessionId,
      courseId: courseChatBootstrap.courseId,
    });
  }, [courseChatBootstrap, navigation]);

  /**
   * The empty conversation: a composer with no session behind it yet.
   *
   * `start` is the whole creation path, and it runs on the user's first message —
   * mint an idle session, then deliver that message through the ordinary message
   * endpoint so its materials, element refs and `@`-named courses are not a
   * special case (see `lib/workbench/first-message-session`). Opening a course
   * therefore starts no run until the user actually asks for something.
   */
  const draftConversation = useMemo(
    () =>
      draftCourseId
        ? {
            ownerKey: `draft:${draftCourseId}`,
            start: async (message: {
              readonly text: string;
              readonly materials: readonly WorkbenchMaterial[];
              readonly elementRefs: readonly ElementRef[];
              readonly courseRefs: readonly CourseRef[];
            }) => {
              const started = await startConversationWithFirstMessage({
                stageId: draftCourseId,
                ...message,
              });
              // The rail should show the conversation that just came into being,
              // and the URL is what attaches it.
              loadSessions();
              navigation.replace({ sessionId: started.sessionId, courseId: draftCourseId });
              return {
                accepted: true,
                elementRefsAccepted: started.elementRefsAccepted,
                courseRefsAccepted: started.courseRefsAccepted,
              };
            },
          }
        : null,
    [draftCourseId, loadSessions, navigation],
  );

  // The owner list stream and attached conversation stream have independent
  // clocks. Project the attached fold onto its own row so `session_end` removes
  // the spinner even when that frame wins the race. The id fence matters during navigation:
  // until attach() has switched the store, the previous chat must not lend its
  // status to the newly selected row. Background rows stay server-owned.
  const visibleSessions = useMemo(
    () =>
      reconcileAttachedSessionStatus(sessions, {
        paneId: panes.sessionId,
        attachedId: attachedSessionId,
        status: attachedSessionStatus,
        connected: attachedSessionConnected,
        pendingWork: attachedSessionPendingWork,
      }),
    [
      attachedSessionConnected,
      attachedSessionId,
      attachedSessionPendingWork,
      attachedSessionStatus,
      panes.sessionId,
      sessions,
    ],
  );

  // Keep an observed status after the user leaves this chat. The owner event
  // may still be in flight on its independent stream.
  useEffect(() => {
    ownerSessionClient.current?.updateSessions((current) => {
      const reconciled = reconcileAttachedSessionStatus(current, {
        paneId: panes.sessionId,
        attachedId: attachedSessionId,
        status: attachedSessionStatus,
        connected: attachedSessionConnected,
        pendingWork: attachedSessionPendingWork,
      });
      return reconciled;
    });
  }, [
    attachedSessionConnected,
    attachedSessionId,
    attachedSessionPendingWork,
    attachedSessionStatus,
    panes.sessionId,
  ]);

  /**
   * A classroom has no session lifecycle. Its identity is the course id and
   * its content is the latest document/manifest snapshot. Session status used
   * to decide whether the pane skipped its own load; switching chats could
   * therefore flip that gate for an unchanged course and reset the whole
   * canvas. Freshness sync now simply complements the classroom's ordinary
   * load, independent of which conversations happen to be running.
   */
  useStageFreshnessSync(panes.courseId);

  // Leaving full-screen playback behind when the course closes: the flag is
  // session state and would otherwise blank the next surface.
  const setPlaybackOn = useWorkbenchStore((s) => s.setPlaybackOn);
  useEffect(() => {
    if (!panes.courseId && playbackOn) setPlaybackOn(false);
  }, [panes.courseId, playbackOn, setPlaybackOn]);

  // ── Read-only ─────────────────────────────────────────────────────────
  // The tree already knows: a course saved from Discover carries
  // `isOwner === false`. The stage store's own answer arrives after the load
  // and is authoritative once it does; before that the tree's flag keeps the
  // header from claiming an edit deck it is about to lose. The real store
  // carries that answer as `outlineProducer` (the reference's `isOwner` was
  // not ported): a course whose document a server job produced is server-owned,
  // not client-authored, and therefore not the current user's own to edit.
  const storeIsOwner = useStageStore((s) => s.outlineProducer) !== 'server-job';
  const courseIsOwner = useMemo(
    () => courses.classrooms.find((course) => course.id === panes.courseId)?.isOwner,
    [courses.classrooms, panes.courseId],
  );
  const readOnlyCourse = courseIsOwner === false || storeIsOwner === false;

  /* ── What a course is CALLED ───────────────────────────────────────────
     Tabs and in-chat links both need a name and a page count for an id, and
     both must degrade rather than invent one. The authoritative list is the
     rail's; a course the agent has only just created is not in it yet, so the
     attached session's own title fills that one gap and everything else says
     nothing at all (`null`), which the renderers show as "untitled" and as no
     page count rather than as a fabricated zero. */
  const courseTitle = useWorkbenchStore((s) => s.courseTitle);
  const lookupCourse = useCallback(
    (courseId: string): WorkbenchCourseSummary | null => {
      const known = courses.classrooms.find((course) => course.id === courseId);
      if (known) return { id: courseId, name: known.name, pageCount: known.sceneCount };
      if (courseId === sessionStageId && courseTitle)
        return { id: courseId, name: courseTitle, pageCount: null };
      return null;
    },
    [courses.classrooms, courseTitle, sessionStageId],
  );

  /**
   * What the composer's `@` picker may offer: the rail's own list, newest
   * first. Same source as `lookupCourse` — one list, so the picker, the tab and
   * the rail can never disagree about what exists or what it is called.
   */
  const courseOptions = useMemo(
    () =>
      [...courses.classrooms]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((course) => ({ id: course.id, name: course.name })),
    [courses.classrooms],
  );

  const courseTabItems = useMemo(
    () =>
      courseTabs.courseIds.map((id) => ({
        id,
        name: lookupCourse(id)?.name ?? '',
      })),
    [courseTabs.courseIds, lookupCourse],
  );

  const classroomBrowser = useMemo(
    () => ({
      tabs: courseTabItems,
      activeCourseId: panes.courseId as string,
      onActivateCourse: activateCourse,
      onCloseCourse: closeCourse,
    }),
    [activateCourse, closeCourse, courseTabItems, panes.courseId],
  );

  const courseNavigation = useMemo(
    () => ({
      openCourse,
      activeCourseId: panes.courseId,
      lookupCourse,
      courseOptions,
    }),
    [courseOptions, lookupCourse, openCourse, panes.courseId],
  );

  return (
    <div
      ref={rootRef}
      data-testid="pro-workspace"
      data-ws-layout={
        render.home ? 'home' : `${chatOpen ? 'chat' : ''}${classroomOpen ? 'classroom' : ''}`
      }
      className="ws-root flex h-[100dvh] w-full overflow-hidden"
      // The default only — the persisted width is applied to this same
      // variable in a layout effect, so server and client markup agree.
      style={{ ['--ws-rail-w' as string]: `${RAIL_WIDTH_DEFAULT}px` }}
    >
      {courses.importInput}

      {classroomOpen && playbackOn ? null : (
        <WorkspaceRail
          courses={courses}
          sessions={visibleSessions}
          sessionState={sessionState}
          onReloadSessions={() => {
            loadSessions(true);
          }}
          activeCourseId={panes.courseId}
          activeSessionId={panes.sessionId}
          collapsed={collapse.value.nav}
          onToggleCollapsed={collapse.toggleNav}
          onOpenCourse={openCourse}
          onOpenSession={openSession}
          onNewSession={startNewConversation}
          onGoHome={goHome}
          onExitPro={exitPro}
          onSessionDeleted={handleSessionDeleted}
          onRenameSession={renameSession}
          onDeleteCourse={handleCourseDeleted}
          resizeHandle={
            <ResizeHandle
              testId="pro-rail-resize-handle"
              label={t('workspace.resizeAria')}
              edge="right"
              current={railWidth.current}
              clamp={clampRailWidth}
              onPreview={railWidth.preview}
              onCommit={railWidth.commit}
              onReset={railWidth.reset}
            />
          }
        />
      )}

      {chatTab ? (
        <PaneTab
          testId="workspace-chat-reopen"
          label={t('workspace.expandChat')}
          onClick={focusChat}
        />
      ) : null}

      {chatOpen || chatMounted ? (
        <WorkspaceChatPane
          hidden={!chatOpen}
          fill={chatFills}
          width={chatWidth.value}
          navigation={courseNavigation}
          draftConversation={draftConversation}
          onRename={
            // Only a conversation that exists can be named. A draft one has no
            // id to PATCH — its first message mints the session, and the title
            // it derives from that message is nameable from then on.
            attachedSessionId
              ? (title: string) => renameSession(attachedSessionId, title)
              : undefined
          }
          // Folding is offered only while the classroom is there to take the
          // column: see `resolveWorkspaceRender`, which refuses to fold the last
          // visible pane anyway.
          onCollapse={bothPanesOnScreen ? collapse.collapseChat : undefined}
          resizeHandle={
            bothPanesOnScreen ? (
              <ResizeHandle
                testId="workspace-chat-resize-handle"
                label={t('workspace.resizeChatAria')}
                edge="right"
                current={chatWidth.current}
                clamp={clampChatWidth}
                onPreview={chatWidth.preview}
                onCommit={chatWidth.commit}
                onReset={chatWidth.reset}
              />
            ) : undefined
          }
        />
      ) : null}

      {panes.courseId ? (
        <WorkspaceClassroomPane
          browser={classroomBrowser}
          hidden={!classroomOpen}
          readOnly={readOnlyCourse}
          playback={playbackOn}
          // Symmetric with the conversation's fold: offered only while both
          // panes are on screen (the last visible pane cannot fold — see
          // `resolveWorkspaceRender`). Its button lives in the pane's own header.
          onCollapse={bothPanesOnScreen ? collapse.collapseClassroom : undefined}
        />
      ) : null}

      {classroomTab ? (
        <PaneTab
          testId="workspace-classroom-reopen"
          label={t('workspace.expandClassroom')}
          side="right"
          onClick={focusClassroom}
        />
      ) : null}

      {render.home ? (
        <WorkspaceHome
          composerReset={composerReset}
          discoveryContent={courses.discoveryContent}
          // The home composer's `@` picker names courses from the same one list
          // the rail and the conversation composer use.
          courseOptions={courseOptions}
          onOpenSession={openCreatedSession}
          onExitPro={exitPro}
        />
      ) : null}
    </div>
  );
}

/* ── Pane collapse ────────────────────────────────────────────────────────
   A viewing preference, not a location: it is remembered in `localStorage`
   and deliberately never travels in a shared link. Read in a layout effect
   rather than during render, because `localStorage` does not exist on the
   server and reading it in an initializer is a hydration mismatch. */

interface PaneCollapseState {
  readonly value: { readonly nav: boolean; readonly chat: boolean; readonly classroom: boolean };
  readonly toggleNav: () => void;
  readonly collapseChat: () => void;
  readonly expandChat: () => void;
  readonly collapseClassroom: () => void;
  readonly expandClassroom: () => void;
}

function usePaneCollapse(): PaneCollapseState {
  const [nav, setNav] = useState(false);
  const [chat, setChat] = useState(false);
  const [classroom, setClassroom] = useState(false);

  useLayoutEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- storage is client-only; see the block comment above */
    setNav(parseCollapsed(readFlag(NAV_COLLAPSED_STORAGE_KEY)));
    setChat(parseCollapsed(readFlag(CHAT_COLLAPSED_STORAGE_KEY)));
    setClassroom(parseCollapsed(readFlag(CLASSROOM_COLLAPSED_STORAGE_KEY)));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const value = useMemo(() => ({ nav, chat, classroom }), [nav, chat, classroom]);
  const toggleNav = useCallback(
    () =>
      setNav((current) => {
        writeFlag(NAV_COLLAPSED_STORAGE_KEY, !current);
        return !current;
      }),
    [],
  );
  const collapseChat = useCallback(() => {
    writeFlag(CHAT_COLLAPSED_STORAGE_KEY, true);
    setChat(true);
  }, []);
  const expandChat = useCallback(() => {
    writeFlag(CHAT_COLLAPSED_STORAGE_KEY, false);
    setChat(false);
  }, []);
  const collapseClassroom = useCallback(() => {
    writeFlag(CLASSROOM_COLLAPSED_STORAGE_KEY, true);
    setClassroom(true);
  }, []);
  const expandClassroom = useCallback(() => {
    writeFlag(CLASSROOM_COLLAPSED_STORAGE_KEY, false);
    setClassroom(false);
  }, []);

  return useMemo(
    () => ({
      value,
      toggleNav,
      collapseChat,
      expandChat,
      collapseClassroom,
      expandClassroom,
    }),
    [collapseChat, collapseClassroom, expandChat, expandClassroom, toggleNav, value],
  );
}

function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeFlag(key: string, collapsed: boolean): void {
  try {
    localStorage.setItem(key, collapsed ? '1' : '0');
  } catch {
    // Storage can be denied (private mode, blocked cookies). An unwritable
    // store costs the preference, not the session.
  }
}

/** True while the window is too narrow for the conversation AND the classroom. */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${BOTH_PANES_MIN_PX - 1}px)`);
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);
  return narrow;
}

/* ── Widths ───────────────────────────────────────────────────────────────
   Both resizable columns work the same way: the width is a CSS variable and
   NOTHING else — no React state. A drag writes the variable straight onto the
   node, so a tree of rows never re-renders mid-drag; that is the difference
   between a column that tracks the cursor and one that lags it.

   Keeping it out of state also keeps hydration honest: the server always
   renders the default, and the persisted value is applied in a layout effect
   (before paint, after hydration) rather than read during render. */

interface DraggableWidth {
  readonly preview: (width: number) => void;
  readonly commit: (width: number) => void;
  readonly reset: () => void;
  readonly current: () => number;
}

function useRailWidth(rootRef: React.RefObject<HTMLDivElement | null>): DraggableWidth {
  const widthRef = useRef(RAIL_WIDTH_DEFAULT);

  const paint = useCallback(
    (next: number) => {
      widthRef.current = next;
      rootRef.current?.style.setProperty('--ws-rail-w', `${next}px`);
    },
    [rootRef],
  );

  const persist = useCallback((next: number) => {
    try {
      localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(next));
    } catch {
      // See `usePaneCollapse` — an unwritable store costs the preference.
    }
  }, []);

  useLayoutEffect(() => {
    const restored = parseRailWidth(readFlag(RAIL_WIDTH_STORAGE_KEY));
    if (restored !== RAIL_WIDTH_DEFAULT) paint(restored);
  }, [paint]);

  return {
    preview: paint,
    current: useCallback(() => widthRef.current, []),
    commit: useCallback(
      (next: number) => {
        const clamped = clampRailWidth(next);
        paint(clamped);
        persist(clamped);
      },
      [paint, persist],
    ),
    reset: useCallback(() => {
      paint(RAIL_WIDTH_DEFAULT);
      persist(RAIL_WIDTH_DEFAULT);
    }, [paint, persist]),
  };
}

/**
 * The conversation pane's width. Unlike the rail's, this one IS state: the
 * pane is a flex sibling whose width feeds the classroom's remaining space,
 * and a CSS variable would have to be read back by the layout anyway. The
 * drag still paints through a ref so the intermediate frames do not
 * re-render the chat.
 */
function useChatWidth(): DraggableWidth & { readonly value: number } {
  const [value, setValue] = useState(CHAT_WIDTH_DEFAULT);
  const widthRef = useRef(CHAT_WIDTH_DEFAULT);

  useLayoutEffect(() => {
    const restored = parseChatWidth(readFlag(CHAT_WIDTH_STORAGE_KEY));
    widthRef.current = restored;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- storage is client-only
    if (restored !== CHAT_WIDTH_DEFAULT) setValue(restored);
  }, []);

  const paint = useCallback((next: number) => {
    widthRef.current = next;
    setValue(next);
  }, []);

  return {
    value,
    preview: paint,
    current: useCallback(() => widthRef.current, []),
    commit: useCallback(
      (next: number) => {
        const clamped = clampChatWidth(next);
        paint(clamped);
        try {
          localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(clamped));
        } catch {
          // See above.
        }
      },
      [paint],
    ),
    reset: useCallback(() => {
      paint(CHAT_WIDTH_DEFAULT);
      try {
        localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(CHAT_WIDTH_DEFAULT));
      } catch {
        // See above.
      }
    }, [paint]),
  };
}
