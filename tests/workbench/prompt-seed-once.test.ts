// @vitest-environment jsdom
/**
 * An example picked in the first-run tour is sent from the home composer ONCE.
 *
 * The seed used to be applied by an effect keyed on its key, which also runs on
 * mount: every remount of the home composer (the logo, "Getting started",
 * "Make a class", Back) re-sent the example, and StrictMode's double effect run
 * sent it twice each time. These pin the one-shot contract: one create under
 * StrictMode, none on a remount with the same seed, none after the shell has
 * consumed it and gone home again.
 */
import { act, createElement, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ locale: 'en-US', t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/workbench/agent-skills', () => ({
  useAgentSkills: () => ({ skills: [], loading: false, error: null, reload: async () => {} }),
  invalidateAgentSkills: async () => {},
}));

import { ProLaunchPanel, type PromptSeed } from '@/components/workbench/ProLaunchPanel';
import { nextPromptSeedKey, usePromptSeed } from '@/lib/workbench/prompt-seed';

let creates = 0;
const disposers: Array<() => Promise<void>> = [];
const wait = (ms = 40) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

beforeEach(() => {
  creates = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
      if (init?.method === 'POST' && url === '/api/agent/sessions') {
        creates += 1;
        // Slow enough that a second send could start before the first answers.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({ id: `ses-${creates}`, stageId: 'stage-1', status: 'queued' });
      }
      if (url === '/api/agent/runtime') return Response.json({ enabled: true });
      if (url.startsWith('/api/materials/library')) return Response.json({ materials: [] });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
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
    render: async (node: ReturnType<typeof createElement>) => {
      await act(async () => root.render(node));
      await wait();
    },
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

describe('a sending prompt seed', () => {
  it('creates exactly one session under StrictMode', async () => {
    const seed: PromptSeed = { key: nextPromptSeedKey(), text: 'Why is the sky blue?', send: true };
    const view = mount();
    await view.render(
      createElement(
        StrictMode,
        null,
        createElement(ProLaunchPanel, { onSessionCreated: () => {}, promptSeed: seed }),
      ),
    );
    expect(creates).toBe(1);
  });

  it('is not sent again when the composer remounts with the same seed', async () => {
    const seed: PromptSeed = { key: nextPromptSeedKey(), text: 'Why is the sky blue?', send: true };
    const panel = (key: string) =>
      createElement(
        StrictMode,
        null,
        createElement(ProLaunchPanel, { key, onSessionCreated: () => {}, promptSeed: seed }),
      );
    const view = mount();
    await view.render(panel('a'));
    await view.render(panel('b'));
    await view.render(panel('c'));
    expect(creates).toBe(1);
  });

  it('is sent once by the shell wiring, however often home is entered again', async () => {
    const actions: { current: { send: (text: string) => void; goHome: () => void } | null } = {
      current: null,
    };
    function Shell() {
      const seeds = usePromptSeed();
      const [visit, setVisit] = useState(0);
      const handlers = {
        send: seeds.send,
        goHome: () => {
          seeds.clear();
          setVisit((value) => value + 1);
        },
      };
      useEffect(() => {
        actions.current = handlers;
      });
      // The home composer remounts on every visit, as the workspace home does.
      return createElement(ProLaunchPanel, {
        key: visit,
        focusSignal: visit,
        onSessionCreated: () => {},
        promptSeed: seeds.seed,
        onPromptSeedConsumed: seeds.consume,
      });
    }
    const view = mount();
    await view.render(createElement(StrictMode, null, createElement(Shell)));
    await act(async () => actions.current!.send('Why is the sky blue?'));
    await wait();
    await act(async () => actions.current!.goHome());
    await wait();
    await act(async () => actions.current!.goHome());
    await wait();
    expect(creates).toBe(1);
  });

  it('never creates two sessions from two sends before a re-render', async () => {
    const view = mount();
    let seed: PromptSeed = { key: nextPromptSeedKey(), text: 'One', send: true };
    await view.render(
      createElement(ProLaunchPanel, { onSessionCreated: () => {}, promptSeed: seed }),
    );
    seed = { key: nextPromptSeedKey(), text: 'Two', send: true };
    await view.render(
      createElement(ProLaunchPanel, { onSessionCreated: () => {}, promptSeed: seed }),
    );
    expect(creates).toBe(1);
  });
});
