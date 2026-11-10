// @vitest-environment jsdom
/**
 * Opening a course while a request preview is the active tab of the right
 * pane shows that course. The preview steps back behind it as a tab of its
 * own, still mounted, so an ask waiting in it is not lost and comes back
 * when its tab is chosen.
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
  coursesPageProps: null as Record<string, unknown> | null,
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
    existingCourse: false as boolean | null,
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
  previewHidden: null as boolean | null,
}));

vi.mock('@/lib/generation-run-client/use-owner-runs', () => ({
  useOwnerRuns: () => ({ runs: [], forget: () => {} }),
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
// The settings dialog (owned by the shell) has its own tests.
vi.mock('@/components/settings', () => ({ SettingsDialog: () => null }));
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
// The conversation's own course cards are what open a course here; the pane is
// tested on its own.
vi.mock('@/components/workbench/workspace/WorkspaceChatPane', () => ({
  WorkspaceChatPane: (props: Record<string, unknown>) => {
    mocks.chatPaneProps = props;
    return null;
  },
}));
vi.mock('@/components/workbench/workspace/WorkspaceRequestActivity', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  const actual = await vi.importActual<
    typeof import('@/components/workbench/workspace/WorkspaceRequestActivity')
  >('@/components/workbench/workspace/WorkspaceRequestActivity');
  return {
    ...actual,
    WorkspaceRequestActivity: (props: {
      hidden: boolean;
      onStateChange: (state: unknown) => void;
    }) => {
      // A request that started animating and now waits on an ask.
      useEffect(() => {
        props.onStateChange({
          sessionId: mocks.store.sessionId,
          shown: true,
          requestKey: 'request-1',
          live: true,
          label: 'Asking',
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      mocks.previewHidden = props.hidden;
      return createElement('div', { 'data-testid': 'request-preview' });
    },
  };
});
// My courses carries the library's course actions (open, delete, the
// generating cards); the page itself is tested on its own.
vi.mock('@/components/workbench/workspace/WorkspaceCoursesPage', () => ({
  WorkspaceCoursesPage: (props: Record<string, unknown>) => {
    mocks.coursesPageProps = props;
    return createElement('main', { 'data-testid': 'workspace-courses-page' });
  },
}));
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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Uploads report progress through XMLHttpRequest when the page has it; here
  // they go through the fetch mock instead.
  vi.stubGlobal('XMLHttpRequest', undefined);
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
    moveCourse: vi.fn(),
    deleteCourse: vi.fn(),
  };
  mocks.classroomProps = null;
  mocks.classroomMounts = 0;
  mocks.chatPaneProps = null;
  mocks.railProps = null;
  mocks.coursesPageProps = null;
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
  mocks.store.existingCourse = false;
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

describe('opening a course while a request preview is the active tab', () => {
  it('shows the course and keeps the preview, mounted, as a tab of its own', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    mocks.searchParams = new URLSearchParams('session=ses-1');
    mocks.sessionRows = [{ id: 'ses-1', stageId: 'stage-new', updatedAt: 1 }];
    mocks.store.sessionId = 'ses-1';
    mocks.store.status = 'running';
    await render();
    expect(mocks.previewHidden).toBe(false);

    // A course card in the conversation (browsing would set the conversation,
    // and its preview, aside).
    const navigation = mocks.chatPaneProps?.navigation as { openCourse: (id: string) => void };
    await act(async () => navigation.openCourse('stage-1'));
    mocks.searchParams = new URLSearchParams('session=ses-1&course=stage-1');
    await render();

    expect(mocks.classroomProps?.hidden).toBe(false);
    expect(mocks.previewHidden).toBe(true);
    expect(container!.querySelector('[data-testid="request-preview"]')).not.toBeNull();
  });

  it('lets the preview of a conversation reloaded beside its course take focus once, like any request', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // A `?course=&session=` URL: the conversation stays beside the course.
    mocks.searchParams = new URLSearchParams('session=ses-1&course=stage-1');
    mocks.sessionRows = [{ id: 'ses-1', stageId: 'stage-new', updatedAt: 1 }];
    mocks.store.sessionId = 'ses-1';
    mocks.store.status = 'running';
    await render();
    // The request's preview takes focus once, and the opened course stays
    // mounted behind it, one tab away.
    expect(mocks.classroomProps?.hidden).toBe(true);
    expect(mocks.previewHidden).toBe(false);
    const browser = mocks.classroomProps?.browser as { onActivateCourse: (id: string) => void };
    await act(async () => browser.onActivateCourse('stage-1'));
    await render();
    expect(mocks.classroomProps?.hidden).toBe(false);
    expect(mocks.previewHidden).toBe(true);
  });
});
