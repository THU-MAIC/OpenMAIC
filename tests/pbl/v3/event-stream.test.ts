import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  roles: vi.fn(),
  view: vi.fn(),
  work: vi.fn(),
  subscriptions: new Map<string, () => void>(),
}));
vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  subscribeAgentEventWakeup: (_route: { sessionId: string }, wake: () => void) => {
    mocks.subscriptions.set(_route.sessionId, wake);
    return () => mocks.subscriptions.delete(_route.sessionId);
  },
}));
vi.mock('@/lib/server/pbl-v3/store', () => ({
  LearningStore: { open: async () => ({ get: mocks.get, roles: mocks.roles }) },
}));
vi.mock('@/lib/server/pbl-v3/runtime', () => ({ learningView: mocks.view }));
vi.mock('@/lib/server/pbl-v3/workbench', () => ({ workbenchView: mocks.work }));
import { learningEventResponse } from '@/lib/server/pbl-v3/event-stream';
import { openRunStreamsOf } from '@/lib/server/generation/run/sse';
import { SandboxError } from '@/lib/sandbox/errors';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
const principal = { ownerId: 'stream-learner' } as OwnerPrincipal;
const row = { revision: 1, environment_id: 'env', evaluation: null as object | null };
const view = {
  id: 'study',
  revision: 1,
  environmentId: 'env',
  environment: { ready: true },
  files: ['PLAN.md'],
  busy: false,
  activitySequence: 1,
};
const work = { revision: 1, environmentId: 'env', commands: [], canEdit: false };
const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
async function attach() {
  const response = await learningEventResponse(principal, 'study', new AbortController().signal);
  const reader = response.body!.getReader();
  streams.push(reader);
  return { response, reader };
}
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  return new TextDecoder().decode((await reader.read()).value);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.subscriptions.clear();
  row.revision = 1;
  row.evaluation = null;
  mocks.get.mockResolvedValue(row);
  mocks.roles.mockResolvedValue([{ session_id: 'role-one' }]);
  mocks.view.mockResolvedValue(view);
  mocks.work.mockResolvedValue(work);
});
afterEach(async () => {
  for (const reader of streams.splice(0)) await reader.cancel();
  await settle();
  expect(mocks.subscriptions.size).toBe(0);
  expect(openRunStreamsOf(principal.ownerId)).toBe(0);
  vi.useRealTimers();
});
describe('V3 learning SSE projection', () => {
  it('refuses an unowned study before opening any stream or reading its roles', async () => {
    mocks.get.mockRejectedValueOnce(new SandboxError('PBL_NOT_FOUND', 404, 'Unavailable'));
    await expect(attach()).rejects.toMatchObject({ status: 404 });
    expect(mocks.roles).not.toHaveBeenCalled();
    expect(mocks.subscriptions.size).toBe(0);
  });
  it('sends a passive replacement on attach, then pushes role events without re-observing the provider', async () => {
    const { response, reader } = await attach();
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await frame(reader)).toContain('"activitySequence":1');
    expect(mocks.view).toHaveBeenLastCalledWith(principal, 'study', {
      passive: true,
      checkHealth: true,
    });
    mocks.view.mockResolvedValue({ ...view, activitySequence: 2 });
    mocks.subscriptions.get('role-one')!();
    await settle();
    expect(await frame(reader)).toContain('"activitySequence":2');
    expect(mocks.view).toHaveBeenLastCalledWith(principal, 'study', {
      passive: true,
      checkHealth: false,
      observation: view,
    });
    expect(mocks.work).toHaveBeenCalledTimes(1);
    expect(mocks.work).toHaveBeenLastCalledWith(principal, 'study', { passive: true });
  });
  it('refreshes the workspace epoch after a study notification even when learning revision is unchanged', async () => {
    const { reader } = await attach();
    await frame(reader);
    mocks.work.mockResolvedValue({ ...work, epoch: 7 });
    mocks.subscriptions.get('study')!();
    await settle();
    expect(await frame(reader)).toContain('"epoch":7');
    expect(mocks.work).toHaveBeenCalledTimes(2);
  });
  it('subscribes to a newly created role before reading its opening', async () => {
    const { reader } = await attach();
    await frame(reader);
    row.revision = 2;
    mocks.roles.mockResolvedValue([{ session_id: 'role-two' }]);
    mocks.view.mockResolvedValue({ ...view, revision: 2, needsOpening: true });
    mocks.subscriptions.get('study')!();
    await settle();
    expect(mocks.subscriptions.has('role-two')).toBe(true);
    expect(mocks.subscriptions.has('role-one')).toBe(false);
    expect(await frame(reader)).toContain('"needsOpening":true');
  });
  it('shortens idle observation when a test starts and pushes completion without another notification', async () => {
    const { reader } = await attach();
    await frame(reader);
    row.revision = 2;
    row.evaluation = { id: 'test' };
    mocks.view.mockResolvedValue({ ...view, revision: 2, evaluation: { state: 'running' } });
    mocks.subscriptions.get('study')!();
    await settle();
    await frame(reader);
    mocks.view.mockResolvedValue({ ...view, revision: 2, evaluation: { state: 'exited' } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await frame(reader)).toContain('"state":"exited"');
  });
  it('repairs a missed notification on idle reconciliation and stops on disconnect', async () => {
    const { reader } = await attach();
    await frame(reader);
    mocks.view.mockResolvedValue({ ...view, activitySequence: 5 });
    await vi.advanceTimersByTimeAsync(25_000);
    // A heartbeat can precede the replacement snapshot.
    let text = await frame(reader);
    if (!text.includes('event: learning')) text += await frame(reader);
    expect(text).toContain('"activitySequence":5');
    await reader.cancel();
    streams.pop();
    const calls = mocks.view.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.view).toHaveBeenCalledTimes(calls);
  });
  it('serializes wakeups while a read is slow and releases subscriptions on abort', async () => {
    const controller = new AbortController();
    const response = await learningEventResponse(principal, 'study', controller.signal);
    const reader = response.body!.getReader();
    streams.push(reader);
    await frame(reader);
    let finish!: (value: typeof view) => void;
    mocks.view.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.subscriptions.get('role-one')!();
    await settle();
    for (let i = 0; i < 50; i++) mocks.subscriptions.get('role-one')!();
    await settle();
    expect(mocks.view).toHaveBeenCalledTimes(2);
    finish({ ...view, activitySequence: 3 });
    await settle();
    expect(mocks.view).toHaveBeenCalledTimes(3);
    controller.abort();
    await settle();
    expect(mocks.subscriptions.size).toBe(0);
  });
  it('ends with sanitized recovery feedback after a projection failure', async () => {
    const { reader } = await attach();
    await frame(reader);
    mocks.view.mockRejectedValueOnce(new Error('secret provider endpoint'));
    mocks.subscriptions.get('role-one')!();
    await settle();
    const text = await frame(reader);
    expect(text).toContain('event: retry');
    expect(text).not.toContain('secret');
    expect((await reader.read()).done).toBe(true);
  });
});
