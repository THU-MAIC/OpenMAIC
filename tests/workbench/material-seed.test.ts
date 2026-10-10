// @vitest-environment jsdom
/**
 * "Chat with this material" from the knowledge base page (RFC #1716 §7): the
 * hand-over stages the material in the one composer it names -- surviving the
 * reset that composer runs as it mounts -- once, without posting anything,
 * and answers when it is over: staged, or refused by the per-message cap.
 */
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { error: toastError, warning: vi.fn() } }));
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

import { ProLaunchPanel } from '@/components/workbench/ProLaunchPanel';
import { WorkbenchChat } from '@/components/workbench/WorkbenchChat';
import {
  useMaterialSeed,
  type AddExistingOutcome,
  type MaterialSeed,
} from '@/components/workbench/compose-extras';
import {
  WorkbenchCourseNavigationProvider,
  WorkbenchDraftConversationProvider,
} from '@/lib/workbench/panel-context';
import { useWorkbenchStore, type WorkbenchMaterial } from '@/lib/workbench/session-store';
import { MAX_COMPOSER_MATERIALS } from '@/lib/workbench/material-upload-scheduling';

const material = (id: string): WorkbenchMaterial => ({
  materialId: id,
  name: `${id}.pdf`,
  bytes: 3,
  mimeType: 'application/pdf',
  extractionStatus: 'done',
});
const home = (key: number, id = 'src-lesson'): MaterialSeed => ({
  key,
  material: material(id),
  target: { kind: 'home' },
});

let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
const disposers: Array<() => Promise<void>> = [];

const wait = (milliseconds = 30) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });

beforeEach(() => {
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
  toastError.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ url, body });
        return Response.json({ id: 'ses-new', stageId: 'stage-1', status: 'succeeded' });
      }
      if (url === '/api/agent/runtime') return Response.json({ enabled: true });
      if (url.startsWith('/api/materials/library')) return Response.json({ materials: [] });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  useWorkbenchStore.getState().detach();
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposers.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    container,
    render: async (node: ReturnType<typeof createElement>) => {
      await act(async () => root.render(node));
      await wait();
    },
  };
}

describe('handing a material to the home composer', () => {
  it('stages it after the reset a remounted composer runs, posts nothing, and sends it', async () => {
    const consumed = vi.fn();
    const view = mount();
    // A composer already ran in this tab, so materials are offered from the
    // first render -- the case where the order of the two effects decides.
    await view.render(createElement(ProLaunchPanel, { key: 'before', onSessionCreated: () => {} }));
    // Arriving from the knowledge base: Home mounts again, with a non-zero reset.
    await view.render(
      createElement(ProLaunchPanel, {
        key: 'arrived',
        focusSignal: 2,
        onSessionCreated: () => {},
        materialSeed: home(7),
        onMaterialSeedConsumed: consumed,
      }),
    );

    expect(view.container.textContent).toContain('src-lesson.pdf');
    expect(posts).toEqual([]);
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(consumed).toHaveBeenCalledWith(7);

    const textarea = view.container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Teach this',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>('[data-testid="pro-launch-start"]')!.click(),
    );
    expect(posts.find((post) => post.url === '/api/agent/sessions')?.body.materialIds).toEqual([
      'src-lesson',
    ]);
  });

  it('takes one key once, under StrictMode and across re-renders', async () => {
    const consumed = vi.fn();
    const seed = home(3);
    const view = mount();
    const panel = () =>
      createElement(
        StrictMode,
        null,
        createElement(ProLaunchPanel, {
          focusSignal: 1,
          onSessionCreated: () => {},
          materialSeed: seed,
          onMaterialSeedConsumed: consumed,
        }),
      );
    await view.render(panel());
    await view.render(panel());
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(view.container.textContent?.split('src-lesson.pdf').length).toBe(2);
  });

  it('leaves a hand-over meant for a conversation alone', async () => {
    const consumed = vi.fn();
    const view = mount();
    await view.render(
      createElement(ProLaunchPanel, {
        onSessionCreated: () => {},
        materialSeed: { ...home(1), target: { kind: 'chat', ownerKey: 'draft:stage-1' } },
        onMaterialSeedConsumed: consumed,
      }),
    );
    expect(view.container.textContent).not.toContain('src-lesson.pdf');
    expect(consumed).not.toHaveBeenCalled();
  });

  it('ends a hand-over the per-message cap refuses, saying so, without staging it', async () => {
    const consumed = vi.fn();
    const view = mount();
    const panel = (seed: MaterialSeed) =>
      createElement(ProLaunchPanel, {
        onSessionCreated: () => {},
        materialSeed: seed,
        onMaterialSeedConsumed: consumed,
      });
    for (let key = 1; key <= MAX_COMPOSER_MATERIALS; key += 1) {
      await view.render(panel(home(key, `src-${key}`)));
    }
    expect(toastError).not.toHaveBeenCalled();

    await view.render(panel(home(99, 'src-overflow')));
    expect(toastError).toHaveBeenCalledWith('workbench.material.maxSelected');
    expect(consumed).toHaveBeenLastCalledWith(99);
    expect(view.container.textContent).not.toContain('src-overflow.pdf');
  });
});

describe('handing a material to a conversation composer', () => {
  async function chat(ownerKey: string, seed: MaterialSeed, consumed: () => void) {
    const view = mount();
    const navigation = {
      activeCourseId: null,
      courseOptions: [],
      openCourse: () => {},
      lookupCourse: () => null,
    };
    const draft = { ownerKey, start: async () => ({ accepted: true }) };
    await view.render(
      createElement(
        WorkbenchCourseNavigationProvider,
        { navigation } as never,
        createElement(
          WorkbenchDraftConversationProvider,
          { draft } as never,
          createElement(WorkbenchChat, {
            hosted: true,
            materialSeed: seed,
            onMaterialSeedConsumed: consumed,
          }),
        ),
      ) as never,
    );
    return view;
  }

  it('stages it in the draft beside the classroom it names, and nowhere else', async () => {
    const seed: MaterialSeed = {
      ...home(5),
      target: { kind: 'chat', ownerKey: 'draft:stage-1' },
    };
    const consumed = vi.fn();
    const named = await chat('draft:stage-1', seed, consumed);
    expect(named.container.textContent).toContain('src-lesson.pdf');
    expect(consumed).toHaveBeenCalledWith(5);
    expect(posts).toEqual([]);

    const other = vi.fn();
    const elsewhere = await chat('draft:stage-2', seed, other);
    expect(elsewhere.container.textContent).not.toContain('src-lesson.pdf');
    expect(other).not.toHaveBeenCalled();
  });
});

describe('the hand-over itself', () => {
  type Gate = 'pending' | 'on' | 'off';
  function Probe({
    seed,
    targeted,
    gate,
    addExisting,
    consumed,
    awaiting,
  }: {
    readonly seed: MaterialSeed | null;
    readonly targeted: boolean;
    readonly gate: Gate;
    readonly addExisting: (material: WorkbenchMaterial) => AddExistingOutcome;
    readonly consumed: (key: number) => void;
    readonly awaiting: (waiting: boolean) => void;
  }) {
    awaiting(
      useMaterialSeed({
        seed,
        targeted,
        materials: { enabled: gate === 'on', enabledKnown: gate !== 'pending', addExisting },
        onConsumed: consumed,
      }),
    );
    return null;
  }
  const probe = (props: {
    seed: MaterialSeed | null;
    targeted: boolean;
    gate: Gate;
    addExisting: (material: WorkbenchMaterial) => AddExistingOutcome;
    consumed: (key: number) => void;
    awaiting?: (waiting: boolean) => void;
  }) => createElement(Probe, { awaiting: () => {}, ...props });

  it('waits while the gate has not answered, holding the composer, then stages it', async () => {
    const addExisting = vi.fn(() => 'staged' as AddExistingOutcome);
    const consumed = vi.fn();
    const awaiting = vi.fn();
    const view = mount();
    const seed = home(1);
    await view.render(
      probe({ seed, targeted: true, gate: 'pending', addExisting, consumed, awaiting }),
    );
    expect(addExisting).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
    expect(awaiting).toHaveBeenLastCalledWith(true);

    await view.render(probe({ seed, targeted: true, gate: 'on', addExisting, consumed, awaiting }));
    expect(consumed).toHaveBeenCalledWith(1);
    expect(addExisting).toHaveBeenLastCalledWith(seed.material);
    expect(awaiting).toHaveBeenLastCalledWith(false);
  });

  it('ends the hand-over, staging nothing, when the gate answers no', async () => {
    const addExisting = vi.fn(() => 'staged' as AddExistingOutcome);
    const consumed = vi.fn();
    const awaiting = vi.fn();
    const view = mount();
    await view.render(
      probe({ seed: home(2), targeted: true, gate: 'off', addExisting, consumed, awaiting }),
    );
    expect(addExisting).not.toHaveBeenCalled();
    expect(consumed).toHaveBeenCalledWith(2);
    expect(awaiting).toHaveBeenLastCalledWith(false);
  });

  it('does not hold a composer the hand-over is not for', async () => {
    const awaiting = vi.fn();
    const view = mount();
    await view.render(
      probe({
        seed: home(3),
        targeted: false,
        gate: 'pending',
        addExisting: vi.fn(),
        consumed: vi.fn(),
        awaiting,
      }),
    );
    expect(awaiting).toHaveBeenLastCalledWith(false);
  });

  it('tries a refused hand-over once, even when development replays the effect', async () => {
    const addExisting = vi.fn(() => 'full' as AddExistingOutcome);
    const consumed = vi.fn();
    const view = mount();
    await view.render(
      createElement(
        StrictMode,
        null,
        probe({ seed: home(4), targeted: true, gate: 'on', addExisting, consumed }),
      ),
    );
    expect(addExisting).toHaveBeenCalledTimes(1);
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('stages nothing once the hand-over is dropped while it waited', async () => {
    const addExisting = vi.fn(() => 'staged' as AddExistingOutcome);
    const consumed = vi.fn();
    const view = mount();
    await view.render(
      probe({ seed: home(1), targeted: true, gate: 'pending', addExisting, consumed }),
    );
    // The teacher went elsewhere: the shell dropped the seed.
    await view.render(probe({ seed: null, targeted: false, gate: 'on', addExisting, consumed }));
    expect(addExisting).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
  });
});
