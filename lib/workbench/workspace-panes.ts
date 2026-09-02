/**
 * The Pro workspace's pane snapshot — which panes are open, and how that is
 * projected into a deep-link/history URL.
 *
 * `/workspace` is the single Pro surface, and the two things it can have open
 * are addressable:
 *
 *   /workspace                                  → home (hero + composer + discover)
 *   /workspace?session=<id>                     → nav + conversation
 *   /workspace?course=<stageId>                 → nav + classroom
 *   /workspace?session=<id>&course=<stageId>    → all three
 *
 * The two params are INDEPENDENT, which is the whole point: an agent session
 * and a course are many-to-many in the UI. A session carries its own stage on
 * the server (that never changes), but what the classroom pane shows is the
 * user's choice, made in the navigation tree or chat and recorded here — so a
 * pasted link opens the active course while workspace storage restores the rest
 * of the ordered set.
 *
 * The mounted client controller is the live source of truth; this module is
 * pure serialization and layout policy. No React, router, or storage.
 */

export const WORKSPACE_SESSION_PARAM = 'session';
export const WORKSPACE_COURSE_PARAM = 'course';
export const WORKSPACE_PATH = '/workspace';

export interface WorkspacePanes {
  /** The attached agent session, or null. */
  readonly sessionId: string | null;
  /** The course open in the classroom pane, or null. */
  readonly courseId: string | null;
}

/**
 * The right pane's browser state. Only `activeCourseId` is mirrored into the
 * URL; `courseIds` is the ordered, workspace-wide set that stays local to this
 * browser.
 */
export interface WorkspaceCourseTabs {
  readonly courseIds: readonly string[];
  readonly activeCourseId: string | null;
  /** Tabs the user explicitly closed; created-stage replay must not revive them. */
  readonly closedCourseIds?: readonly string[];
}

export const NO_COURSE_TABS: WorkspaceCourseTabs = {
  courseIds: [],
  activeCourseId: null,
};

export const NO_PANES: WorkspacePanes = { sessionId: null, courseId: null };

/** The minimal read surface of `URLSearchParams` / Next's `ReadonlyURLSearchParams`. */
export interface ParamReader {
  get(name: string): string | null;
}

/**
 * A param is present only if it is a non-empty string. `?session=` with no
 * value is the same as no param at all — a truncated link must land on the
 * home surface rather than attaching to a session whose id is the empty
 * string (which would fetch `/api/agent/sessions/` and hang the pane on a
 * loading state forever).
 */
function readParam(search: ParamReader, name: string): string | null {
  const raw = search.get(name);
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

export function readWorkspacePanes(search: ParamReader): WorkspacePanes {
  return {
    sessionId: readParam(search, WORKSPACE_SESSION_PARAM),
    courseId: readParam(search, WORKSPACE_COURSE_PARAM),
  };
}

/**
 * The canonical URL for a pane state. Param order is fixed (session, then
 * course) so the same layout always produces the same string — a `router`
 * comparison against `window.location` never sees two spellings of one state.
 */
export function workspaceHref(panes: WorkspacePanes): string {
  const parts: string[] = [];
  if (panes.sessionId) {
    parts.push(`${WORKSPACE_SESSION_PARAM}=${encodeURIComponent(panes.sessionId)}`);
  }
  if (panes.courseId) {
    parts.push(`${WORKSPACE_COURSE_PARAM}=${encodeURIComponent(panes.courseId)}`);
  }
  return parts.length === 0 ? WORKSPACE_PATH : `${WORKSPACE_PATH}?${parts.join('&')}`;
}

export type WorkspaceLayout = 'home' | 'session' | 'course' | 'both';

export function workspaceLayout(panes: WorkspacePanes): WorkspaceLayout {
  if (panes.sessionId && panes.courseId) return 'both';
  if (panes.sessionId) return 'session';
  if (panes.courseId) return 'course';
  return 'home';
}

export function samePanes(a: WorkspacePanes, b: WorkspacePanes): boolean {
  return a.sessionId === b.sessionId && a.courseId === b.courseId;
}

/**
 * Open a course. The session, if any, STAYS attached: switching the classroom
 * pane while talking to the same agent is the flow the three-pane layout
 * exists for, and dropping the conversation on every course click would make
 * the panes one object again.
 */
export function withCourse(panes: WorkspacePanes, courseId: string | null): WorkspacePanes {
  return { sessionId: panes.sessionId, courseId: courseId || null };
}

/** Open (or activate) one course without duplicating an existing tab. */
export function openCourseTab(tabs: WorkspaceCourseTabs, courseId: string): WorkspaceCourseTabs {
  const id = courseId.trim();
  if (!id) return tabs;
  const closedCourseIds = (tabs.closedCourseIds ?? []).filter((closedId) => closedId !== id);
  const closedChanged = closedCourseIds.length !== (tabs.closedCourseIds?.length ?? 0);
  if (tabs.activeCourseId === id && tabs.courseIds.includes(id) && !closedChanged) return tabs;
  const courseIds = tabs.courseIds.includes(id) ? tabs.courseIds : [...tabs.courseIds, id];
  return withClosedCourseIds({ courseIds, activeCourseId: id }, closedCourseIds);
}

/**
 * Open several courses in order, the last one active.
 *
 * The multi-classroom case: one agent run creates seven classrooms, and each
 * mint is a tab. Opening them one at a time through `openCourseTab` would be
 * the same result, but this exists so a whole batch — a replayed log's created
 * stages, restored in creation order — is ONE state transition rather than
 * seven, each of which would otherwise write the URL and the tab memory.
 *
 * Identity-stable: a batch that changes nothing returns the same object, so it
 * cannot loop an effect that depends on the tabs.
 */
export function openCourseTabs(
  tabs: WorkspaceCourseTabs,
  courseIds: readonly string[],
): WorkspaceCourseTabs {
  return courseIds.reduce(openCourseTab, tabs);
}

/**
 * Close one tab. Closing the active tab selects its right-hand neighbour, or
 * the previous tab when it was last. Closing the final tab empties the browser.
 */
export function closeCourseTab(tabs: WorkspaceCourseTabs, courseId: string): WorkspaceCourseTabs {
  const at = tabs.courseIds.indexOf(courseId);
  if (at < 0) return tabs;
  const courseIds = [...tabs.courseIds.slice(0, at), ...tabs.courseIds.slice(at + 1)];
  const closedCourseIds = [...new Set([...(tabs.closedCourseIds ?? []), courseId])];
  if (courseIds.length === 0) {
    return { courseIds: [], activeCourseId: null, closedCourseIds };
  }
  const activeCourseId =
    tabs.activeCourseId === courseId
      ? courseIds[Math.min(at, courseIds.length - 1)]
      : tabs.activeCourseId;
  return { courseIds, activeCourseId, closedCourseIds };
}

/** Make a remembered tab active; unknown ids are deliberately ignored. */
export function activateCourseTab(
  tabs: WorkspaceCourseTabs,
  courseId: string,
): WorkspaceCourseTabs {
  if (!tabs.courseIds.includes(courseId) || tabs.activeCourseId === courseId) return tabs;
  return withClosedCourseIds(
    { courseIds: tabs.courseIds, activeCourseId: courseId },
    tabs.closedCourseIds ?? [],
  );
}

/** A URL-active course joins a remembered set and wins as the active tab. */
export function restoreCourseTabs(
  remembered: WorkspaceCourseTabs | null,
  urlCourseId: string | null,
): WorkspaceCourseTabs {
  if (urlCourseId) return openCourseTab(remembered ?? NO_COURSE_TABS, urlCourseId);
  return remembered ?? NO_COURSE_TABS;
}

/**
 * Reconcile remembered ids with the live course list. If the remembered active
 * course disappeared, the pane shuts instead of silently activating a
 * different course. Missing background tabs are simply removed.
 */
export function pruneCourseTabs(
  tabs: WorkspaceCourseTabs,
  liveCourseIds: readonly string[],
): WorkspaceCourseTabs {
  const live = new Set(liveCourseIds);
  const closedCourseIds = (tabs.closedCourseIds ?? []).filter((id) => live.has(id));
  if (!tabs.activeCourseId || !live.has(tabs.activeCourseId)) {
    return closedCourseIds.length > 0
      ? { courseIds: [], activeCourseId: null, closedCourseIds }
      : NO_COURSE_TABS;
  }
  const courseIds = tabs.courseIds.filter((id) => live.has(id));
  if (
    courseIds.length === tabs.courseIds.length &&
    closedCourseIds.length === (tabs.closedCourseIds?.length ?? 0)
  )
    return tabs;
  return withClosedCourseIds({ courseIds, activeCourseId: tabs.activeCourseId }, closedCourseIds);
}

function withClosedCourseIds(
  tabs: WorkspaceCourseTabs,
  closedCourseIds: readonly string[],
): WorkspaceCourseTabs {
  return closedCourseIds.length > 0 ? { ...tabs, closedCourseIds } : tabs;
}

/**
 * Open or detach a session without touching the course pane. The two URL params
 * are independent workspace choices; changing one must preserve the other.
 */
export function withSession(panes: WorkspacePanes, sessionId: string | null): WorkspacePanes {
  if (sessionId === panes.sessionId) return panes;
  return { sessionId: sessionId || null, courseId: panes.courseId };
}

/** The attached job owns only the active course, never a background tab. */
export function agentOwnsActiveCourse(
  panes: WorkspacePanes,
  sessionStageId: string | null,
): boolean {
  return !!panes.sessionId && !!panes.courseId && panes.courseId === sessionStageId;
}

export type PaneSessionStatus =
  | 'connecting'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

const TERMINAL_SESSION_STATUSES: ReadonlySet<PaneSessionStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

/**
 * Compatibility predicate for the attached session/course relationship.
 * It remains independent of element picking. Canvas freshness and save safety
 * now use server manifest revisions, so the workspace must not reconnect this
 * predicate as a session-level gate there (#1960 Part 2).
 */
export function agentOwnsPaneCourse(input: {
  readonly panes: WorkspacePanes;
  readonly sessionStageId: string | null;
  readonly attachedSessionId: string | null;
  readonly status: PaneSessionStatus;
  readonly stageLinkStageIds: readonly string[];
  readonly touchedStageIds: readonly string[];
}): boolean {
  const { panes, sessionStageId, attachedSessionId, status, stageLinkStageIds, touchedStageIds } =
    input;
  if (TERMINAL_SESSION_STATUSES.has(status)) return false;
  return (
    agentOwnsActiveCourse(panes, sessionStageId) ||
    (!!panes.sessionId &&
      !!panes.courseId &&
      attachedSessionId === panes.sessionId &&
      (stageLinkStageIds.includes(panes.courseId) || touchedStageIds.includes(panes.courseId)))
  );
}

/**
 * The legacy workbench link, mapped onto the new surface.
 *
 * `/classroom/<stageId>?session=<id>` was the workbench's address before the
 * workspace became the single Pro surface. It stays a working link: the
 * classroom route redirects it here, with the session attached AND its own
 * course open, which is exactly the layout that URL used to render.
 *
 * Returns null when there is nothing to map — a bare `/classroom/<id>` is the
 * classic standalone classroom and must be left completely alone.
 */
export function legacyWorkspaceHref(stageId: string, sessionId: string | null): string | null {
  const session = sessionId?.trim();
  if (!session) return null;
  const stage = stageId?.trim();
  if (!stage) return null;
  return workspaceHref({ sessionId: session, courseId: stage });
}

/* ── Pane collapse ────────────────────────────────────────────────────────
   Which panes are *expanded*, as opposed to which are *open*. Openness is
   mirrored into the URL (above); collapse is a local viewing preference, so it
   lives in `localStorage` and never travels in a shared link. */

export const NAV_COLLAPSED_STORAGE_KEY = 'openmaic:workspace:nav-collapsed';
export const CHAT_COLLAPSED_STORAGE_KEY = 'openmaic:workspace:chat-collapsed';
export const CLASSROOM_COLLAPSED_STORAGE_KEY = 'openmaic:workspace:classroom-collapsed';
export const CHAT_WIDTH_STORAGE_KEY = 'openmaic:workspace:chat-width';

export const CHAT_WIDTH_DEFAULT = 400;
export const CHAT_WIDTH_MIN = 340;
export const CHAT_WIDTH_MAX = 560;

/** Clamp the chat pane's user-set width; garbage falls back to the default. */
export function clampChatWidth(width: number): number {
  if (!Number.isFinite(width)) return CHAT_WIDTH_DEFAULT;
  return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, Math.round(width)));
}

export function parseChatWidth(stored: string | null): number {
  if (stored === null) return CHAT_WIDTH_DEFAULT;
  return clampChatWidth(Number.parseFloat(stored));
}

/** A persisted boolean flag. Only the exact string `'1'` means collapsed. */
export function parseCollapsed(stored: string | null): boolean {
  return stored === '1';
}

export interface PaneCollapse {
  readonly nav: boolean;
  readonly chat: boolean;
  readonly classroom: boolean;
}

export interface WorkspaceRender {
  /** The navigation rail, as a slim icon strip rather than the full tree. */
  readonly navRail: boolean;
  /** The conversation column is mounted and expanded. */
  readonly chat: boolean;
  /**
   * The conversation is folded to its reopen strip — either because the user
   * folded it, or because a narrow layout gave the column to the classroom.
   */
  readonly chatTab: boolean;
  /** The classroom column is mounted and expanded. */
  readonly classroom: boolean;
  readonly classroomTab: boolean;
  /** The home surface (hero + composer + discover) fills the main column. */
  readonly home: boolean;
}

/**
 * What the shell actually renders, from the URL plus the collapse
 * preferences plus full-screen playback.
 *
 * Full-screen playback is not a fourth layout, it is a suppression: the
 * classroom keeps its place in the tree (so nothing remounts and the fold and
 * the composer draft survive) and everything else steps aside.
 */
export function resolveWorkspaceRender(input: {
  readonly panes: WorkspacePanes;
  readonly collapse: PaneCollapse;
  readonly playback: boolean;
  /**
   * The middle column is an empty composer waiting for a first message — the
   * user has no conversations yet and none is minted until they type. It is a
   * conversation as far as the layout is concerned; the only difference is that
   * it has no id yet.
   */
  readonly draftConversation?: boolean;
}): WorkspaceRender {
  const { panes, collapse } = input;
  const layout = workspaceLayout(panes);
  const playback = input.playback && layout !== 'home' && panes.courseId !== null;

  if (playback) {
    return {
      navRail: false,
      chat: false,
      chatTab: false,
      classroom: true,
      classroomTab: false,
      home: false,
    };
  }

  const chatOpen = panes.sessionId !== null || input.draftConversation === true;
  const courseOpen = panes.courseId !== null;
  const classroom = courseOpen && !collapse.classroom;
  /**
   * A conversation is content, not an optional side pane — so it folds ONLY when
   * there is a classroom actually showing to take the column it leaves behind.
   * Collapsing the last visible pane would hand the user an empty workspace and a
   * tab to undo it, which is not a layout.
   */
  const chatFolded = chatOpen && collapse.chat && classroom;
  const chat = chatOpen && !chatFolded;
  const home = layout === 'home';

  return {
    navRail: collapse.nav,
    chat,
    chatTab: chatFolded,
    classroom,
    classroomTab: courseOpen && collapse.classroom,
    home,
  };
}
