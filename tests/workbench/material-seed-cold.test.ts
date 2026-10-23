// @vitest-environment jsdom
/**
 * A knowledge base hand-over arriving before the materials gate has answered
 * (a fresh tab opened straight on `?view=library`, a slow `/api/agent/runtime`):
 * the composer it names must not send without it, by button or by Enter, and
 * sends it once the gate says yes. A gate that says no ends the hand-over
 * instead of holding the composer.
 *
 * The gate's answer is remembered per module, so every case loads the
 * modules afresh (React included, so the hooks share one copy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
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

type Seed = {
  key: number;
  material: { materialId: string; name: string; bytes: number };
  target: { kind: 'home' } | { kind: 'chat'; ownerKey: string };
};

let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
let answerGate!: (response: Response) => void;
const disposers: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  posts = [];
  const gate = new Promise<Response>((resolve) => {
    answerGate = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/agent/runtime') return gate;
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ id: 'ses-new', stageId: 'stage-1', status: 'succeeded' });
      }
      if (url.startsWith('/api/materials/library')) return Response.json({ materials: [] });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function load() {
  const react = await import('react');
  const client = await import('react-dom/client');
  const { ProLaunchPanel } = await import('@/components/workbench/ProLaunchPanel');
  const { WorkbenchChat } = await import('@/components/workbench/WorkbenchChat');
  const panel = await import('@/lib/workbench/panel-context');
  const { useWorkbenchStore } = await import('@/lib/workbench/session-store');
  useWorkbenchStore.getState().detach();
  const { act, createElement } = react;
  const container = document.createElement('div');
  document.body.append(container);
  const root = client.createRoot(container);
  disposers.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  const render = async (node: unknown) => {
    await act(async () => root.render(node as never));
    await settle();
  };
  const type = async (textarea: HTMLTextAreaElement, text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        text,
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  /** Try both ways of sending: the button, and the keyboard. */
  const trySend = async (button: HTMLButtonElement, textarea: HTMLTextAreaElement) => {
    await act(async () => button.click());
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, metaKey: true, bubbles: true }),
      );
    });
  };
  const gateSays = async (enabled: boolean) => {
    await act(async () => answerGate(Response.json({ enabled })));
    await settle();
  };
  return {
    act,
    createElement,
    container,
    render,
    type,
    trySend,
    gateSays,
    ProLaunchPanel,
    WorkbenchChat,
    panel,
  };
}

const seed = (target: Seed['target']): Seed => ({
  key: 1,
  material: { materialId: 'src-cold', name: 'cold.pdf', bytes: 3 },
  target,
});

describe('a hand-over that arrives before the materials gate answers', () => {
  it('holds the home composer until it is staged, then sends it', async () => {
    const view = await load();
    const consumed = vi.fn();
    await view.render(
      view.createElement(view.ProLaunchPanel, {
        focusSignal: 2,
        onSessionCreated: () => {},
        materialSeed: seed({ kind: 'home' }) as never,
        onMaterialSeedConsumed: consumed,
      }),
    );
    const textarea = view.container.querySelector('textarea')!;
    const start = () =>
      view.container.querySelector<HTMLButtonElement>('[data-testid="pro-launch-start"]')!;
    await view.type(textarea, 'Explain this source');
    expect(start().disabled).toBe(true);
    await view.trySend(start(), textarea);
    expect(posts).toEqual([]);
    expect(consumed).not.toHaveBeenCalled();

    await view.gateSays(true);
    expect(consumed).toHaveBeenCalledWith(1);
    expect(start().disabled).toBe(false);
    await view.act(async () => start().click());
    expect(posts.find((post) => post.url === '/api/agent/sessions')?.body.materialIds).toEqual([
      'src-cold',
    ]);
  });

  it('holds the conversation composer it names until it is staged, then sends it', async () => {
    const view = await load();
    const consumed = vi.fn();
    const started = vi.fn(async (_message: Record<string, unknown>) => ({ accepted: true }));
    const navigation = {
      activeCourseId: null,
      courseOptions: [],
      openCourse: () => {},
      lookupCourse: () => null,
    };
    await view.render(
      view.createElement(
        view.panel.WorkbenchCourseNavigationProvider,
        { navigation } as never,
        view.createElement(
          view.panel.WorkbenchDraftConversationProvider,
          { draft: { ownerKey: 'draft:stage-1', start: started } } as never,
          view.createElement(view.WorkbenchChat, {
            hosted: true,
            materialSeed: seed({ kind: 'chat', ownerKey: 'draft:stage-1' }) as never,
            onMaterialSeedConsumed: consumed,
          }),
        ),
      ),
    );
    const textarea = view.container.querySelector<HTMLTextAreaElement>(
      '[data-testid="workbench-chat-composer"]',
    )!;
    const send = () =>
      view.container.querySelector<HTMLButtonElement>('[data-testid="workbench-send"]')!;
    await view.type(textarea, 'Explain this source');
    expect(send().disabled).toBe(true);
    await view.trySend(send(), textarea);
    expect(started).not.toHaveBeenCalled();

    await view.gateSays(true);
    expect(consumed).toHaveBeenCalledWith(1);
    await view.act(async () => send().click());
    expect(started.mock.calls[0]?.[0]).toMatchObject({
      materials: [{ materialId: 'src-cold' }],
    });
  });

  it('does not hold a composer the hand-over is not for', async () => {
    const view = await load();
    await view.render(
      view.createElement(view.ProLaunchPanel, {
        onSessionCreated: () => {},
        materialSeed: seed({ kind: 'chat', ownerKey: 'draft:stage-1' }) as never,
      }),
    );
    const textarea = view.container.querySelector('textarea')!;
    await view.type(textarea, 'Plain message');
    expect(
      view.container.querySelector<HTMLButtonElement>('[data-testid="pro-launch-start"]')!.disabled,
    ).toBe(false);
  });

  it('ends the hand-over when the gate says no, and lets the composer send', async () => {
    const view = await load();
    const consumed = vi.fn();
    await view.render(
      view.createElement(view.ProLaunchPanel, {
        onSessionCreated: () => {},
        materialSeed: seed({ kind: 'home' }) as never,
        onMaterialSeedConsumed: consumed,
      }),
    );
    await view.gateSays(false);
    expect(consumed).toHaveBeenCalledWith(1);

    const textarea = view.container.querySelector('textarea')!;
    await view.type(textarea, 'Plain message');
    const start = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="pro-launch-start"]',
    )!;
    expect(start.disabled).toBe(false);
    await view.act(async () => start.click());
    const sent = posts.find((post) => post.url === '/api/agent/sessions');
    expect(sent?.body.prompt).toBe('Plain message');
    expect(sent?.body.materialIds).toBeUndefined();
  });
});
