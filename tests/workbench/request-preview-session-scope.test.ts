// @vitest-environment jsdom
/**
 * Request and node keys come from a conversation's own event sequence, so
 * two conversations reuse them. What the preview remembers about a request
 * (the cast already revealed, a question handed back) belongs to one
 * conversation and must not carry into another with the same keys.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<typeof import('motion/react')>('motion/react');
  return { ...actual, AnimatePresence: ({ children }: { children: ReactNode }) => children };
});

import fixture from './fixtures/request-preview-roster-stream.json' with { type: 'json' };
import { WorkspaceRequestActivity } from '@/components/workbench/workspace/WorkspaceRequestActivity';
import {
  createInitialSessionState,
  foldEvent,
  useWorkbenchStore,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';
import { rosterRevealMs } from '@/lib/workbench/request-schedule';

type Frame = [number, string, unknown];
const frames = fixture as Frame[];
const firstPageAt = frames.find(
  ([, type, data]) =>
    type === 'tool_execution_start' &&
    (data as { toolName?: string }).toolName === 'generate_scene',
)![0];

function foldUntil(until: number): WorkbenchFold {
  let state: WorkbenchFold = createInitialSessionState();
  frames.forEach(([ts, type, data], index) => {
    if (ts <= until) state = foldEvent(state, { id: index + 1, ts, attempt: 1, type, data });
  });
  return state;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
  );
  Element.prototype.scrollIntoView = () => {};
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const scene = () =>
  container.querySelector('[data-testid="workspace-request-activity"]')?.getAttribute('data-scene');

describe('preview memory across conversations', () => {
  it("reveals the cast in a second conversation whose request key matches the first's", async () => {
    // Opened well after set_roster: the late viewer's reveal.
    const openedAt = firstPageAt + 20_000;
    vi.setSystemTime(openedAt);
    const fold = foldUntil(firstPageAt);
    const attach = (sessionId: string) =>
      act(async () => {
        useWorkbenchStore.setState({
          ...fold,
          sessionId,
          status: 'running',
          replaying: false,
        } as never);
      });
    await attach('session-a');
    await act(async () =>
      root.render(createElement(WorkspaceRequestActivity, { closedKey: null, onClose: () => {} })),
    );
    expect(scene()).toBe('assembling');
    await act(async () => vi.advanceTimersByTime(rosterRevealMs(3) + 2_000));
    expect(scene()).toBe('generating');

    // Another conversation, same event ids, so the same request key.
    await attach('session-b');
    await act(async () => vi.advanceTimersByTime(300));
    expect(scene()).toBe('assembling');
  });
});
