// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchOnboarding } from '@/components/scene-renderers/pbl/v3/use-workbench-onboarding';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, container: HTMLDivElement, root: Root;
let owner: { current: HTMLElement | null };
let guide: ReturnType<typeof useWorkbenchOnboarding>;
let frames: Map<number, FrameRequestCallback>;
let sequence = 0;
type EntryProps = { ready?: boolean; available?: boolean; blocked?: boolean; hasDraft?: boolean };
function Harness({
  ready = false,
  available = ready,
  blocked = false,
  hasDraft = false,
}: EntryProps) {
  const current = useWorkbenchOnboarding({
    root: owner,
    studyId: 'entry-study',
    autoStart: true,
    ready,
    available,
    blocked,
    hasDraft,
  });
  useEffect(() => {
    guide = current;
  });
  return null;
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => root.render(createElement(Harness, props)));
}
async function settle() {
  for (let tick = 0; tick < 2; tick++) {
    const batch = [...frames.entries()];
    frames.clear();
    await act(async () => {
      for (const [, callback] of batch) callback(tick * 16);
    });
  }
}
beforeEach(() => {
  host = document.createElement('div');
  host.innerHTML = '<button>Layout</button><textarea></textarea>';
  document.body.append(host);
  owner = { current: host };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++sequence;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  window.localStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  container.remove();
  vi.unstubAllGlobals();
});

it('waits for readiness without treating loading-time layout clicks as learner work', async () => {
  await render();
  await act(async () => {
    host.querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    host
      .querySelector('button')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    guide.replay();
  });
  await settle();
  expect(guide.active).toBe(false);
  await render({ ready: true });
  await settle();
  expect(guide.active).toBe(true);
});

it('retains actual input intent during connection and allows an explicit replay afterward', async () => {
  await render();
  await act(async () =>
    host.querySelector('textarea')!.dispatchEvent(new Event('input', { bubbles: true })),
  );
  await render({ ready: true });
  await settle();
  expect(guide.active).toBe(false);
  await act(async () => guide.replay());
  expect(guide.active).toBe(true);
});

it('does not take focus from a recovered draft even if it is cleared before readiness', async () => {
  await render({ hasDraft: true });
  await render({ ready: true });
  await settle();
  expect(guide.active).toBe(false);
  await act(async () => guide.replay());
  expect(guide.active).toBe(true);
});

it('closes on lost readiness and does not reopen on reconnection', async () => {
  await render({ ready: true });
  await settle();
  expect(guide.active).toBe(true);
  await render();
  expect(guide.active).toBe(false);
  await render({ ready: true });
  await settle();
  expect(guide.active).toBe(false);
  await act(async () => guide.replay());
  expect(guide.active).toBe(true);
});

it('keeps an open guide while ordinary metadata temporarily lags the learning view', async () => {
  await render({ ready: true });
  await settle();
  expect(guide.active).toBe(true);
  await render({ ready: false, available: true });
  expect(guide.active).toBe(true);
  await render({ ready: true });
  await settle();
  expect(guide.active).toBe(true);
});

it('lets an actionable failure take precedence before and after automatic entry', async () => {
  await render({ ready: true, blocked: true });
  await settle();
  expect(guide.active).toBe(false);
  await render({ ready: true });
  await settle();
  expect(guide.active).toBe(false);
  await act(async () => guide.replay());
  expect(guide.active).toBe(true);
  await render({ ready: true, blocked: true });
  expect(guide.active).toBe(false);
  await render({ ready: true });
  await settle();
  expect(guide.active).toBe(false);
});

it('hands entry loading directly to the guide without an animation-frame input gap', async () => {
  await render();
  await render({ ready: true });
  // No animation frame runs between readiness and taking modal ownership.
  expect(guide.active).toBe(true);
  expect(frames.size).toBe(0);
});
