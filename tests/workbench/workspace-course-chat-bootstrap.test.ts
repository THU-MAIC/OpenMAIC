// @vitest-environment jsdom
/**
 * Opening a course: what the middle column gets, and what is NOT created.
 *
 * This used to POST a session on arrival. Open a course, close the chat, open the
 * course again — three empty conversations in the rail, each named after the
 * classroom. Nothing is minted here now: an open conversation stays, otherwise the
 * user's most recent one is carried over, and a user with none gets an empty
 * composer whose first message creates the session.
 */

import { act, createElement, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockSessionRow {
  readonly id: string;
  readonly stageId: string;
  readonly updatedAt: number;
  readonly createdAt?: number;
  readonly title?: string | null;
  readonly prompt?: string;
  readonly status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  setPanelOpen: vi.fn(),
  setPlaybackOn: vi.fn(),
  startFirstMessage: vi.fn(),
  requestFullFetch: vi.fn(),
  updateSessions: vi.fn(),
  updateSessionTitle: vi.fn(),
  renameWorkbenchSession: vi.fn(),
  toastError: vi.fn(),
  classroomMounts: 0,
  classroomProps: null as Record<string, unknown> | null,
  chatPaneProps: null as Record<string, unknown> | null,
  searchParams: new URLSearchParams('course=stage-1'),
  sessionRows: [] as readonly MockSessionRow[],
  sessionListState: 'ready' as 'loading' | 'ready' | 'error',
  ownerOptions: null as null | {
    onSessions: (rows: readonly MockSessionRow[], source?: 'incremental' | 'snapshot') => void;
    onSessionTitle?: (sessionId: string, title: string | null) => void;
    onState: (state: 'loading' | 'ready' | 'error') => void;
  },
  ownerClient: null as null | {
    emitSessionStatus: (sessionId: string) => void;
    emitSessionTitle: (sessionId: string, title: string | null) => void;
    reconcileSessions: (rows: readonly MockSessionRow[]) => void;
  },
  unconfirmedSessionTitles: new Map<string, string | null>(),
  router: null as {
    push: (...args: unknown[]) => unknown;
    replace: (...args: unknown[]) => unknown;
  } | null,
  courses: null as Record<string, unknown> | null,
  railProps: null as Record<string, unknown> | null,
  homeProps: null as Record<string, unknown> | null,
  libraryProps: null as Record<string, unknown> | null,
  store: {
    playbackOn: false,
    sessionId: null as string | null,
    status: 'succeeded' as
      | 'connecting'
      | 'queued'
      | 'running'
      | 'succeeded'
      | 'failed'
      | 'cancelled',
    attached: false,
    generationOpen: false,
    waitingKey: null as string | null,
    waitingArmed: false,
    stageId: null as string | null,
    libraryRevision: 0,
    stageLinkStageIds: [] as readonly string[],
    touchedStageIds: [] as readonly string[],
    replaying: false,
    replayedStageLinkCount: 0,
    pages: {} as Record<number, unknown>,
    panelOpen: false,
    courseTitle: null as string | null,
    sessionTitle: null as string | null,
    sessionPrompt: null as string | null,
  },
  setSessionTitle: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => mocks.searchParams,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/lib/hooks/use-home-discovery', () => ({
  useHomeDiscovery: () => mocks.courses,
}));
vi.mock('@/lib/workbench/session-store', () => {
  const state = () => ({
    ...mocks.store,
    attach: mocks.attach,
    detach: mocks.detach,
    setPanelOpen: mocks.setPanelOpen,
    setPlaybackOn: mocks.setPlaybackOn,
    setSessionTitle: mocks.setSessionTitle,
  });
  return {
    useWorkbenchStore: Object.assign(
      (selector: (value: Record<string, unknown>) => unknown) => selector(state()),
      { getState: state },
    ),
    renameWorkbenchSession: mocks.renameWorkbenchSession,
  };
});
vi.mock('@/lib/store/stage', () => ({
  useStageStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ isOwner: true }),
}));
vi.mock('@/lib/workbench/use-workbench-session', () => ({
  useStageFreshnessSync: vi.fn(),
  useWorkbenchStream: vi.fn(),
}));
vi.mock('@/lib/workbench/first-message-session', () => ({
  startConversationWithFirstMessage: mocks.startFirstMessage,
}));
vi.mock('@/lib/workbench/owner-session-client', () => ({
  OwnerSessionClient: class {
    private sessions: typeof mocks.sessionRows = [];
    private titleRevision = 0;
    private readonly titleMutations = new Map<
      string,
      { title: string | null; settled: boolean; revision: number }
    >(
      [...mocks.unconfirmedSessionTitles].map(([sessionId, title]) => [
        sessionId,
        { title, settled: false, revision: (this.titleRevision += 1) },
      ]),
    );

    constructor(
      private readonly options: {
        onSessions: (rows: readonly MockSessionRow[], source?: 'incremental' | 'snapshot') => void;
        onSessionTitle?: (sessionId: string, title: string | null) => void;
        onState: (state: 'loading' | 'ready' | 'error') => void;
      },
    ) {}
    start() {
      mocks.ownerOptions = this.options;
      mocks.ownerClient = this;
      this.sessions = mocks.sessionRows;
      this.options.onSessions(this.sessions, 'snapshot');
      this.options.onState(mocks.sessionListState);
    }
    stop() {}
    requestFullFetch = mocks.requestFullFetch;
    updateSessions(update: (sessions: typeof mocks.sessionRows) => typeof mocks.sessionRows) {
      mocks.updateSessions(update);
      this.sessions = update(this.sessions);
      this.options.onSessions(this.sessions);
    }
    updateSessionTitle(sessionId: string, title: string | null, settled: boolean) {
      mocks.updateSessionTitle(sessionId, title, settled);
      const revision = (this.titleRevision += 1);
      this.titleMutations.set(sessionId, { title, settled, revision });
      this.sessions = this.sessions.map((session) =>
        session.id === sessionId ? { ...session, title } : session,
      );
      this.options.onSessions(this.sessions);
      return revision;
    }
    isSessionTitleRevisionCurrent(sessionId: string, revision: number) {
      return this.titleMutations.get(sessionId)?.revision === revision;
    }
    getUnconfirmedSessionTitle(sessionId: string) {
      const mutation = this.titleMutations.get(sessionId);
      return mutation ? { title: mutation.title } : null;
    }
    emitSessionStatus(sessionId: string) {
      this.sessions = this.sessions.map((session) =>
        session.id === sessionId ? { ...session, status: 'succeeded' as const } : session,
      );
      this.options.onSessions(this.sessions);
    }
    emitSessionTitle(sessionId: string, title: string | null) {
      if (this.titleMutations.has(sessionId)) return;
      this.options.onSessionTitle?.(sessionId, title);
      this.sessions = this.sessions.map((session) =>
        session.id === sessionId ? { ...session, title } : session,
      );
      this.options.onSessions(this.sessions);
    }
    reconcileSessions(rows: readonly MockSessionRow[]) {
      this.sessions = rows;
      this.options.onSessions(this.sessions, 'snapshot');
    }
  },
}));
vi.mock('@/lib/workbench/pro-swap', () => ({ startProSwap: vi.fn() }));
vi.mock('@/components/workbench/workspace/WorkspaceRail', () => ({
  WorkspaceRail: (props: Record<string, unknown>) => {
    mocks.railProps = props;
    return null;
  },
}));
vi.mock('@/components/workbench/workspace/WorkspaceHome', () => ({
  WorkspaceHome: (props: Record<string, unknown>) => {
    mocks.homeProps = props;
    return null;
  },
}));
vi.mock('@/components/workbench/workspace/WorkspaceChatPane', () => ({
  WorkspaceChatPane: (props: Record<string, unknown>) => {
    mocks.chatPaneProps = props;
    return createElement('div', { 'data-testid': 'chat-pane' });
  },
}));
vi.mock('@/components/workbench/workspace/WorkspaceClassroomPane', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    WorkspaceClassroomPane: (props: Record<string, unknown>) => {
      useEffect(() => {
        mocks.classroomMounts += 1;
      }, []);
      mocks.classroomProps = props;
      return createElement('div', { 'data-testid': 'classroom-pane' });
    },
  };
});
vi.mock('@/components/workbench/workspace/PaneTab', () => ({ PaneTab: () => null }));
vi.mock('@/components/workbench/workspace/MaterialLibraryPage', () => ({
  MaterialLibraryPage: (props: Record<string, unknown>) => {
    mocks.libraryProps = props;
    return createElement('main', { 'data-testid': 'pro-workspace-library' });
  },
}));
vi.mock('@/components/workbench/workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));

import { WorkspaceShell } from '@/components/workbench/workspace/WorkspaceShell';
import {
  CHAT_COLLAPSED_STORAGE_KEY,
  CLASSROOM_COLLAPSED_STORAGE_KEY,
} from '@/lib/workbench/workspace-panes';
import { COURSE_TABS_STORAGE_KEY } from '@/lib/workbench/workspace-course-tabs';
import {
  LAST_WORKSPACE_SESSION_STORAGE_KEY,
  readLastWorkspaceSessionId,
} from '@/lib/workbench/workspace-session-memory';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const classroom = (id: string) => ({ id, name: `${id} name`, sceneCount: 3, isOwner: true });

const render = async (node: ReactNode = createElement(WorkspaceShell)) => {
  container ??= document.createElement('div');
  if (!container.parentNode) document.body.appendChild(container);
  root ??= createRoot(container);
  await act(async () => root?.render(node));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The draft-conversation capability the shell hands its chat pane, if any. */
const draft = () =>
  mocks.chatPaneProps?.draftConversation as {
    ownerKey: string;
    start: (message: {
      text: string;
      materials: readonly unknown[];
      elementRefs: readonly unknown[];
      courseRefs: readonly unknown[];
    }) => Promise<unknown>;
  } | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.router = { push: mocks.routerPush, replace: mocks.routerReplace };
  vi.spyOn(window.history, 'pushState').mockImplementation((_state, _unused, url) => {
    mocks.routerPush(String(url));
  });
  vi.spyOn(window.history, 'replaceState').mockImplementation((_state, _unused, url) => {
    mocks.routerReplace(String(url));
  });
  mocks.courses = {
    classrooms: [classroom('stage-1')],
    folders: [],
    state: 'ready',
    reload: vi.fn(() => Promise.resolve()),
    importInput: null,
    discoveryContent: null,
    openNewFolder: vi.fn(),
    moveCourse: vi.fn(),
    createAndMove: vi.fn(),
    deleteCourse: vi.fn(),
  };
  mocks.classroomProps = null;
  mocks.classroomMounts = 0;
  mocks.chatPaneProps = null;
  mocks.railProps = null;
  mocks.homeProps = null;
  mocks.libraryProps = null;
  mocks.searchParams = new URLSearchParams('course=stage-1');
  mocks.sessionRows = [];
  mocks.sessionListState = 'ready';
  mocks.ownerOptions = null;
  mocks.ownerClient = null;
  mocks.unconfirmedSessionTitles.clear();
  mocks.store.sessionId = null;
  mocks.store.stageId = null;
  mocks.store.status = 'succeeded';
  mocks.store.sessionTitle = null;
  mocks.store.sessionPrompt = null;
  mocks.store.stageLinkStageIds = [];
  mocks.store.replayedStageLinkCount = 0;
  mocks.store.touchedStageIds = [];
  mocks.routerPush.mockClear();
  mocks.routerReplace.mockClear();
  mocks.requestFullFetch.mockClear();
  mocks.updateSessions.mockClear();
  mocks.updateSessionTitle.mockClear();
  mocks.renameWorkbenchSession.mockReset();
  mocks.toastError.mockReset();
  mocks.setSessionTitle.mockReset();
  mocks.setSessionTitle.mockImplementation((title: string | null) => {
    mocks.store.sessionTitle = title;
  });
  mocks.startFirstMessage.mockReset();
  mocks.startFirstMessage.mockResolvedValue({
    sessionId: 'session-new',
    elementRefsAccepted: true,
    courseRefsAccepted: true,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  // Collapse is a remembered preference, so a test that folds a pane must not
  // leave it folded for the next one.
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a remembered workspace entry', () => {
  it('forgets a missing session and replaces it with the workspace home', async () => {
    mocks.searchParams = new URLSearchParams('session=session-stale');
    localStorage.setItem(LAST_WORKSPACE_SESSION_STORAGE_KEY, 'session-stale');

    await render();

    expect(mocks.routerReplace).toHaveBeenCalledWith('/workspace');
    expect(readLastWorkspaceSessionId()).toBeNull();
  });

  it('does not treat an unremembered deep link as a stale resume', async () => {
    mocks.searchParams = new URLSearchParams('session=session-shared');

    await render();

    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });
});

describe('a course opened without a conversation', () => {
  it('creates NOTHING on arrival, however many times the course is opened', async () => {
    await render();
    mocks.searchParams = new URLSearchParams();
    await render();
    mocks.searchParams = new URLSearchParams('course=stage-1');
    await render();
    await act(async () => {});

    expect(mocks.startFirstMessage).not.toHaveBeenCalled();
    // …and no session-creating request went out behind its back either.
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/agent/sessions',
      expect.objectContaining({ method: 'POST' }),
    );
    // The classroom is never taken off screen for any of it.
    expect(container?.querySelector('[data-testid="classroom-pane"]')).not.toBeNull();
  });

  it('carries the most recent conversation into the middle column', async () => {
    mocks.sessionRows = [
      { id: 'session-old', stageId: 'stage-9', updatedAt: 1 },
      { id: 'session-recent', stageId: 'stage-2', updatedAt: 9 },
    ];

    await render();

    expect(mocks.routerReplace).toHaveBeenCalledWith(
      '/workspace?session=session-recent&course=stage-1',
    );
    // It is emphatically NOT "the session that owns this course": the recent one
    // is about another stage entirely, and that is fine.
    expect(mocks.startFirstMessage).not.toHaveBeenCalled();
  });

  it('offers an empty composer when the user has no conversations at all', async () => {
    await render();

    expect(mocks.routerReplace).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-testid="chat-pane"]')).not.toBeNull();
    expect(draft()).toMatchObject({ ownerKey: 'draft:stage-1' });
  });

  it('creates the session from the first message, then attaches it', async () => {
    await render();
    const courseRef = { kind: 'course', stageId: 'stage-1', title: '光的折射' };

    await act(async () => {
      await draft()!.start({
        text: '把第三页换个例子',
        materials: [],
        elementRefs: [],
        courseRefs: [courseRef],
      });
    });

    expect(mocks.startFirstMessage).toHaveBeenCalledWith({
      stageId: 'stage-1',
      text: '把第三页换个例子',
      materials: [],
      elementRefs: [],
      courseRefs: [courseRef],
    });
    expect(mocks.routerReplace).toHaveBeenCalledWith(
      '/workspace?session=session-new&course=stage-1',
    );
    // The rail has to show the conversation that just came into being.
    expect(mocks.requestFullFetch).toHaveBeenCalled();
  });

  it('waits for the session list rather than flashing an empty composer', async () => {
    mocks.sessionListState = 'loading';

    await render();

    expect(draft() ?? null).toBeNull();
    expect(mocks.routerReplace).not.toHaveBeenCalled();
    expect(mocks.startFirstMessage).not.toHaveBeenCalled();
  });

  it('never passes conversation lifecycle state into the classroom pane', async () => {
    await render();
    expect(mocks.classroomProps).not.toHaveProperty('agentSessionId');

    mocks.searchParams = new URLSearchParams('session=session-new&course=stage-1');
    mocks.store.sessionId = 'session-new';
    mocks.store.stageId = 'stage-1';
    mocks.store.status = 'running';
    await render();

    // Session status used to flip a ClassroomSurface load dependency here,
    // clearing the media store and whiteboard history for an unchanged course.
    expect(mocks.classroomProps).not.toHaveProperty('agentSessionId');
  });

  it('leaves an already attached conversation alone, and its read path with it', async () => {
    mocks.searchParams = new URLSearchParams('session=session-a&course=stage-1');
    mocks.store.sessionId = 'session-a';
    mocks.store.stageId = 'stage-1';
    mocks.store.status = 'running';
    mocks.sessionRows = [
      { id: 'session-a', stageId: 'stage-1', updatedAt: 10, status: 'running' },
      { id: 'session-recent', stageId: 'stage-2', updatedAt: 9 },
    ];

    await render();

    expect(mocks.routerReplace).not.toHaveBeenCalled();
    expect(mocks.startFirstMessage).not.toHaveBeenCalled();
    expect(draft() ?? null).toBeNull();
    // The classroom receives course data/navigation only. A running chat is
    // not a classroom mode and cannot alter its load lifecycle.
    expect(mocks.classroomProps).not.toHaveProperty('agentSessionId');
  });

  it('survives a StrictMode double-invoke without creating anything', async () => {
    await render(createElement(StrictMode, null, createElement(WorkspaceShell)));
    await act(async () => {});

    expect(mocks.startFirstMessage).not.toHaveBeenCalled();
  });

  it('adopts once, then settles — a list refresh does not re-navigate', async () => {
    mocks.sessionRows = [{ id: 'session-recent', stageId: 'stage-2', updatedAt: 9 }];
    await render();
    expect(mocks.routerReplace).toHaveBeenCalledTimes(1);

    mocks.searchParams = new URLSearchParams('session=session-recent&course=stage-1');
    mocks.store.sessionId = 'session-recent';
    await render();
    await act(async () =>
      mocks.ownerOptions?.onSessions([{ id: 'session-recent', stageId: 'stage-2', updatedAt: 9 }]),
    );

    expect(mocks.routerReplace).toHaveBeenCalledTimes(1);
  });
});

/**
 * Starting a new conversation while a classroom is open.
 *
 * "New chat" used to be the same handler as the logo — back to the bare
 * workspace — so it closed the classroom pane as a side effect. The two columns
 * are independent: a new conversation is not a reason to put the course away.
 */
describe('a new conversation beside an open classroom', () => {
  const newConversation = async () => {
    const onNewSession = mocks.railProps?.onNewSession as () => void;
    expect(onNewSession, 'the rail must be handed a new-chat action').toBeTypeOf('function');
    await act(async () => onNewSession());
  };

  it('drops only the conversation from the URL, keeping the course', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    await render();

    await newConversation();

    expect(mocks.routerPush).toHaveBeenCalledWith('/workspace?course=stage-1');
  });

  it('expands a collapsed conversation column', async () => {
    localStorage.setItem(CHAT_COLLAPSED_STORAGE_KEY, '1');
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    await render();
    await act(async () => {});
    expect(mocks.chatPaneProps?.hidden).toBe(true);

    await newConversation();

    expect(localStorage.getItem(CHAT_COLLAPSED_STORAGE_KEY)).toBe('0');
    expect(mocks.chatPaneProps?.hidden).toBe(false);
    expect(mocks.routerPush).toHaveBeenCalledWith('/workspace?course=stage-1');
  });

  it('leaves the classroom pane exactly where it was', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    await render();
    const before = mocks.classroomProps;

    await newConversation();
    // The URL landed and the store detached, as the navigation would do.
    mocks.searchParams = new URLSearchParams('course=stage-1');
    mocks.store.sessionId = null;
    await render();

    const after = mocks.classroomProps;
    expect(container?.querySelector('[data-testid="classroom-pane"]')).not.toBeNull();
    expect((after?.browser as { activeCourseId: string }).activeCourseId).toBe('stage-1');
    // No chat-derived prop exists that could restart the classroom load.
    expect(before).not.toHaveProperty('agentSessionId');
    expect(after).not.toHaveProperty('agentSessionId');
  });

  it('shows an empty composer instead of adopting the chat it just left', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    await render();

    await newConversation();
    mocks.searchParams = new URLSearchParams('course=stage-1');
    mocks.store.sessionId = null;
    await render();
    await act(async () => {});

    // Without the explicit ask, the bootstrap would carry `session-1` straight
    // back in — it is the most recent one — and the button would read as broken.
    expect(mocks.routerReplace).not.toHaveBeenCalled();
    expect(draft()).not.toBeNull();
    // Still nothing created: the first message mints the session.
    expect(mocks.startFirstMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/agent/sessions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('selects the conversation immediately when the user opens it themselves', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    await render();
    await newConversation();

    // Opening a chat from the rail is an explicit choice; the "new" ask is spent.
    const onOpenSession = mocks.railProps?.onOpenSession as (id: string) => void;
    await act(async () => onOpenSession('session-1'));
    mocks.searchParams = new URLSearchParams('course=stage-1');
    mocks.store.sessionId = null;
    await render();
    await act(async () => {});

    expect(mocks.routerPush).toHaveBeenCalledWith('/workspace?session=session-1&course=stage-1');
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });
});

describe('conversation and classroom pane independence', () => {
  const browser = () =>
    mocks.classroomProps?.browser as {
      tabs: readonly { id: string }[];
      activeCourseId: string;
      onCloseCourse: (id: string) => void;
    };

  const openSession = async (sessionId: string) => {
    const onOpenSession = mocks.railProps?.onOpenSession as (id: string) => void;
    expect(onOpenSession).toBeTypeOf('function');
    await act(async () => onOpenSession(sessionId));
  };

  beforeEach(() => {
    mocks.courses = {
      ...mocks.courses!,
      classrooms: [classroom('stage-1'), classroom('stage-2')],
    };
    mocks.sessionRows = [
      { id: 'session-1', stageId: 'stage-1', updatedAt: 3 },
      { id: 'session-2', stageId: 'stage-2', updatedAt: 2 },
      { id: 'session-3', stageId: 'stage-1', updatedAt: 1 },
    ];
    localStorage.setItem(
      COURSE_TABS_STORAGE_KEY,
      JSON.stringify({ courseIds: ['stage-1', 'stage-2'], activeCourseId: 'stage-2' }),
    );
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-2');
    mocks.store.sessionId = 'session-1';
  });

  it('opens a chat by expanding its column while leaving the classroom mounted and unchanged', async () => {
    localStorage.setItem(CHAT_COLLAPSED_STORAGE_KEY, '1');
    await render();
    await act(async () => {});
    const mountCount = mocks.classroomMounts;
    expect(mocks.chatPaneProps?.hidden).toBe(true);
    expect(browser().tabs.map((tab) => tab.id)).toEqual(['stage-1', 'stage-2']);
    expect(browser().activeCourseId).toBe('stage-2');

    await openSession('session-2');

    expect(localStorage.getItem(CHAT_COLLAPSED_STORAGE_KEY)).toBe('0');
    expect(mocks.chatPaneProps?.hidden).toBe(false);
    expect(mocks.routerPush).toHaveBeenCalledWith('/workspace?session=session-2&course=stage-2');
    expect(browser().tabs.map((tab) => tab.id)).toEqual(['stage-1', 'stage-2']);
    expect(browser().activeCourseId).toBe('stage-2');

    mocks.searchParams = new URLSearchParams('session=session-2&course=stage-2');
    mocks.store.sessionId = 'session-2';
    await render();
    await act(async () => {});

    expect(mocks.classroomMounts).toBe(mountCount);
    expect(browser().tabs.map((tab) => tab.id)).toEqual(['stage-1', 'stage-2']);
    expect(browser().activeCourseId).toBe('stage-2');
    expect(mocks.classroomProps).not.toHaveProperty('agentSessionId');
  });

  it('keeps one workspace tab set through three chats and restores it after remount', async () => {
    await render();
    await act(async () => {});

    for (const sessionId of ['session-2', 'session-3', 'session-1']) {
      mocks.routerPush.mockClear();
      await openSession(sessionId);
      expect(mocks.routerPush).toHaveBeenCalledWith(
        `/workspace?session=${sessionId}&course=stage-2`,
      );
      mocks.searchParams = new URLSearchParams(`session=${sessionId}&course=stage-2`);
      mocks.store.sessionId = sessionId;
      await render();
      await act(async () => {});
      expect(browser().tabs.map((tab) => tab.id)).toEqual(['stage-1', 'stage-2']);
      expect(browser().activeCourseId).toBe('stage-2');
    }

    await act(async () => root?.unmount());
    root = null;
    mocks.classroomProps = null;
    await render();
    await act(async () => {});

    expect(browser().tabs.map((tab) => tab.id)).toEqual(['stage-1', 'stage-2']);
    expect(browser().activeCourseId).toBe('stage-2');
  });

  it('closes course tabs without changing the session or conversation fold', async () => {
    localStorage.setItem(CHAT_COLLAPSED_STORAGE_KEY, '1');
    await render();
    await act(async () => {});

    await act(async () => browser().onCloseCourse('stage-2'));
    expect(mocks.routerPush).toHaveBeenLastCalledWith(
      '/workspace?session=session-1&course=stage-1',
    );
    expect(localStorage.getItem(CHAT_COLLAPSED_STORAGE_KEY)).toBe('1');

    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    await render();
    await act(async () => {});
    await act(async () => browser().onCloseCourse('stage-1'));

    expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace?session=session-1');
    expect(localStorage.getItem(CHAT_COLLAPSED_STORAGE_KEY)).toBe('1');
    expect(JSON.parse(localStorage.getItem(COURSE_TABS_STORAGE_KEY)!)).toMatchObject({
      courseIds: [],
      activeCourseId: null,
      closedCourseIds: ['stage-2', 'stage-1'],
    });
  });
});

describe('workspace home intent', () => {
  it('clears remembered course tabs before navigating home and stays there', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    localStorage.setItem(
      COURSE_TABS_STORAGE_KEY,
      JSON.stringify({ courseIds: ['stage-1'], activeCourseId: 'stage-1' }),
    );
    await render();

    await act(async () => (mocks.railProps?.onGoHome as () => void)());
    await act(async () => {});

    expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace');
    expect(mocks.routerReplace).not.toHaveBeenCalled();
    expect(localStorage.getItem(COURSE_TABS_STORAGE_KEY)).toBeNull();
    expect(
      container?.querySelector('[data-testid="pro-workspace"]')?.getAttribute('data-ws-layout'),
    ).toBe('home');

    await render();
    await act(async () => {});
    expect(mocks.routerReplace).not.toHaveBeenCalled();
  });
});

/**
 * The bug this pair of assertions exists for: after "new chat" the middle column
 * showed a spinner and "connecting" forever. The pane must be handed a DRAFT (which is
 * what makes it an empty composer) and no status at all — a conversation that does
 * not exist has no run to report.
 */
describe('a new conversation is a live composer, not a loading pane', () => {
  it('hands the pane a draft and asks the network for nothing', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    await render();

    await act(async () => (mocks.railProps?.onNewSession as () => void)());
    // The navigation lands and the store detaches, as it does in the browser.
    mocks.searchParams = new URLSearchParams('course=stage-1');
    mocks.store.sessionId = null;
    await render();
    await act(async () => {});

    expect(draft()).not.toBeNull();
    expect(mocks.startFirstMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/agent/sessions',
      expect.objectContaining({ method: 'POST' }),
    );
    // No session meta fetch either: there is no session to fetch.
    for (const call of (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      expect(String(call[0])).not.toMatch(/\/api\/agent\/sessions\/session-1/);
    }
  });

  it('keeps reporting status for a conversation that really is attached', async () => {
    // The other direction: a pane WITH a session must still get its status, so the
    // fix cannot be "never show the connecting state".
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.store.status = 'connecting';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    await render();
    await act(async () => {});

    expect(draft() ?? null).toBeNull();
  });
});

/**
 * A card in the chat opens the right pane, WHATEVER the right pane is doing.
 *
 * The cards used to label themselves open-aside / switch-to-tab / showing from the
 * pane's own state, which invited the reading that a card whose course is
 * already showing is somehow spent. It never was — and the case that had to be
 * nailed down is the one the label could not describe at all: the classroom
 * column is COLLAPSED, so "already open" and "not open" look identical to the
 * reader, and one press has to put the course on screen either way.
 *
 * `navigation.openCourse` is the whole interaction, so it is what these drive.
 */
describe('opening a course from a card in the conversation', () => {
  /** The capability the shell hands the chat pane — what a card calls. */
  const navigation = () =>
    mocks.chatPaneProps?.navigation as {
      readonly openCourse: (courseId: string) => void;
      readonly activeCourseId: string | null;
    };

  it('expands only the classroom when both pane preferences were collapsed', async () => {
    localStorage.setItem(CHAT_COLLAPSED_STORAGE_KEY, '1');
    localStorage.setItem(CLASSROOM_COLLAPSED_STORAGE_KEY, '1');
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    mocks.courses = { ...mocks.courses!, classrooms: [classroom('stage-1'), classroom('stage-2')] };
    await render();
    await act(async () => {});

    const onOpenCourse = mocks.railProps?.onOpenCourse as (id: string) => void;
    await act(async () => onOpenCourse('stage-2'));

    expect(localStorage.getItem(CLASSROOM_COLLAPSED_STORAGE_KEY)).toBe('0');
    expect(localStorage.getItem(CHAT_COLLAPSED_STORAGE_KEY)).toBe('1');
    expect(mocks.routerPush).toHaveBeenCalledWith('/workspace?session=session-1&course=stage-2');
  });

  it('expands a COLLAPSED classroom column and shows the course', async () => {
    // The reader folded the classroom away; the preference is remembered in
    // storage, which is what the shell reads on mount.
    localStorage.setItem(CLASSROOM_COLLAPSED_STORAGE_KEY, '1');
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    mocks.courses = { ...mocks.courses!, classrooms: [classroom('stage-1'), classroom('stage-2')] };
    await render();
    await act(async () => {});
    // Mounted but off screen — the column is folded away, which is precisely the
    // state the old cue could not describe.
    expect(mocks.classroomProps?.hidden).toBe(true);

    await act(async () => navigation().openCourse('stage-2'));
    await act(async () => {});

    // Unfolded, showing the course that was pressed…
    expect(localStorage.getItem(CLASSROOM_COLLAPSED_STORAGE_KEY)).toBe('0');
    expect(mocks.classroomProps?.hidden).toBe(false);
    expect(mocks.routerPush).toHaveBeenCalledWith('/workspace?session=session-1&course=stage-2');
    // …and the conversation is exactly where it was: one press, one pane.
    expect(localStorage.getItem(CHAT_COLLAPSED_STORAGE_KEY)).toBeNull();
    expect(container?.querySelector('[data-testid="chat-pane"]')).not.toBeNull();
  });

  it('switches an ALREADY OPEN classroom column to the pressed course', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    mocks.courses = { ...mocks.courses!, classrooms: [classroom('stage-1'), classroom('stage-2')] };
    await render();
    await act(async () => {});
    expect(navigation().activeCourseId).toBe('stage-1');

    await act(async () => navigation().openCourse('stage-2'));

    expect(mocks.routerPush).toHaveBeenCalledWith('/workspace?session=session-1&course=stage-2');
    expect(mocks.classroomProps?.hidden).toBe(false);
    expect(container?.querySelector('[data-testid="chat-pane"]')).not.toBeNull();
  });

  it('is a press with no state to read: the pane’s open set is not published', async () => {
    await render();
    await act(async () => {});
    // `openCourseIds` existed only so a card could say switch-to-tab / showing about
    // a tab. With the cue gone the contract does not carry it, and nothing can
    // grow a conditional card off it again.
    expect(navigation()).not.toHaveProperty('openCourseIds');
  });
});

describe('renaming a conversation from the workspace shell', () => {
  const rename = () =>
    mocks.railProps?.onRenameSession as (
      sessionId: string,
      title: string,
    ) => Promise<string | null>;

  const namedSession = (title: string | null = 'Old title') => ({
    id: 'session-1',
    stageId: 'stage-1',
    prompt: 'Build a course',
    title,
    status: 'succeeded' as const,
    createdAt: 1,
    updatedAt: 9,
  });

  const renderNamedSession = async (title: string | null = 'Old title') => {
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.store.sessionTitle = title;
    mocks.store.sessionPrompt = 'Build a course';
    mocks.sessionRows = [namedSession(title)];
    await render();
  };

  const visibleTitle = () =>
    (mocks.railProps?.sessions as readonly { id: string; title?: string | null }[]).find(
      (row) => row.id === 'session-1',
    )?.title;

  it('keeps a changed title in the owner snapshot through a later status event', async () => {
    mocks.renameWorkbenchSession.mockResolvedValue('New title');
    await renderNamedSession();

    await act(async () => {
      await rename()('session-1', 'New title');
    });
    await act(async () => mocks.ownerClient?.emitSessionStatus('session-1'));

    expect(visibleTitle()).toBe('New title');
    expect(mocks.updateSessionTitle.mock.calls).toEqual([
      ['session-1', 'New title', false],
      ['session-1', 'New title', true],
    ]);
    expect(mocks.updateSessionTitle.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.requestFullFetch.mock.invocationCallOrder[0]!,
    );
    expect(mocks.requestFullFetch).toHaveBeenCalledTimes(1);
    expect(mocks.requestFullFetch).toHaveBeenLastCalledWith();
  });

  it('reconciles a refused title in case the response was lost after commit', async () => {
    mocks.renameWorkbenchSession.mockRejectedValue(new Error('500'));
    await renderNamedSession();

    await act(async () => {
      await rename()('session-1', 'New title');
    });

    expect(mocks.requestFullFetch).toHaveBeenCalledTimes(1);
    expect(mocks.requestFullFetch).toHaveBeenLastCalledWith();
    expect(mocks.updateSessionTitle.mock.calls).toEqual([
      ['session-1', 'New title', false],
      ['session-1', 'Old title', true],
    ]);
    expect(mocks.updateSessionTitle.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.requestFullFetch.mock.invocationCallOrder[0]!,
    );
  });

  it('persists a queued undo after the first PATCH response fails ambiguously', async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    mocks.renameWorkbenchSession
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await renderNamedSession();

    let renameA!: Promise<string | null>;
    let restoreOld!: Promise<string | null>;
    await act(async () => {
      renameA = rename()('session-1', 'Title A');
      restoreOld = rename()('session-1', 'Old title');
      await Promise.resolve();
    });
    expect(mocks.renameWorkbenchSession).toHaveBeenCalledTimes(1);
    expect(mocks.renameWorkbenchSession).toHaveBeenLastCalledWith('session-1', 'Title A');

    await act(async () => {
      first.reject(new Error('lost response'));
      await renameA;
      await Promise.resolve();
    });
    expect(mocks.renameWorkbenchSession).toHaveBeenCalledTimes(2);
    expect(mocks.renameWorkbenchSession).toHaveBeenLastCalledWith('session-1', 'Old title');

    await act(async () => {
      second.resolve('Old title');
      await restoreOld;
    });
    expect(mocks.store.sessionTitle).toBe('Old title');
  });

  it('keeps queued PATCHes in user order across a workspace shell replacement', async () => {
    const requests = new Map([
      ['Title A', deferred<string | null>()],
      ['Title B', deferred<string | null>()],
      ['Title C', deferred<string | null>()],
    ]);
    mocks.renameWorkbenchSession.mockImplementation(
      (_sessionId: string, title: string | null) => requests.get(title ?? '')!.promise,
    );
    await renderNamedSession();

    let renameA!: Promise<string | null>;
    let renameB!: Promise<string | null>;
    await act(async () => {
      renameA = rename()('session-1', 'Title A');
      renameB = rename()('session-1', 'Title B');
      await Promise.resolve();
    });
    expect(mocks.renameWorkbenchSession.mock.calls.map((call) => call[1])).toEqual(['Title A']);

    await act(async () => root?.unmount());
    root = null;
    mocks.sessionRows = [namedSession()];
    mocks.store.sessionTitle = 'Old title';
    await render();
    mocks.setSessionTitle.mockClear();

    let renameC!: Promise<string | null>;
    await act(async () => {
      renameC = rename()('session-1', 'Title C');
      await Promise.resolve();
    });
    // A component replacement must not create a second writer for this session.
    expect(mocks.renameWorkbenchSession.mock.calls.map((call) => call[1])).toEqual(['Title A']);

    await act(async () => {
      requests.get('Title A')!.resolve('Title A');
      await renameA;
      await Promise.resolve();
    });
    expect(mocks.setSessionTitle).not.toHaveBeenCalledWith('Title A');
    expect(mocks.renameWorkbenchSession.mock.calls.map((call) => call[1])).toEqual([
      'Title A',
      'Title B',
    ]);

    await act(async () => {
      requests.get('Title B')!.reject(new Error('retired request failed'));
      await renameB;
      await Promise.resolve();
    });
    expect(mocks.renameWorkbenchSession.mock.calls.map((call) => call[1])).toEqual([
      'Title A',
      'Title B',
      'Title C',
    ]);

    await act(async () => {
      requests.get('Title C')!.resolve('Title C');
      await renameC;
    });
    expect(mocks.setSessionTitle).not.toHaveBeenCalledWith('Title B');
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.store.sessionTitle).toBe('Title C');
  });

  it('rolls a refused second rename back to the first committed title', async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    mocks.renameWorkbenchSession
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await renderNamedSession();

    let renameA!: Promise<string | null>;
    let renameB!: Promise<string | null>;
    await act(async () => {
      renameA = rename()('session-1', 'Title A');
      renameB = rename()('session-1', 'Title B');
      await Promise.resolve();
    });
    expect(mocks.renameWorkbenchSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve('Title A');
      await renameA;
      await Promise.resolve();
    });
    expect(mocks.renameWorkbenchSession).toHaveBeenLastCalledWith('session-1', 'Title B');

    await act(async () => {
      second.reject(new Error('500'));
      await renameB;
    });
    expect(visibleTitle()).toBe('Title A');
    expect(mocks.store.sessionTitle).toBe('Title A');
  });
});

describe('owner title projection in the workspace shell', () => {
  const session = (id: string, title: string | null) => ({
    id,
    stageId: `stage-${id}`,
    prompt: `${id} prompt`,
    title,
    status: 'succeeded' as const,
    createdAt: 1,
    updatedAt: 9,
  });

  beforeEach(() => {
    mocks.searchParams = new URLSearchParams('session=session-1');
    mocks.store.sessionId = 'session-1';
    mocks.store.sessionTitle = 'Attached title';
  });

  it.each([
    { name: 'rename', initial: 'Attached title', next: 'Event title' },
    { name: 'equal-value clear', initial: null, next: null },
  ])('syncs a title-event $name to the rail and attached header', async ({ initial, next }) => {
    mocks.store.sessionTitle = initial;
    mocks.sessionRows = [session('session-1', initial)];
    await render();
    mocks.setSessionTitle.mockClear();

    await act(async () => mocks.ownerClient?.emitSessionTitle('session-1', next));

    expect(
      (mocks.railProps?.sessions as readonly { id: string; title?: string | null }[])[0]?.title,
    ).toBe(next);
    expect(mocks.setSessionTitle).toHaveBeenCalledWith(next);
  });

  it.each([
    { name: 'rename', title: 'Pending title' },
    { name: 'clear', title: null },
  ])('force-seeds a pending $name even before its owner row exists', async ({ title }) => {
    // Deliberately equal: writing this source, rather than observing a value
    // change, must mark it authoritative. This is essential for null -> null.
    mocks.store.sessionTitle = title;
    mocks.sessionRows = [];
    mocks.unconfirmedSessionTitles.set('session-1', title);

    await render();

    expect(mocks.setSessionTitle).toHaveBeenCalledWith(title);
    expect(mocks.store.sessionTitle).toBe(title);
  });

  it.each([
    { name: 'changed title', initial: 'Attached title', next: 'Recovered title' },
    { name: 'equal-value clear', initial: null, next: null },
  ])('applies a full owner-list snapshot with a $name', async ({ initial, next }) => {
    mocks.store.sessionTitle = initial;
    mocks.sessionRows = [session('session-1', initial)];
    await render();
    mocks.setSessionTitle.mockClear();

    await act(async () => mocks.ownerClient?.reconcileSessions([session('session-1', next)]));

    expect(
      (mocks.railProps?.sessions as readonly { id: string; title?: string | null }[])[0]?.title,
    ).toBe(next);
    expect(mocks.setSessionTitle).toHaveBeenCalledWith(next);
  });

  it('does not let a sparse status publication overwrite a newer detail title', async () => {
    mocks.sessionRows = [session('session-1', 'List title')];
    await render();
    mocks.store.sessionTitle = 'Detail title';
    mocks.setSessionTitle.mockClear();

    await act(async () => mocks.ownerClient?.emitSessionStatus('session-1'));

    expect(mocks.setSessionTitle).not.toHaveBeenCalled();
    expect(mocks.store.sessionTitle).toBe('Detail title');
  });
});

describe('the knowledge base page', () => {
  const libraryShown = () =>
    container?.querySelector('[data-testid="pro-workspace-library"]') !== null;
  const layout = () =>
    container?.querySelector('[data-testid="pro-workspace"]')?.getAttribute('data-ws-layout');
  const openLibrary = async () => {
    const onOpenLibrary = mocks.railProps?.onOpenLibrary as () => void;
    expect(onOpenLibrary).toBeTypeOf('function');
    await act(async () => onOpenLibrary());
  };

  it('opens from the rail into the main area, leaving the conversation mounted', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    await render();
    expect(mocks.railProps?.libraryOpen).toBe(false);
    mocks.detach.mockClear();

    await openLibrary();

    expect(mocks.routerPush).toHaveBeenCalledWith('/workspace?session=session-1&view=library');
    expect(libraryShown()).toBe(true);
    expect(layout()).toBe('library');
    expect(mocks.railProps?.libraryOpen).toBe(true);
    // Hidden, not unmounted: the run's stream and the draft survive the page.
    expect(container?.querySelector('[data-testid="chat-pane"]')).not.toBeNull();
    expect(mocks.chatPaneProps?.hidden).toBe(true);
    expect(mocks.detach).not.toHaveBeenCalled();
  });

  it('keeps the page and adds no history entry when the agent creates a course under it', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    await render();
    await openLibrary();
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);

    mocks.store.stageLinkStageIds = ['stage-1'];
    await render();
    await act(async () => {});

    expect(mocks.routerReplace).toHaveBeenLastCalledWith(
      '/workspace?session=session-1&course=stage-1&view=library',
    );
    // One Back from the page still leaves it: the course arrived by replace.
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    expect(libraryShown()).toBe(true);
    expect(container?.querySelector('[data-testid="classroom-pane"]')).not.toBeNull();
    expect(mocks.classroomProps?.hidden).toBe(true);
  });

  it('stays open when a first message sent before it opened creates its session', async () => {
    const started = deferred<{
      sessionId: string;
      elementRefsAccepted: boolean;
      courseRefsAccepted: boolean;
    }>();
    mocks.startFirstMessage.mockReturnValue(started.promise);
    await render();
    let sent: Promise<unknown> | undefined;
    await act(async () => {
      sent = draft()!.start({ text: '讲一讲', materials: [], elementRefs: [], courseRefs: [] });
    });

    await openLibrary();
    await act(async () => {
      started.resolve({
        sessionId: 'session-new',
        elementRefsAccepted: true,
        courseRefsAccepted: true,
      });
      await sent;
    });

    expect(mocks.routerReplace).toHaveBeenLastCalledWith(
      '/workspace?session=session-new&course=stage-1&view=library',
    );
    expect(libraryShown()).toBe(true);
  });

  it('stays open when a conversation the home composer was creating arrives', async () => {
    mocks.searchParams = new URLSearchParams();
    await render();
    // The home composer's completion, held across the page opening.
    const onOpenSession = mocks.homeProps?.onOpenSession as (id: string) => void;
    expect(onOpenSession).toBeTypeOf('function');

    await openLibrary();
    expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace?view=library');
    await act(async () => onOpenSession('session-made'));

    expect(mocks.routerReplace).toHaveBeenLastCalledWith(
      '/workspace?session=session-made&view=library',
    );
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    expect(mocks.requestFullFetch).toHaveBeenCalled();
    expect(libraryShown()).toBe(true);
  });

  it('stays open when the rail deletes the conversation or the course under it', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    (mocks.courses as { deleteCourse: ReturnType<typeof vi.fn> }).deleteCourse = vi.fn(
      async () => true,
    );
    await render();
    await openLibrary();

    await act(async () => (mocks.railProps?.onSessionDeleted as (id: string) => void)('session-1'));
    expect(mocks.routerReplace).toHaveBeenLastCalledWith('/workspace?course=stage-1&view=library');

    await act(async () => {
      await (mocks.railProps?.onDeleteCourse as (id: string) => Promise<void>)('stage-1');
    });
    expect(mocks.routerReplace).toHaveBeenLastCalledWith('/workspace?view=library');
    expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    expect(libraryShown()).toBe(true);
  });

  it('closes when the teacher opens a conversation, goes home or starts a new one', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [
      { id: 'session-1', stageId: 'stage-1', updatedAt: 9 },
      { id: 'session-2', stageId: 'stage-1', updatedAt: 8 },
    ];
    await render();

    await openLibrary();
    await act(async () => (mocks.railProps?.onOpenSession as (id: string) => void)('session-2'));
    expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace?session=session-2');
    expect(libraryShown()).toBe(false);

    await openLibrary();
    await act(async () => (mocks.railProps?.onGoHome as () => void)());
    expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace');
    expect(libraryShown()).toBe(false);

    await openLibrary();
    expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace?view=library');
    await act(async () => (mocks.railProps?.onNewSession as () => void)());
    expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace');
    expect(libraryShown()).toBe(false);
  });

  describe('through real browser history', () => {
    /** The real history stack under the call counters the other tests read. */
    const useRealHistory = (url: string) => {
      vi.mocked(window.history.pushState).mockImplementation((state, unused, next) => {
        History.prototype.pushState.call(window.history, state, unused, next);
        mocks.routerPush(String(next));
      });
      vi.mocked(window.history.replaceState).mockImplementation((state, unused, next) => {
        History.prototype.replaceState.call(window.history, state, unused, next);
        mocks.routerReplace(String(next));
      });
      History.prototype.replaceState.call(window.history, null, '', url);
    };
    const travel = async (direction: 'back' | 'forward') => {
      await act(async () => {
        const popped = new Promise<void>((resolve) =>
          window.addEventListener('popstate', () => resolve(), { once: true }),
        );
        window.history[direction]();
        await popped;
      });
      await act(async () => {});
    };

    beforeEach(() => {
      useRealHistory('/workspace?session=session-1');
      mocks.searchParams = new URLSearchParams('session=session-1');
      mocks.store.sessionId = 'session-1';
      mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    });

    it('goes Back and Forward across the page after the agent created a course under it', async () => {
      await render();
      await openLibrary();
      mocks.store.stageLinkStageIds = ['stage-1'];
      await render();
      expect(window.location.search).toBe('?session=session-1&course=stage-1&view=library');

      await travel('back');
      expect(window.location.search).toBe('?session=session-1');
      expect(libraryShown()).toBe(false);
      // The course the agent already opened is not opened again over Back.
      expect(mocks.routerPush).toHaveBeenCalledTimes(1);

      await travel('forward');
      expect(window.location.search).toBe('?session=session-1&course=stage-1&view=library');
      expect(libraryShown()).toBe(true);
      expect(mocks.classroomProps?.browser).toMatchObject({ activeCourseId: 'stage-1' });
      expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    });

    it('R6 Back closes the background course view but keeps the saved course reopenable by URL', async () => {
      await render();
      await openLibrary();
      mocks.store.stageLinkStageIds = ['stage-1'];
      await render();
      expect(window.location.search).toBe('?session=session-1&course=stage-1&view=library');
      await travel('back');
      expect(window.location.search).toBe('?session=session-1');
      expect(libraryShown()).toBe(false);
      expect(mocks.railProps?.activeCourseId).toBeNull();
      expect(
        (mocks.railProps?.courses as { classrooms: { id: string }[] }).classrooms.map((c) => c.id),
      ).toContain('stage-1');
      expect(
        (mocks.courses as { deleteCourse: ReturnType<typeof vi.fn> }).deleteCourse,
      ).not.toHaveBeenCalled();
      // A fresh navigation to the course URL can still open the saved course.
      await act(async () => root?.unmount());
      root = null;
      mocks.searchParams = new URLSearchParams('course=stage-1');
      History.prototype.replaceState.call(window.history, null, '', '/workspace?course=stage-1');
      await render();
      expect(mocks.classroomProps?.browser).toMatchObject({ activeCourseId: 'stage-1' });
    });

    it('leaves the page by its way back to what it covered, and Back returns to the page', async () => {
      await render();
      await openLibrary();
      expect(window.location.search).toBe('?session=session-1&view=library');
      const onLeave = mocks.libraryProps?.onLeave as () => void;
      expect(onLeave).toBeTypeOf('function');

      await act(async () => onLeave());
      // A navigation that drops the view (pushed), not a history step.
      expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace?session=session-1');
      expect(window.location.search).toBe('?session=session-1');
      expect(libraryShown()).toBe(false);
      expect(mocks.chatPaneProps?.hidden).toBe(false);

      await travel('back');
      expect(window.location.search).toBe('?session=session-1&view=library');
      expect(libraryShown()).toBe(true);
    });

    it('leaves a page opened from a pasted link, with no history to go back to', async () => {
      useRealHistory('/workspace?view=library');
      mocks.searchParams = new URLSearchParams('view=library');
      mocks.store.sessionId = null;
      mocks.sessionRows = [];
      await render();
      expect(libraryShown()).toBe(true);

      await act(async () => (mocks.libraryProps?.onLeave as () => void)());
      expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace');
      expect(window.location.search).toBe('');
      expect(libraryShown()).toBe(false);
      expect(layout()).toBe('home');
      // Pushed: Back still reaches the page the link opened.
      await travel('back');
      expect(window.location.search).toBe('?view=library');
      expect(libraryShown()).toBe(true);
    });

    it('does not reopen an agent-created course after Back without the page either', async () => {
      await render();
      mocks.store.stageLinkStageIds = ['stage-1'];
      await render();
      expect(window.location.search).toBe('?session=session-1&course=stage-1');

      await travel('back');
      expect(window.location.search).toBe('?session=session-1');
      expect(mocks.routerPush).toHaveBeenCalledTimes(1);
    });
  });

  it('closes only the deleted course when its deletion completes after other tabs opened', async () => {
    mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
    mocks.store.sessionId = 'session-1';
    mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
    const pending = deferred<boolean>();
    mocks.courses = {
      ...mocks.courses!,
      classrooms: [classroom('stage-1'), classroom('stage-2')],
      deleteCourse: vi.fn(() => pending.promise),
    };
    await render();
    let completed!: Promise<void>;
    await act(async () => {
      completed = (mocks.railProps?.onDeleteCourse as (id: string) => Promise<void>)('stage-1');
    });
    await act(async () => (mocks.railProps?.onOpenCourse as (id: string) => void)('stage-2'));
    await openLibrary();
    const navigations = mocks.routerPush.mock.calls.length + mocks.routerReplace.mock.calls.length;

    await act(async () => {
      pending.resolve(true);
      await completed;
    });

    const browser = mocks.classroomProps?.browser as {
      tabs: readonly { id: string }[];
      activeCourseId: string;
    };
    expect(browser.tabs.map((tab) => tab.id)).toEqual(['stage-2']);
    expect(browser.activeCourseId).toBe('stage-2');
    expect(JSON.parse(localStorage.getItem(COURSE_TABS_STORAGE_KEY)!).courseIds).toEqual([
      'stage-2',
    ]);
    // stage-2 stays open under the page: nothing navigated.
    expect(mocks.routerPush.mock.calls.length + mocks.routerReplace.mock.calls.length).toBe(
      navigations,
    );
    expect(libraryShown()).toBe(true);
    expect(container?.querySelector('[data-testid="classroom-pane"]')).not.toBeNull();
  });

  describe('chatting with a material from the page', () => {
    const lesson = {
      materialId: 'src-lesson',
      name: 'lesson.pdf',
      bytes: 3,
      mimeType: 'application/pdf',
      extractionStatus: 'done' as const,
    };
    const chatWith = async () => {
      const onChat = mocks.libraryProps?.onChatWithMaterial as (material: unknown) => void;
      expect(onChat).toBeTypeOf('function');
      await act(async () => onChat(lesson));
    };
    const seedOf = (props: Record<string, unknown> | null) =>
      props?.materialSeed as { key: number; material: unknown; target: unknown } | null | undefined;

    it('hands it to the home composer when no classroom is open, and its own navigation keeps it', async () => {
      mocks.searchParams = new URLSearchParams('session=session-1');
      mocks.store.sessionId = 'session-1';
      mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
      await render();
      await openLibrary();
      await chatWith();

      expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace');
      expect(libraryShown()).toBe(false);
      // The new conversation the hand-over itself started did not drop it.
      const seed = seedOf(mocks.homeProps);
      expect(seed).toMatchObject({ material: lesson, target: { kind: 'home' } });

      const consume = mocks.homeProps?.onMaterialSeedConsumed as (key: number) => void;
      await act(async () => consume(seed!.key));
      expect(seedOf(mocks.homeProps)).toBeNull();
    });

    it('hands it to the new conversation beside the open classroom', async () => {
      mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
      mocks.store.sessionId = 'session-1';
      mocks.sessionRows = [{ id: 'session-1', stageId: 'stage-1', updatedAt: 9 }];
      await render();
      await openLibrary();
      await chatWith();

      expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace?course=stage-1');
      expect(seedOf(mocks.chatPaneProps)).toMatchObject({
        material: lesson,
        target: { kind: 'chat', ownerKey: 'draft:stage-1' },
      });
    });

    it('drops the hand-over once the teacher goes somewhere else', async () => {
      mocks.searchParams = new URLSearchParams('session=session-1&course=stage-1');
      mocks.store.sessionId = 'session-1';
      mocks.sessionRows = [
        { id: 'session-1', stageId: 'stage-1', updatedAt: 9 },
        { id: 'session-2', stageId: 'stage-1', updatedAt: 8 },
      ];
      await render();
      await openLibrary();
      await chatWith();
      expect(seedOf(mocks.chatPaneProps)).not.toBeNull();

      await act(async () => (mocks.railProps?.onOpenSession as (id: string) => void)('session-2'));
      expect(seedOf(mocks.chatPaneProps)).toBeNull();
    });

    it('drops the hand-over on browser Back, so Forward cannot bring it back', async () => {
      vi.mocked(window.history.pushState).mockImplementation((state, unused, next) => {
        History.prototype.pushState.call(window.history, state, unused, next);
        mocks.routerPush(String(next));
      });
      vi.mocked(window.history.replaceState).mockImplementation((state, unused, next) => {
        History.prototype.replaceState.call(window.history, state, unused, next);
        mocks.routerReplace(String(next));
      });
      History.prototype.replaceState.call(window.history, null, '', '/workspace');
      const travel = (direction: 'back' | 'forward') =>
        act(async () => {
          const popped = new Promise<void>((resolve) =>
            window.addEventListener('popstate', () => resolve(), { once: true }),
          );
          window.history[direction]();
          await popped;
        });
      mocks.searchParams = new URLSearchParams();
      await render();
      await openLibrary();
      await chatWith();
      expect(seedOf(mocks.homeProps)).toMatchObject({ target: { kind: 'home' } });

      await travel('back');
      expect(window.location.search).toBe('?view=library');
      await travel('forward');
      expect(window.location.search).toBe('');
      expect(seedOf(mocks.homeProps)).toBeNull();
    });

    it.each(['activate', 'close'] as const)(
      'drops the hand-over when the teacher acts on a classroom tab (%s)',
      async (action) => {
        mocks.courses = {
          ...mocks.courses!,
          classrooms: [classroom('stage-1'), classroom('stage-2')],
        };
        localStorage.setItem(
          COURSE_TABS_STORAGE_KEY,
          JSON.stringify({ courseIds: ['stage-1', 'stage-2'], activeCourseId: 'stage-1' }),
        );
        mocks.searchParams = new URLSearchParams('course=stage-1');
        await render();
        await openLibrary();
        await chatWith();
        expect(seedOf(mocks.chatPaneProps)).toMatchObject({
          target: { kind: 'chat', ownerKey: 'draft:stage-1' },
        });
        const browser = mocks.classroomProps?.browser as {
          onActivateCourse: (id: string) => void;
          onCloseCourse: (id: string) => void;
        };
        await act(async () =>
          action === 'activate'
            ? browser.onActivateCourse('stage-2')
            : browser.onCloseCourse('stage-2'),
        );
        expect(seedOf(mocks.chatPaneProps)).toBeNull();
      },
    );

    it('keeps the hand-over when a deletion confirmed in the background closes a tab', async () => {
      const pending = deferred<boolean>();
      mocks.courses = {
        ...mocks.courses!,
        classrooms: [classroom('stage-1'), classroom('stage-2')],
        deleteCourse: vi.fn(() => pending.promise),
      };
      localStorage.setItem(
        COURSE_TABS_STORAGE_KEY,
        JSON.stringify({ courseIds: ['stage-1', 'stage-2'], activeCourseId: 'stage-1' }),
      );
      mocks.searchParams = new URLSearchParams('course=stage-1');
      await render();
      let deleted!: Promise<void>;
      await act(async () => {
        deleted = (mocks.railProps?.onDeleteCourse as (id: string) => Promise<void>)('stage-2');
      });
      await openLibrary();
      await chatWith();
      const seed = seedOf(mocks.chatPaneProps);
      expect(seed).toMatchObject({ target: { kind: 'chat', ownerKey: 'draft:stage-1' } });

      await act(async () => {
        pending.resolve(true);
        await deleted;
      });
      const browser = mocks.classroomProps?.browser as { tabs: readonly { id: string }[] };
      expect(browser.tabs.map((tab) => tab.id)).toEqual(['stage-1']);
      expect(seedOf(mocks.chatPaneProps)?.key).toBe(seed!.key);
    });

    it('leaves a newer hand-over alone when an older key is reported', async () => {
      mocks.searchParams = new URLSearchParams();
      await render();
      await openLibrary();
      await chatWith();
      const first = seedOf(mocks.homeProps)!.key;
      await openLibrary();
      await chatWith();
      const second = seedOf(mocks.homeProps)!.key;
      expect(second).not.toBe(first);

      const consume = mocks.homeProps?.onMaterialSeedConsumed as (key: number) => void;
      await act(async () => consume(first));
      expect(seedOf(mocks.homeProps)?.key).toBe(second);
    });
  });
});
