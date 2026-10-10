// @vitest-environment jsdom
/**
 * The knowledge base page's hand-overs with the real shell and the real
 * composers behind it -- the paths a test of one component cannot see:
 *
 * - "chat with this material" twice beside a classroom starts the second
 *   conversation clean: no text or source of the first comes along;
 * - a home conversation whose POST was in flight when the teacher opened the
 *   knowledge base attaches under the page instead of being dropped;
 * - Escapes on the page never stop the run of the conversation it covers.
 */

import { act, createElement, type ReactNode } from 'react';
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
vi.mock('@/lib/workbench/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workbench/session-store')>();
  const state = () => ({
    ...actual.useWorkbenchStore.getState(),
    ...mocks.store,
    attach: mocks.attach,
    detach: mocks.detach,
    setPanelOpen: mocks.setPanelOpen,
    setPlaybackOn: mocks.setPlaybackOn,
    setSessionTitle: mocks.setSessionTitle,
  });
  return {
    ...actual,
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
// The home composer itself, wired the way WorkspaceHome wires it.
vi.mock('@/components/workbench/workspace/WorkspaceHome', async () => {
  const { ProLaunchPanel } = await import('@/components/workbench/ProLaunchPanel');
  return {
    WorkspaceHome: (props: Record<string, unknown>) => {
      mocks.homeProps = props;
      return createElement(ProLaunchPanel, {
        focusSignal: props.composerReset as number,
        onSessionCreated: props.onOpenSession as (id: string) => void,
        onSessionCreatedAfterLeaving: props.onOpenSessionAfterLeaving as (id: string) => void,
        materialSeed: props.materialSeed as never,
        onMaterialSeedConsumed: props.onMaterialSeedConsumed as (key: number) => void,
      });
    },
  };
});
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

vi.mock('@/lib/workbench/agent-skills', () => ({
  useAgentSkills: () => ({ skills: [], loading: false, error: null, reload: async () => {} }),
  invalidateAgentSkills: async () => {},
}));
vi.mock('@/components/workbench/chat/chat-timeline', () => ({ ChatTimeline: () => null }));
vi.mock('@/components/workbench/chat/autoscroll', () => ({
  useWorkbenchAutoscroll: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    isNearBottom: true,
    scrollToBottom: async () => {},
  }),
}));

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const fetchCalls: { url: string; method: string }[] = [];
function serve(post?: Fetch) {
  fetchCalls.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      fetchCalls.push({ url, method });
      if (method === 'POST' && post) return post(input, init);
      if (url === '/api/agent/runtime') return Response.json({ enabled: true });
      return Response.json([]);
    }),
  );
}
const type = async (textarea: HTMLTextAreaElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      text,
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const openLibrary = () => act(async () => (mocks.railProps!.onOpenLibrary as () => void)());
const chatWith = async (id: string) => {
  await openLibrary();
  await act(async () =>
    (mocks.libraryProps!.onChatWithMaterial as (material: unknown) => void)({
      materialId: id,
      name: `${id}.pdf`,
      bytes: 3,
    }),
  );
};

describe('chat with this material, twice beside a classroom', () => {
  it('starts the second conversation clean: only its own source, no earlier text', async () => {
    serve();
    await render();
    await chatWith('A');
    expect(container!.textContent).toContain('A.pdf');
    await type(container!.querySelector('textarea')!, 'Old draft A');

    await chatWith('B');
    expect(container!.querySelector('textarea')!.value).toBe('');
    expect(container!.textContent).toContain('B.pdf');
    expect(container!.textContent).not.toContain('A.pdf');

    await type(container!.querySelector('textarea')!, 'About B');
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('[data-testid="workbench-send"]')!.click(),
    );
    expect(mocks.startFirstMessage).toHaveBeenCalledTimes(1);
    const sent = mocks.startFirstMessage.mock.calls[0][0] as {
      text: string;
      materials: { materialId: string }[];
    };
    expect(sent.text).toBe('About B');
    expect(sent.materials.map((material) => material.materialId)).toEqual(['B']);
  });
});

describe('an upload still in flight when the next hand-over arrives', () => {
  async function uploadOldThenMaybeHandOver(handOver: boolean) {
    const uploaded = deferred<Response>();
    serve(() => uploaded.promise);
    await render();
    await chatWith('A');
    const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['old'], 'old.pdf', { type: 'application/pdf' })],
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(fetchCalls.some((call) => call.url === '/api/materials')).toBe(true);
    if (handOver) await chatWith('B');
    await act(async () =>
      uploaded.resolve(
        Response.json({
          materialId: 'old-upload',
          originalName: 'old.pdf',
          bytes: 3,
          mime: 'application/pdf',
        }),
      ),
    );
    await type(container!.querySelector('textarea')!, 'Send now');
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('[data-testid="workbench-send"]')!.click(),
    );
    expect(mocks.startFirstMessage).toHaveBeenCalledTimes(1);
    const sent = mocks.startFirstMessage.mock.calls[0][0] as {
      materials: { materialId: string }[];
    };
    return sent.materials.map((material) => material.materialId);
  }

  it('joins the draft it was picked in', async () => {
    expect(await uploadOldThenMaybeHandOver(false)).toEqual(['A', 'old-upload']);
  });

  it('stays out of the new conversation', async () => {
    expect(await uploadOldThenMaybeHandOver(true)).toEqual(['B']);
  });
});

describe('a home conversation created while the knowledge base was opened', () => {
  async function sendFromHome() {
    mocks.searchParams = new URLSearchParams();
    const created = deferred<Response>();
    serve(() => created.promise);
    await render();
    await type(container!.querySelector('textarea')!, 'Teach A');
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('[data-testid="pro-launch-start"]')!.click(),
    );
    expect(fetchCalls.filter((call) => call.method === 'POST')).toHaveLength(1);
    return () =>
      act(async () =>
        created.resolve(
          Response.json({ id: 'session-created', stageId: 'stage-created', status: 'queued' }),
        ),
      );
  }

  it('opens the conversation when the composer is still there', async () => {
    const answer = await sendFromHome();
    await answer();
    expect(mocks.routerPush).toHaveBeenLastCalledWith('/workspace?session=session-created');
  });

  it('attaches it under the page, which stays', async () => {
    const answer = await sendFromHome();
    await openLibrary();
    expect(container!.querySelector('[data-testid="pro-launch-panel"]')).toBeNull();
    mocks.routerReplace.mockClear();
    await answer();
    expect(mocks.routerReplace).toHaveBeenLastCalledWith(
      '/workspace?session=session-created&view=library',
    );
  });

  it('leaves it in the rail when the teacher went home and opened the page again', async () => {
    const answer = await sendFromHome();
    await openLibrary();
    await act(async () => (mocks.railProps!.onGoHome as () => void)());
    expect(container!.querySelector('[data-testid="pro-launch-panel"]')).not.toBeNull();
    await type(container!.querySelector('textarea')!, 'A new draft');
    await openLibrary();
    mocks.routerPush.mockClear();
    mocks.routerReplace.mockClear();
    await answer();
    expect([...mocks.routerPush.mock.calls, ...mocks.routerReplace.mock.calls]).toEqual([]);
  });

  it('leaves it in the rail when the teacher moved on to a classroom', async () => {
    const answer = await sendFromHome();
    await act(async () => (mocks.railProps!.onOpenCourse as (id: string) => void)('stage-1'));
    expect(container!.querySelector('[data-testid="pro-launch-panel"]')).toBeNull();
    mocks.routerPush.mockClear();
    mocks.routerReplace.mockClear();
    await answer();
    expect([...mocks.routerPush.mock.calls, ...mocks.routerReplace.mock.calls]).toEqual([]);
  });
});

describe('Escapes on the knowledge base page', () => {
  const doubleEscape = () =>
    act(async () => {
      for (let i = 0; i < 2; i += 1) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
  const cancels = () => fetchCalls.filter((call) => call.url.endsWith('/cancel'));

  beforeEach(() => {
    mocks.searchParams = new URLSearchParams('session=ses-live');
    mocks.store.sessionId = 'ses-live';
    mocks.store.status = 'running';
  });

  it('stop the run on screen, as before', async () => {
    serve(async () => new Response(null, { status: 202 }));
    await render();
    await doubleEscape();
    expect(cancels()).toEqual([{ url: '/api/agent/sessions/ses-live/cancel', method: 'POST' }]);
  });

  it('never stop the run the page covers', async () => {
    serve(async () => new Response(null, { status: 202 }));
    await render();
    await openLibrary();
    await doubleEscape();
    expect(cancels()).toEqual([]);
  });
});

describe('a draft message still on its way when the next hand-over arrives', () => {
  type Started = { sessionId: string; elementRefsAccepted: boolean; courseRefsAccepted: boolean };
  const started = (sessionId: string): Started => ({
    sessionId,
    elementRefsAccepted: true,
    courseRefsAccepted: true,
  });
  const textarea = () => container!.querySelector('textarea')!;
  const sendButton = () =>
    container!.querySelector<HTMLButtonElement>('[data-testid="workbench-send"]');
  const send = () => act(async () => sendButton()!.click());
  const attachedTo = (sessionId: string) =>
    [...mocks.routerPush.mock.calls, ...mocks.routerReplace.mock.calls].some(([url]) =>
      String(url).includes(`session=${sessionId}`),
    );

  /** Beside classroom stage-1: hand over A, send about it, and keep that send pending. */
  async function sendAboutA() {
    const sendingA = deferred<Started>();
    mocks.startFirstMessage.mockImplementationOnce(() => sendingA.promise);
    serve();
    await render();
    await chatWith('A');
    await type(textarea(), 'About A');
    await send();
    expect(mocks.startFirstMessage).toHaveBeenCalledTimes(1);
    return sendingA;
  }

  it('control: nobody superseded it, so its success attaches the conversation', async () => {
    const sendingA = await sendAboutA();
    await act(async () => sendingA.resolve(started('session-A')));
    expect(mocks.routerReplace).toHaveBeenLastCalledWith(
      '/workspace?session=session-A&course=stage-1',
    );
  });

  it('control: nobody superseded it, so its failure puts the text back', async () => {
    const sendingA = await sendAboutA();
    await act(async () => sendingA.reject(new Error('send A failed')));
    expect(textarea().value).toBe('About A');
    expect(mocks.toastError).toHaveBeenCalledWith('send A failed');
  });

  it('a late success stays in the rail and does not take the new draft over', async () => {
    const sendingA = await sendAboutA();
    await chatWith('B');
    // The new draft is free at once: no STOP left over from A, and it can send.
    expect(container!.querySelector('[data-testid="workbench-stop"]')).toBeNull();
    expect(textarea().value).toBe('');
    expect(container!.textContent).toContain('B.pdf');
    await type(textarea(), 'Typing about B');
    mocks.requestFullFetch.mockClear();

    await act(async () => sendingA.resolve(started('session-A')));
    // Created, so the rail reloads; not attached, and the draft is untouched.
    expect(mocks.requestFullFetch).toHaveBeenCalled();
    expect(attachedTo('session-A')).toBe(false);
    expect(textarea().value).toBe('Typing about B');
    expect(container!.textContent).toContain('B.pdf');

    // B's message starts its own conversation, with B's source alone.
    mocks.startFirstMessage.mockResolvedValueOnce(started('session-B'));
    await send();
    const sentB = mocks.startFirstMessage.mock.calls[1][0] as {
      text: string;
      materials: { materialId: string }[];
    };
    expect(sentB.text).toBe('Typing about B');
    expect(sentB.materials.map((material) => material.materialId)).toEqual(['B']);
    expect(mocks.routerReplace).toHaveBeenLastCalledWith(
      '/workspace?session=session-B&course=stage-1',
    );
  });

  it('a late failure is reported but its text never lands in the new draft', async () => {
    const sendingA = await sendAboutA();
    await chatWith('B');
    await type(textarea(), 'Typing about B');

    await act(async () => sendingA.reject(new Error('send A failed')));
    expect(mocks.toastError).toHaveBeenCalledWith('send A failed');
    expect(textarea().value).toBe('Typing about B');
    expect(container!.textContent).toContain('B.pdf');
    expect(container!.textContent).not.toContain('A.pdf');
    expect(container!.querySelector('[data-testid="workbench-stop"]')).toBeNull();
  });

  it('a late completion does not release the new draft while its own send is pending', async () => {
    const sendingA = await sendAboutA();
    await chatWith('B');
    const sendingB = deferred<Started>();
    mocks.startFirstMessage.mockImplementationOnce(() => sendingB.promise);
    await type(textarea(), 'About B');
    await send();
    expect(mocks.startFirstMessage).toHaveBeenCalledTimes(2);

    expect(container!.querySelector('[data-testid="workbench-stop"]')).not.toBeNull();

    await act(async () => sendingA.resolve(started('session-A')));
    // B is still on its way: its STOP stays, and a second send (Enter) must not slip through.
    expect(container!.querySelector('[data-testid="workbench-stop"]')).not.toBeNull();
    await type(textarea(), 'Again');
    await act(async () => {
      textarea().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    expect(mocks.startFirstMessage).toHaveBeenCalledTimes(2);

    await act(async () => sendingB.resolve(started('session-B')));
    expect(attachedTo('session-A')).toBe(false);
    expect(mocks.routerReplace).toHaveBeenLastCalledWith(
      '/workspace?session=session-B&course=stage-1',
    );
  });

  it('home: a pending home message is not attached once a hand-over opened a new home draft', async () => {
    mocks.searchParams = new URLSearchParams();
    const created = deferred<Response>();
    serve(() => created.promise);
    await render();
    await type(textarea(), 'Teach A');
    await act(async () =>
      container!.querySelector<HTMLButtonElement>('[data-testid="pro-launch-start"]')!.click(),
    );
    await chatWith('B');
    expect(container!.querySelector('[data-testid="pro-launch-panel"]')).not.toBeNull();
    expect(container!.textContent).toContain('B.pdf');
    mocks.routerPush.mockClear();
    mocks.routerReplace.mockClear();

    await act(async () =>
      created.resolve(
        Response.json({ id: 'session-A', stageId: 'stage-created', status: 'queued' }),
      ),
    );
    expect([...mocks.routerPush.mock.calls, ...mocks.routerReplace.mock.calls]).toEqual([]);
    expect(container!.textContent).toContain('B.pdf');
    expect(textarea().value).toBe('');
  });
});
