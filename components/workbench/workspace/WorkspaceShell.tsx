'use client';

import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { WORKSPACE_NARROW_QUERY } from '@/lib/adaptive/media-queries';

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
import { useSearchParams } from 'next/navigation';
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
import { createdCourseTabsToOpen } from '@/lib/workbench/created-course-tabs';
import { isCourseReadOnly } from '@/lib/workbench/course-read-only';
import {
  clampRailWidth,
  parseRailWidth,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_STORAGE_KEY,
} from '@/lib/workbench/workspace-navigation';
import {
  activateCourseTab,
  closeAllCourseTabs,
  CHAT_COLLAPSED_STORAGE_KEY,
  CHAT_WIDTH_DEFAULT,
  CHAT_WIDTH_STORAGE_KEY,
  CLASSROOM_COLLAPSED_STORAGE_KEY,
  clampChatWidth,
  closeCourseTab,
  defaultNavCollapsed,
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
  withLibrary,
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
import { useOwnerRuns } from '@/lib/generation-run-client/use-owner-runs';
import { discardGenerationRun } from '@/lib/generation-run-client/api';
import { pendingCourseRuns, runsByCourse } from '@/lib/generation-run-client/course-card';
import { WorkspaceRail } from './WorkspaceRail';
import { WorkspaceHome } from './WorkspaceHome';
import { WorkspaceChatPane } from './WorkspaceChatPane';
import { WorkspaceClassroomPane } from './WorkspaceClassroomPane';
import {
  NO_PREVIEW_TAB,
  PREVIEW_TAB_ID,
  WorkspaceRequestActivity,
  type PreviewTabState,
} from './WorkspaceRequestActivity';
import { rememberPreviewClosed } from '@/lib/workbench/preview-tab';
import { requestEpisodeStart } from '@/lib/workbench/request-activity';
import { anyCourseHasScene, watchFirstScene } from '@/lib/workbench/first-scene-ready';
import {
  conversationTargetStageIds,
  worksOnExistingCourses,
} from '@/lib/workbench/conversation-course';
import { PaneTab } from './PaneTab';
import { ResizeHandle } from './ResizeHandle';
import { MaterialLibraryPage } from './MaterialLibraryPage';
import type { MaterialSeed, MaterialSeedTarget } from '@/components/workbench/compose-extras';

const EMPTY_SESSIONS: ProHomeSessionItem[] = [];

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
  const navigation = useWorkspacePaneNavigation(initialPanes);

  // Discover-only: course management lives in the navigation tree.
  const courses = useHomeDiscovery({ mode: 'discover-only' });
  /*
   * Courses a classic generation run is still producing, live through the
   * owner's run stream — the source the home page's cards read. Such a course
   * is read-only until its run completes, so the rail shows its progress and
   * does not open it, and the `@` picker does not offer it. A run that gains
   * its course or finishes reads the course list again, so the row turns into
   * an ordinary one (with its final page count) without a reload.
   */
  const { runs: ownerRuns, forget: forgetRun } = useOwnerRuns({
    onCourseChanged: () => void courses.reload(),
  });
  const courseRuns = useMemo(() => runsByCourse(ownerRuns), [ownerRuns]);
  // A run whose course is not listed yet is a row of its own, as it is a card
  // of its own on the home page — from the moment the run starts.
  const listedCourseIds = useMemo(
    () => new Set(courses.classrooms.map((course) => course.id)),
    [courses.classrooms],
  );
  const pendingRuns = useMemo(
    () => pendingCourseRuns(ownerRuns, listedCourseIds),
    [ownerRuns, listedCourseIds],
  );
  const generatingCourseIds = useMemo(() => new Set(courseRuns.keys()), [courseRuns]);
  /** Discard a run whose course does not exist yet — the home card's delete. */
  const discardPendingRun = useCallback(
    async (runId: string) => {
      try {
        await discardGenerationRun(runId);
        forgetRun(runId);
      } catch {
        toast.error(t('workspace.deleteFailed'));
      }
    },
    [forgetRun, t],
  );
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
  /**
   * "Chat with this material" from the knowledge base: the material on its
   * way to the one composer it names. Any navigation the teacher makes after
   * it drops it, so it can never land in a conversation they went to instead.
   */
  const [materialSeed, setMaterialSeed] = useState<MaterialSeed | null>(null);
  // Back and Forward are the teacher's navigation too. Nothing in the
  // workspace raises `popstate` itself, so this is never the hand-over's own
  // navigation (a push) or a background change (a replace).
  useEffect(() => {
    const dropMaterialSeed = () => setMaterialSeed(null);
    window.addEventListener('popstate', dropMaterialSeed);
    return () => window.removeEventListener('popstate', dropMaterialSeed);
  }, []);
  /** Bumped once per hand-over, so it also numbers them. */
  const materialSeedKeys = useRef(0);
  const consumeMaterialSeed = useCallback((key: number) => {
    setMaterialSeed((current) => (current?.key === key ? null : current));
  }, []);
  const ownerSessionClient = useRef<OwnerSessionClient | null>(null);
  const shellGeneration = useRef(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const railWidth = useRailWidth(rootRef);
  const chatWidth = useChatWidth();

  const panes = navigation.panes;
  /**
   * Which visit to the home surface this is. Going from home to the knowledge
   * base page over it keeps the visit; every other move -- leaving the page,
   * home again, a conversation, a classroom -- starts a new one. A home
   * message answered after its composer left belongs only to the visit it
   * was sent in (`openCreatedSessionAfterLeaving`).
   */
  const surface =
    panes.sessionId !== null || panes.courseId !== null
      ? 'elsewhere'
      : panes.library
        ? 'library'
        : 'home';
  const [homeVisit, setHomeVisit] = useState({ surface, visit: 0 });
  if (homeVisit.surface !== surface) {
    setHomeVisit({
      surface,
      visit:
        homeVisit.surface === 'home' && surface === 'library'
          ? homeVisit.visit
          : homeVisit.visit + 1,
    });
  }
  // What a late answer is checked against. -1 once the shell is gone: an
  // answer arriving after the teacher left the workspace navigates nothing.
  const currentHomeVisit = useRef(homeVisit.visit);
  useLayoutEffect(() => {
    currentHomeVisit.current = homeVisit.visit;
  }, [homeVisit.visit]);
  useEffect(
    () => () => {
      currentHomeVisit.current = -1;
    },
    [],
  );
  /**
   * A pane change the teacher did not make just now: an agent-created course,
   * a conversation that finished being created, a deletion the server
   * confirmed, a bootstrap. It is decided from the panes as they are when it
   * runs, keeps the knowledge base page if the teacher has it open, and then
   * REPLACES the history entry rather than adding one -- otherwise Back from
   * the page would first step through background changes made under it.
   * Back restores the prior view and may close tabs created under the page;
   * the saved courses remain in the library and can be reopened by URL.
   */
  const navigateInBackground = useCallback(
    (change: (current: WorkspacePanes) => WorkspacePanes | null, mode: 'push' | 'replace') => {
      navigation.update((current) => {
        const next = change(current);
        if (!next) return null;
        return { next, mode: current.library ? 'replace' : mode };
      });
    },
    [navigation],
  );
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
  const [navDefault] = useState(() => defaultNavCollapsed(initialPanes));
  const collapse = usePaneCollapse(navDefault);
  const [courseTabs, setCourseTabs] = useState(() => restoreCourseTabs(null, panes.courseId));
  /**
   * The tab set as last committed, for work that finishes after later
   * renders: a course deletion confirmed while the teacher opened other tabs
   * must close only its own tab, from the set as it is then.
   */
  const courseTabsRef = useRef(courseTabs);
  useLayoutEffect(() => {
    courseTabsRef.current = courseTabs;
  }, [courseTabs]);
  const narrow = useMediaQuery(WORKSPACE_NARROW_QUERY);
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
   * Below 1024px the conversation and the classroom are mutually
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
    navigateInBackground((current) => ({ ...current, sessionId: null, courseId: null }), 'replace');
  }, [navigateInBackground, panes.sessionId, rememberedResumeSessionId, sessions, sessionState]);

  // ── Navigation ────────────────────────────────────────────────────────
  /** The teacher's own navigation, from the panes this render shows. */
  const goTo = useCallback(
    (next: WorkspacePanes) => {
      if (samePanes(next, panes)) return;
      navigation.push(next);
    },
    [navigation, panes],
  );

  /**
   * Which visit to an empty conversation this is. Any other conversation or
   * classroom in the column, or a new chat asked for (a hand-over is one),
   * starts a new visit; the knowledge base page over it does not. A draft's
   * first message answered after its visit ended belongs to the visit it was
   * sent in (see `draftConversation`): the conversation it created stays in
   * the rail, and the column stays where the teacher took it.
   */
  const draftVisit = useRef(0);
  useLayoutEffect(() => {
    draftVisit.current += 1;
  }, [panes.sessionId, panes.courseId]);

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
          : closeAllCourseTabs(courseTabs);
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
      setMaterialSeed(null);
      goTo(withLibrary(withCourse(panes, next.activeCourseId), false));
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
        navigateInBackground((current) => withCourse(current, next.activeCourseId), 'push');
      }
    },
    [collapse, courseTabs, navigateInBackground, persistCourseTabs],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      setNewConversationRequested(false);
      collapse.expandChat();
      setMaterialSeed(null);
      goTo(withLibrary(withSession(panes, sessionId), false));
    },
    [collapse, goTo, panes],
  );

  /** The home composer's conversation exists now, the composer still on screen. */
  const openCreatedSession = useCallback(
    (sessionId: string) => {
      // Opening the pane is immediate, but the rail still needs a pull fallback
      // when the owner EventSource is reconnecting or missed session_created.
      loadSessions();
      setNewConversationRequested(false);
      collapse.expandChat();
      navigateInBackground((current) => withSession(current, sessionId), 'push');
    },
    [collapse, loadSessions, navigateInBackground],
  );

  /**
   * The home composer's conversation exists now, but its composer left the
   * tree while the POST was in flight. Leaving home for the knowledge base
   * page is not leaving the conversation: it attaches under the page, which
   * stays (replace, so one Back still leaves it) -- if the teacher is still
   * on the page they opened from that home. Anything else, even the same
   * page reached again after leaving it, was the teacher moving on; the
   * conversation stays in the rail, as before. The composer calls the
   * callback of the render it sent from, which carries that visit.
   */
  const sentInHomeVisit = homeVisit.visit;
  const openCreatedSessionAfterLeaving = useCallback(
    (sessionId: string) => {
      loadSessions();
      if (currentHomeVisit.current !== sentInHomeVisit) return;
      let attached = false;
      navigateInBackground((current) => {
        if (!current.library || current.sessionId !== null || current.courseId !== null) {
          return null;
        }
        attached = true;
        return withSession(current, sessionId);
      }, 'replace');
      if (!attached) return;
      setNewConversationRequested(false);
      collapse.expandChat();
    },
    [collapse, loadSessions, navigateInBackground, sentInHomeVisit],
  );

  const activateCourse = useCallback(
    (courseId: string) => {
      const next = activateCourseTab(courseTabs, courseId);
      if (next === courseTabs) return;
      setMaterialSeed(null);
      setCourseTabs(next);
      persistCourseTabs(next);
      goTo(withCourse(panes, next.activeCourseId));
    },
    [courseTabs, goTo, panes, persistCourseTabs],
  );

  const closeCourse = useCallback(
    (courseId: string) => {
      const current = courseTabsRef.current;
      const next = closeCourseTab(current, courseId);
      if (next === current) return;
      courseTabsRef.current = next;
      setCourseTabs(next);
      persistCourseTabs(next);
      // Also the end of a course deletion (`handleCourseDeleted`), which the
      // teacher may have left the classroom for while it was confirmed.
      navigateInBackground((panesNow) => withCourse(panesNow, next.activeCourseId), 'push');
    },
    [navigateInBackground, persistCourseTabs],
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
      let attached = false;
      navigateInBackground((current) => {
        if (current.sessionId !== sessionId) return null;
        attached = true;
        return withSession(current, null);
      }, 'push');
      if (attached) setNewConversationRequested(false);
    },
    [navigateInBackground],
  );

  /** The rail's knowledge base row: the page takes the main area. */
  const openLibrary = useCallback(() => {
    setMaterialSeed(null);
    goTo(withLibrary(panes, true));
  }, [goTo, panes]);

  /**
   * The page's own way back (its compact header, where the rail is hidden):
   * the panes it covers come back as they were. A navigation that drops the
   * view, not a history step, so a page opened from a pasted link leaves too.
   */
  const leaveLibrary = useCallback(() => {
    setMaterialSeed(null);
    goTo(withLibrary(panes, false));
  }, [goTo, panes]);

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

  /**
   * Back to the bare workspace: both panes dropped, the composer refocused.
   *
   * The LOGO, and only the logo. It used to be the rail's "new chat" button as
   * well, which made starting a conversation close whatever classroom was open —
   * the two columns are independent, and a new chat is not a reason to put the
   * course away. That is `startNewConversation` below.
   */
  const goHome = () => {
    if (panes.sessionId || panes.courseId || panes.library) {
      navigation.push({ sessionId: null, courseId: null });
    }
    setCourseTabs(NO_COURSE_TABS);
    persistCourseTabs(NO_COURSE_TABS);
    setNewConversationRequested(false);
    setMaterialSeed(null);
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
    draftVisit.current += 1;
    setNewConversationRequested(true);
    collapse.expandChat();
    setMaterialSeed(null);
    // The teacher's own choice, so it also leaves the knowledge base page.
    if (panes.courseId) {
      if (panes.sessionId || panes.library) {
        navigation.push({ sessionId: null, courseId: panes.courseId });
      }
    } else {
      if (panes.sessionId || panes.library) navigation.push({ sessionId: null, courseId: null });
      setCourseTabs(NO_COURSE_TABS);
      persistCourseTabs(NO_COURSE_TABS);
    }
    setComposerReset((value) => value + 1);
  };

  /**
   * The knowledge base page's "chat with this material": a new conversation
   * -- beside the open classroom, or on the home composer -- with the
   * material staged in it (RFC #1716 §7). The target is decided now, from the
   * panes the teacher is looking at; the hand-over is set only AFTER
   * `startNewConversation`, which drops any earlier one.
   */
  const chatWithMaterial = (material: WorkbenchMaterial) => {
    const target: MaterialSeedTarget = panes.courseId
      ? { kind: 'chat', ownerKey: `draft:${panes.courseId}` }
      : { kind: 'home' };
    startNewConversation();
    materialSeedKeys.current += 1;
    setMaterialSeed({ key: materialSeedKeys.current, material, target });
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
  // Serialize only provenance ids: streaming text changes must not restart the
  // scene reads. This is a derived value, not another lifecycle/store.
  const requestCreatedCourseIds = useWorkbenchStore((s) =>
    JSON.stringify(
      s.chat?.slice(requestEpisodeStart(s.chat) + 1).flatMap((node) => {
        if (node.kind !== 'tool' || node.toolName !== 'create_stage' || node.toolState !== 'done')
          return [];
        // `reused` is a retry of this same call (the id derives from the call
        // id), so it still proves this request created the course.
        const details = node.toolDetails as { stageId?: unknown } | undefined;
        return typeof details?.stageId === 'string' ? [details.stageId] : [];
      }) ?? [],
    ),
  );
  const pageCount = useWorkbenchStore((s) => Object.keys(s.pages).length);
  const touchedStageIds = useWorkbenchStore((s) => s.touchedStageIds);
  // The request panel and the first-scene handoff cover only the time before
  // this conversation's course has a scene; after that the workbench behaves
  // as it did. An earlier request counts once one of its tool calls persisted
  // a page (the fold stamps the card's sceneId at its checkpoint), or once a
  // course it linked, wrote, or whose stage its calls name is listed with
  // scenes (not a course it is merely bound to as context). This
  // request's own course counts once it has been handed off: it is in the tab
  // set, open or closed, or — after a session-only refresh, which restores no
  // tabs — in the remembered tab set the handoff recovery already consults.
  const earlierRequestMadeScene = useWorkbenchStore((s) =>
    s.chat
      .slice(0, requestEpisodeStart(s.chat) + 1)
      .some((node) => node.kind === 'tool' && Boolean(node.sceneId)),
  );
  // The pages this request's own tool calls persisted (the fold stamps the
  // card's sceneId at its checkpoint), as a string so the selector is stable.
  // A new one is when a course still waiting may have its first scene.
  const thisRequestScenes = useWorkbenchStore((s) =>
    s.chat
      .slice(requestEpisodeStart(s.chat) + 1)
      .flatMap((node) => (node.kind === 'tool' && node.sceneId ? [node.sceneId] : []))
      .join('|'),
  );
  const thisRequestMadeScene = thisRequestScenes !== '';
  const createdThisRequest = useMemo(
    () => JSON.parse(requestCreatedCourseIds) as string[],
    [requestCreatedCourseIds],
  );
  // The courses this conversation's tool calls work on. A course is this
  // conversation's own when it created it (its link) or its calls work on it;
  // a course merely open in the pane, or bound as context because the
  // conversation was started beside it, does not keep the placeholder away.
  const targetedStageIds = useWorkbenchStore((s) =>
    JSON.stringify(conversationTargetStageIds(s.chat)),
  );
  // This request is creating a course of its own (its create_stage has started).
  const creatingInRequest = useWorkbenchStore((s) =>
    s.chat
      .slice(requestEpisodeStart(s.chat) + 1)
      .some((node) => node.kind === 'tool' && node.toolName === 'create_stage'),
  );
  const earlierCourseHasScene =
    earlierRequestMadeScene ||
    anyCourseHasScene(
      [
        ...stageLinkStageIds,
        ...touchedStageIds,
        ...(JSON.parse(targetedStageIds) as string[]),
      ].filter((id) => !createdThisRequest.includes(id)),
      courses.state === 'ready' ? courses.classrooms : [],
    );
  // Only a course this request created can be in it; the reader is SSR-safe.
  const rememberedTabs = createdThisRequest.length > 0 ? readCourseTabsMemory() : null;
  const requestCourseHandedOff = createdThisRequest.some((id) =>
    [courseTabs, rememberedTabs].some(
      (tabs) => tabs?.courseIds.includes(id) || (tabs?.closedCourseIds ?? []).includes(id),
    ),
  );
  // Bound beside a course and looking through existing courses (and creating
  // none): the conversation is about existing courses; no placeholder.
  const onExistingCourses = useWorkbenchStore((s) => worksOnExistingCourses(s.chat, s.stageId));
  // The courses this request created that this visit saw it create while the
  // run was live, and that are not reconciled as a tab yet (opened, closed, or
  // remembered). They outlive the run: a run that ends before a course's first
  // scene was read still hands it off. Per conversation.
  const [pendingOwn, setPendingOwn] = useState<{
    readonly sessionId: string | null;
    readonly ids: readonly string[];
  }>({ sessionId: null, ids: [] });
  const isReconciled = (id: string) =>
    [courseTabs, rememberedTabs].some(
      (tabs) => tabs?.courseIds.includes(id) || (tabs?.closedCourseIds ?? []).includes(id),
    );
  const pendingHandoff =
    pendingOwn.sessionId === attachedSessionId && pendingOwn.ids.some((id) => !isReconciled(id));
  // A finished request whose own course has a scene is history: reopened
  // without tab memory, its replayed link does not navigate, and there is no
  // handoff left to wait for. Like any finished conversation, no placeholder —
  // unless this visit is still handing one of its courses off: then the
  // handoff retires the placeholder, not the end of the run.
  const requestLive = ['running', 'queued', 'connecting'].includes(attachedSessionStatus);
  const finishedRequestMadeScene =
    !requestLive &&
    !pendingHandoff &&
    (thisRequestMadeScene ||
      anyCourseHasScene(createdThisRequest, courses.state === 'ready' ? courses.classrooms : []));
  const beforeFirstScene =
    !earlierCourseHasScene &&
    !requestCourseHandedOff &&
    !onExistingCourses &&
    !finishedRequestMadeScene;

  /* ── The request preview tab ─────────────────────────────────────────────
     The placeholder for the course this conversation may produce, as a
     regular tab in the right pane's tab strip, beside any course tabs (see
     `WorkspaceRequestActivity`). It is available while the attached
     conversation has no course with scenes; the first readable scene opens the
     course tab in its place. It takes focus when a request starts animating in
     it, and not on later events, so a teacher who switched to another tab
     stays there. Closing it is remembered for that request
     (`lib/workbench/preview-tab.ts`); folding it is the pane's own fold. */
  const previewEligible =
    !render.library && !narrow && beforeFirstScene && panes.sessionId === attachedSessionId;
  const [reportedPreviewTab, setPreviewTab] = useState<PreviewTabState>(NO_PREVIEW_TAB);
  // The preview reports a render behind; a report from the previous
  // conversation (whose request keys may repeat here) is no report.
  const previewTab =
    reportedPreviewTab.sessionId === attachedSessionId ? reportedPreviewTab : NO_PREVIEW_TAB;
  const previewTabOpen = previewEligible && previewTab.shown;
  // Which tab of the strip the preview is relative to, per conversation: the
  // preview is the active tab, or a course tab is.
  const [previewFocus, setPreviewFocus] = useState<{
    sessionId: string | null;
    active: boolean;
    focusedKey: string | null;
  }>({ sessionId: null, active: false, focusedKey: null });
  if (previewFocus.sessionId !== attachedSessionId) {
    setPreviewFocus({ sessionId: attachedSessionId, active: false, focusedKey: null });
  }
  if (
    previewTabOpen &&
    previewTab.live &&
    previewTab.requestKey !== null &&
    previewTab.requestKey !== previewFocus.focusedKey &&
    previewFocus.sessionId === attachedSessionId
  ) {
    // A request started animating: the tab takes focus, once per request.
    setPreviewFocus({ ...previewFocus, active: true, focusedKey: previewTab.requestKey });
  }
  /** The preview is the tab on screen: it is active, or there is no course tab to show. */
  const previewShowing = previewTabOpen && (previewFocus.active || !panes.courseId);
  /**
   * The conversation's first course replaces its preview tab. The preview is
   * always the strip's last tab and a new course tab joins at the end, so the
   * course lands where the preview was. It takes focus if the preview had it
   * (or nothing else is open); a teacher on another course tab stays there.
   */
  const handOffPreview = useCallback(
    (courseId: string) => {
      const opened = openCourseTabs(courseTabs, [courseId]);
      const focus = previewShowing || !courseTabs.activeCourseId;
      const next = focus
        ? activateCourseTab(opened, courseId)
        : activateCourseTab(opened, courseTabs.activeCourseId as string);
      setCourseTabs(next);
      persistCourseTabs(next);
      if (focus) {
        collapse.expandClassroom();
        navigateInBackground((current) => withCourse(current, courseId), 'push');
      }
    },
    [collapse, courseTabs, navigateInBackground, persistCourseTabs, previewShowing],
  );
  // The readiness reads outlive a render; they hand off through the latest
  // handoff, and skip a course the user has reconciled meanwhile.
  const handOffRef = useRef(handOffPreview);
  useLayoutEffect(() => {
    handOffRef.current = (courseId: string) => {
      const tabs = courseTabsRef.current;
      if (tabs.courseIds.includes(courseId) || (tabs.closedCourseIds ?? []).includes(courseId)) {
        return;
      }
      handOffPreview(courseId);
    };
  });
  const firstSceneWatchers = useRef(new Map<string, () => void>());
  // Courses a trigger reached while their read was in flight: that read may
  // predate the trigger, so one more follows when it settles without a scene.
  const firstSceneRereads = useRef(new Set<string>());

  // Request keys come from per-session event sequences and collide across
  // conversations, so the close is remembered with the conversation it was for.
  const [closedPreview, setClosedPreview] = useState<{
    readonly sessionId: string | null;
    readonly key: string;
  } | null>(null);
  const closedPreviewKey =
    closedPreview && closedPreview.sessionId === attachedSessionId ? closedPreview.key : null;
  const closePreview = useCallback(
    (requestKey: string) => {
      rememberPreviewClosed(attachedSessionId, requestKey);
      setClosedPreview({ sessionId: attachedSessionId, key: requestKey });
      setPreviewFocus((current) => ({ ...current, active: false }));
    },
    [attachedSessionId],
  );
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
    // A delayed first scene may arrive after re-attachment replayed its link.
    // Only a successful new create_stage in this request proves provenance;
    // arbitrary historical links do not.
    const rememberedTabs = readCourseTabsMemory();
    const rememberedCourseIds = [
      ...(rememberedTabs?.courseIds ?? []),
      ...(rememberedTabs?.closedCourseIds ?? []),
    ];
    // The courses this live request created and that are not reconciled yet
    // (opened or closed as a tab, now or in tab memory). They stay this
    // request's own whatever the pane shows, replayed links included, so a
    // series restored after a reload keeps every course, not just the first.
    const live = ['running', 'queued', 'connecting'].includes(attachedSessionStatus);
    const unreconciled = (id: string) =>
      !rememberedCourseIds.includes(id) &&
      !courseTabs.courseIds.includes(id) &&
      !(courseTabs.closedCourseIds ?? []).includes(id);
    const liveOwn =
      live && !panes.library && !earlierCourseHasScene
        ? createdThisRequest.filter(unreconciled)
        : [];
    // Admitted while live, kept until reconciled, through the end of the run.
    const keptOwn =
      pendingOwn.sessionId === attachedSessionId ? pendingOwn.ids.filter(unreconciled) : [];
    const ownCourses = [...new Set([...keptOwn, ...liveOwn])];
    const pendingChanged =
      pendingOwn.sessionId !== attachedSessionId ||
      ownCourses.length !== pendingOwn.ids.length ||
      ownCourses.some((id) => !pendingOwn.ids.includes(id));
    if (pendingChanged) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the kept set follows the durable facts above
      setPendingOwn({ sessionId: attachedSessionId, ids: ownCourses });
    }
    // A reconciled course needs no more reading.
    for (const [id, cancel] of firstSceneWatchers.current) {
      if (!unreconciled(id)) {
        cancel();
        firstSceneWatchers.current.delete(id);
        firstSceneRereads.current.delete(id);
      }
    }
    const eligibleLinks = stageLinkStageIds.filter(
      (id, index) => index >= replayedStageLinkCount || ownCourses.includes(id),
    );
    const open = createdCourseTabsToOpen({
      sessionId: attachedSessionId === panes.sessionId ? panes.sessionId : null,
      createdCourseIds: eligibleLinks,
      replayedCourseCount: 0,
      availableCourseIds:
        courses.state === 'ready' ? courses.classrooms.map((course) => course.id) : [],
      openCourseIds: courseTabs.courseIds,
      closedCourseIds: courseTabs.closedCourseIds ?? [],
      replaying: attachedSessionReplaying,
    });
    if (open.length === 0) return;
    // This request's own courses open at their first readable scene (the
    // first replaces the preview tab), and so does a link that lands while the
    // preview is the placeholder for a create_stage still in flight (its tab
    // state lags a render behind the stream). Any other live link keeps the
    // existing classroom and library background navigation.
    const previewHolds = previewTabOpen || (previewEligible && creatingInRequest);
    const others = previewHolds ? [] : open.filter((id) => !ownCourses.includes(id));
    if (others.length > 0) {
      // Synchronize the existing live course-link behavior.
      openCourses(others);
      return;
    }
    // Each waiting course has one readiness read in flight at most. It is not
    // cancelled when this effect re-runs (the run ending is one such change):
    // only a conversation switch, unmount or the course being reconciled stops
    // it. A trigger (a checkpoint, the run ending, the course list) that
    // arrives meanwhile is kept, not dropped: the in-flight read may predate
    // it, so a read that settles without a scene starts one more.
    const watch = (id: string) => {
      const cancel = watchFirstScene(
        [id],
        (courseId) => {
          firstSceneRereads.current.delete(id);
          handOffRef.current(courseId);
        },
        () => {
          if (firstSceneWatchers.current.get(id) !== cancel) return;
          firstSceneWatchers.current.delete(id);
          if (firstSceneRereads.current.delete(id)) watch(id);
        },
      );
      firstSceneWatchers.current.set(id, cancel);
    };
    for (const id of open) {
      if (firstSceneWatchers.current.has(id)) firstSceneRereads.current.add(id);
      else watch(id);
    }
  }, [
    attachedSessionId,
    attachedSessionReplaying,
    createdThisRequest,
    earlierCourseHasScene,
    courseTabs,
    courses.classrooms,
    courses.state,
    stageLinkStageIds,
    openCourses,
    handOffPreview,
    previewTabOpen,
    previewEligible,
    creatingInRequest,
    panes.sessionId,
    replayedStageLinkCount,
    libraryRevision,
    pageCount,
    attachedSessionStatus,
    panes.library,
    thisRequestScenes,
    pendingOwn,
  ]);

  // The readiness reads belong to the attached conversation.
  useEffect(() => {
    const watchers = firstSceneWatchers.current;
    const rereads = firstSceneRereads.current;
    return () => {
      for (const cancel of watchers.values()) cancel();
      watchers.clear();
      rereads.clear();
    };
  }, [attachedSessionId]);

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
    navigateInBackground(
      (current) => ({
        ...current,
        sessionId: courseChatBootstrap.sessionId,
        courseId: courseChatBootstrap.courseId,
      }),
      'replace',
    );
  }, [courseChatBootstrap, navigateInBackground]);

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
              readonly onCreated?: (sessionId: string) => void;
            }) => {
              const visitAtSend = draftVisit.current;
              const started = await startConversationWithFirstMessage({
                stageId: draftCourseId,
                ...message,
              });
              // The rail should show the conversation that just came into being,
              // and the URL is what attaches it.
              loadSessions();
              // Decided when the session exists, not when the message was
              // sent: the teacher may have opened the knowledge base since.
              // Anything else -- another conversation, another classroom, a
              // new draft (a hand-over's, often under the same
              // `draft:<course>` key) -- ended this draft's visit: the
              // conversation stays in the rail, and attaching it would pull
              // the teacher back and carry whatever they are typing now into it.
              navigateInBackground(
                (current) =>
                  draftVisit.current === visitAtSend &&
                  current.sessionId === null &&
                  current.courseId === draftCourseId
                    ? { ...current, sessionId: started.sessionId, courseId: draftCourseId }
                    : null,
                'replace',
              );
              return {
                accepted: true,
                elementRefsAccepted: started.elementRefsAccepted,
                courseRefsAccepted: started.courseRefsAccepted,
              };
            },
          }
        : null,
    [draftCourseId, loadSessions, navigateInBackground],
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
  // See `isCourseReadOnly`: the course list's `isOwner` (false for a course
  // saved from Discover) and a generation run still producing the course.
  const courseIsOwner = useMemo(
    () => courses.classrooms.find((course) => course.id === panes.courseId)?.isOwner,
    [courses.classrooms, panes.courseId],
  );
  const courseGenerating = useStageStore((s) => s.courseGenerating);
  const readOnlyCourse = isCourseReadOnly({
    isOwner: courseIsOwner,
    generating: courseGenerating,
  });

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
      courses.classrooms
        .filter((course) => !generatingCourseIds.has(course.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((course) => ({ id: course.id, name: course.name })),
    [courses.classrooms, generatingCourseIds],
  );

  const courseTabItems = useMemo(
    () =>
      courseTabs.courseIds.map((id) => ({
        id,
        name: lookupCourse(id)?.name ?? '',
      })),
    [courseTabs.courseIds, lookupCourse],
  );

  /** A course tab chosen in the strip: the preview, if it was on screen, steps back. */
  const activateCourseFromStrip = useCallback(
    (courseId: string) => {
      if (courseId === PREVIEW_TAB_ID) {
        setPreviewFocus((current) => ({ ...current, active: true }));
        return;
      }
      setPreviewFocus((current) => ({ ...current, active: false }));
      activateCourse(courseId);
    },
    [activateCourse],
  );
  const closeCourseFromStrip = useCallback(
    (courseId: string) => {
      if (courseId === PREVIEW_TAB_ID) {
        if (previewTab.requestKey) closePreview(previewTab.requestKey);
        return;
      }
      // The teacher closing a tab; `closeCourse` alone is also the end of a
      // course deletion, which is not a navigation of theirs.
      setMaterialSeed(null);
      closeCourse(courseId);
    },
    [closeCourse, closePreview, previewTab.requestKey],
  );

  const classroomBrowser = useMemo(
    () => ({
      // One strip: the course tabs, then the preview tab while it is open.
      tabs: previewTabOpen
        ? [...courseTabItems, { id: PREVIEW_TAB_ID, name: previewTab.label }]
        : courseTabItems,
      // The mounted classroom always gets the real course: the preview tab
      // only selects in the strip, so the keep-alive classroom behind it is
      // never asked to load the sentinel.
      activeCourseId: panes.courseId as string,
      selectedTabId: previewShowing ? PREVIEW_TAB_ID : (panes.courseId as string),
      onActivateCourse: activateCourseFromStrip,
      onCloseCourse: closeCourseFromStrip,
    }),
    [
      activateCourseFromStrip,
      closeCourseFromStrip,
      courseTabItems,
      panes.courseId,
      previewShowing,
      previewTab.label,
      previewTabOpen,
    ],
  );
  const previewStrip = useMemo(
    () => ({
      tabs: courseTabItems,
      onActivate: activateCourseFromStrip,
      onCloseCourse: closeCourseFromStrip,
    }),
    [activateCourseFromStrip, closeCourseFromStrip, courseTabItems],
  );

  const courseNavigation = useMemo(
    () => ({
      openCourse,
      activeCourseId: panes.courseId,
      lookupCourse,
      courseOptions,
      generatingCourseIds,
    }),
    [courseOptions, generatingCourseIds, lookupCourse, openCourse, panes.courseId],
  );

  // The preview on screen (not folded) folds the navigation, as a view state.
  const previewPaneOpen = previewShowing && !collapse.value.classroom;
  const [navReopenedForPreview, setNavReopenedForPreview] = useState(false);
  if (!previewPaneOpen && navReopenedForPreview) setNavReopenedForPreview(false);
  const navCollapsed = collapse.value.nav || (previewPaneOpen && !navReopenedForPreview);
  const toggleRail = useCallback(() => {
    if (!previewPaneOpen) {
      collapse.toggleNav();
      return;
    }
    if (navCollapsed) {
      // Reopened by hand: it stays open for this preview, and an open
      // preference is remembered as one.
      if (collapse.value.nav) collapse.toggleNav();
      setNavReopenedForPreview(true);
    } else {
      setNavReopenedForPreview(false);
    }
  }, [collapse, navCollapsed, previewPaneOpen]);

  return (
    <div
      ref={rootRef}
      data-testid="pro-workspace"
      data-ws-layout={
        render.library
          ? 'library'
          : render.home
            ? 'home'
            : `${chatOpen ? 'chat' : ''}${classroomOpen ? 'classroom' : ''}`
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
          courseRuns={courseRuns}
          pendingRuns={pendingRuns}
          onDiscardRun={discardPendingRun}
          sessions={visibleSessions}
          sessionState={sessionState}
          onReloadSessions={() => {
            loadSessions(true);
          }}
          activeCourseId={panes.courseId}
          activeSessionId={panes.sessionId}
          collapsed={navCollapsed}
          onToggleCollapsed={toggleRail}
          onOpenCourse={openCourse}
          onOpenSession={openSession}
          onNewSession={startNewConversation}
          onGoHome={goHome}
          onSessionDeleted={handleSessionDeleted}
          onRenameSession={renameSession}
          onDeleteCourse={handleCourseDeleted}
          libraryOpen={render.library}
          onOpenLibrary={openLibrary}
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
          covered={render.library}
          fill={chatFills && !previewPaneOpen}
          width={chatWidth.value}
          navigation={courseNavigation}
          materialSeed={materialSeed}
          onMaterialSeedConsumed={consumeMaterialSeed}
          newConversation={composerReset}
          conversation={panes.sessionId ?? (draftCourseId ? `draft:${draftCourseId}` : null)}
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
            bothPanesOnScreen || previewPaneOpen ? (
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

      {previewEligible ? (
        <WorkspaceRequestActivity
          onStateChange={setPreviewTab}
          hidden={!previewShowing || collapse.value.classroom}
          onCollapse={collapse.collapseClassroom}
          closedKey={closedPreviewKey}
          onClose={closePreview}
          strip={previewStrip}
        />
      ) : null}

      {previewTabOpen && !panes.courseId && collapse.value.classroom ? (
        <PaneTab
          testId="workspace-preview-reopen"
          label={t('workspace.expandClassroom')}
          side="right"
          onClick={collapse.expandClassroom}
        />
      ) : null}

      {panes.courseId ? (
        <WorkspaceClassroomPane
          browser={classroomBrowser}
          hidden={!classroomOpen || previewShowing}
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
          onOpenSessionAfterLeaving={openCreatedSessionAfterLeaving}
          materialSeed={materialSeed}
          onMaterialSeedConsumed={consumeMaterialSeed}
        />
      ) : null}

      {/* The knowledge base page covers the main area. The conversation and
          classroom panes above stay mounted, hidden (`render` turns both off),
          so leaving the page finds them as they were and the run's stream is
          never detached. */}
      {render.library ? (
        <MaterialLibraryPage onChatWithMaterial={chatWithMaterial} onLeave={leaveLibrary} />
      ) : null}
    </div>
  );
}

/* ── Pane collapse ────────────────────────────────────────────────────────
   A viewing preference, not a location: it is remembered in `localStorage`
   and deliberately never travels in a shared link. Read in a layout effect
   rather than during render, because `localStorage` does not exist on the
   server and reading it in an initializer is a hydration mismatch. The rail's
   default is the exception that needs no storage: it comes from the entry
   panes, which the server sees too, so the first paint already has it. */

interface PaneCollapseState {
  readonly value: { readonly nav: boolean; readonly chat: boolean; readonly classroom: boolean };
  readonly toggleNav: () => void;
  readonly collapseChat: () => void;
  readonly expandChat: () => void;
  readonly collapseClassroom: () => void;
  readonly expandClassroom: () => void;
}

function usePaneCollapse(navDefault: boolean): PaneCollapseState {
  const [nav, setNav] = useState(navDefault);
  const [chat, setChat] = useState(false);
  const [classroom, setClassroom] = useState(false);

  useLayoutEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- storage is client-only; see the block comment above */
    setNav(parseCollapsed(readFlag(NAV_COLLAPSED_STORAGE_KEY), navDefault));
    setChat(parseCollapsed(readFlag(CHAT_COLLAPSED_STORAGE_KEY)));
    setClassroom(parseCollapsed(readFlag(CLASSROOM_COLLAPSED_STORAGE_KEY)));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [navDefault]);

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
