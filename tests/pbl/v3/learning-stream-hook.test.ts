// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/pbl/v3/event-stream', async (original) => ({
  ...(await original<typeof import('@/lib/pbl/v3/event-stream')>()),
  readLearningStream: mocks.read,
}));
import { useLearningStream } from '@/components/scene-renderers/pbl/v3/use-learning-stream';
import { LearningStreamError } from '@/lib/pbl/v3/event-stream';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement;
let current: ReturnType<typeof useLearningStream>;
const receive = vi.fn();
function Hook({ id }: { id: string }) {
  const value = useLearningStream(id, receive);
  useEffect(() => {
    current = value;
  });
  return null;
}
async function mount(id = 'one') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Hook, { id })));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('learning subscription lifecycle', () => {
  it('holds one stream while idle instead of issuing timed JSON refreshes, then aborts on unmount', async () => {
    mocks.read.mockImplementation(() => new Promise(() => {}));
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.read).toHaveBeenCalledTimes(1);
    const signal = mocks.read.mock.calls[0]![1] as AbortSignal;
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);
  });
  it('reconnects after EOF with a replacement subscription, backs off failures, and accepts snapshots', async () => {
    mocks.read.mockResolvedValue(undefined);
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(mocks.read).toHaveBeenCalledTimes(2);
    mocks.read.mockImplementation((_id, _signal, callback) => {
      callback({ view: { id: 'one', revision: 2 }, workbench: null });
      return new Promise(() => {});
    });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(current.status).toBe('connected');
    expect(receive).toHaveBeenCalledWith({ view: { id: 'one', revision: 2 }, workbench: null });
  });
  it('aborts a replaced study and pauses while hidden, reconnecting when visible', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    mocks.read.mockImplementation(() => new Promise(() => {}));
    await mount();
    const old = mocks.read.mock.calls[0]![1] as AbortSignal;
    await act(async () => root.render(createElement(Hook, { id: 'two' })));
    expect(old.aborted).toBe(true);
    const active = mocks.read.mock.calls[1]![1] as AbortSignal;
    visibility = 'hidden';
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(active.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.read).toHaveBeenCalledTimes(2);
    visibility = 'visible';
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.read.mock.calls[2]![0]).toBe('two');
  });
  it('does not endlessly retry a permanent ownership refusal; manual refresh can reconnect', async () => {
    mocks.read.mockRejectedValue(new LearningStreamError(404));
    await mount();
    expect(current.status).toBe('unavailable');
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.read).toHaveBeenCalledTimes(1);
    await act(async () => current.reconnect());
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
});
