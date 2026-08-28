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

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  setPanelOpen: vi.fn(),
  setPlaybackOn: vi.fn(),
  startFirstMessage: vi.fn(),
  requestFullFetch: vi.fn(),
  classroomMounts: 0,
  classroomProps: null as Record<string, unknown> | null,
  chatPaneProps: null as Record<string, unknown> | null,
  searchParams: new URLSearchParams('course=stage-1'),
  sessionRows: [] as readonly {
    id: string;
    stageId: string;
    updatedAt: number;
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  }[],
  sessionListState: 'ready' as 'loading' | 'ready' | 'error',
  ownerOptions: null as null | {
    onSessions: (rows: readonly { id: string; stageId: string; updatedAt: number }[]) => void;
    onState: (state: 'loading' | 'ready' | 'error') => void;
  },
  router: null as {
    push: (...args: unknown[]) => unknown;
    replace: (...args: unknown[]) => unknown;
  } | null,
  courses: null as Record<string, unknown> | null,
  railProps: null as Record<string, unknown> | null,
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
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => mocks.searchParams,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-home-discovery', () => ({
  useHomeDiscovery: () => mocks.courses,
}));
vi.mock('@/lib/workbench/session-store', () => ({
  useWorkbenchStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      ...mocks.store,
      attach: mocks.attach,
      detach: mocks.detach,
      setPanelOpen: mocks.setPanelOpen,
      setPlaybackOn: mocks.setPlaybackOn,
    }),
}));
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
    constructor(
      private readonly options: {
        onSessions: (rows: readonly { id: string; stageId: string; updatedAt: number }[]) => void;
        onState: (state: 'loading' | 'ready' | 'error') => void;
      },
    ) {}
    start() {
      mocks.ownerOptions = this.options;
      this.options.onSessions(mocks.sessionRows);
      this.options.onState(mocks.sessionListState);
    }
    stop() {}
    requestFullFetch = mocks.requestFullFetch;
    updateSessions() {}
  },
}));
vi.mock('@/lib/workbench/pro-swap', () => ({ startProSwap: vi.fn() }));
vi.mock('@/components/workbench/workspace/WorkspaceRail', () => ({
  WorkspaceRail: (props: Record<string, unknown>) => {
    mocks.railProps = props;
    return null;
  },
}));
vi.mock('@/components/workbench/workspace/WorkspaceHome', () => ({ WorkspaceHome: () => null }));
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
vi.mock('@/components/workbench/workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));

import { WorkspaceShell } from '@/components/workbench/workspace/WorkspaceShell';
import {
  CHAT_COLLAPSED_STORAGE_KEY,
  CLASSROOM_COLLAPSED_STORAGE_KEY,
} from '@/lib/workbench/workspace-panes';
import { COURSE_TABS_STORAGE_KEY } from '@/lib/workbench/workspace-course-tabs';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const classroom = (id: string) => ({ id, name: `${id} name`, sceneCount: 3, isOwner: true });

const render = async (node: ReactNode = createElement(WorkspaceShell)) => {
  container ??= document.createElement('div');
  if (!container.parentNode) document.body.appendChild(container);
  root ??= createRoot(container);
  await act(async () => root?.render(node));
};

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
  mocks.searchParams = new URLSearchParams('course=stage-1');
  mocks.sessionRows = [];
  mocks.sessionListState = 'ready';
  mocks.ownerOptions = null;
  mocks.store.sessionId = null;
  mocks.store.stageId = null;
  mocks.store.status = 'succeeded';
  mocks.store.stageLinkStageIds = [];
  mocks.store.replayedStageLinkCount = 0;
  mocks.store.touchedStageIds = [];
  mocks.routerPush.mockClear();
  mocks.routerReplace.mockClear();
  mocks.requestFullFetch.mockClear();
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
