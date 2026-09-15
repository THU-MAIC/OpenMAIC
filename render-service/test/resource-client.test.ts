import { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourceClient } from '../src/resource-client.js';
import type { RenderExecutionRequest } from '../src/types.js';

function client() {
  const child = new ChildProcess();
  Object.defineProperty(child, 'connected', { value: true, writable: true });
  const sent: object[] = [];
  child.send = vi.fn((message: object) => {
    sent.push(message);
    return true;
  });
  child.disconnect = vi.fn(() => {
    Object.defineProperty(child, 'connected', { value: false });
  });
  const owner = new ResourceClient(child, 10);
  child.emit('message', { event: 'ready' });
  return { child, sent, owner };
}
function request(signal = new AbortController().signal): RenderExecutionRequest {
  return {
    projectDir: '/work/render-1',
    outputPath: '/work/render-1/output.mp4',
    options: { fps: 30, quality: 'standard', format: 'mp4' },
    signal,
    deadlineMs: 100,
    onProgress: vi.fn(),
  };
}
async function dispatched(sent: object[]) {
  await Promise.resolve();
  const value = sent.find((value) => 'event' in value && value.event === 'render');
  if (!value || !('id' in value)) throw new Error('No render dispatched');
  return value.id;
}
afterEach(() => vi.useRealTimers());

describe('dedicated Producer owner transport', () => {
  it('waits for cancellation cleanup and preserves exact failure accounting', async () => {
    const { child, sent, owner } = client();
    const abort = new AbortController();
    const promise = owner.execute(request(abort.signal));
    const id = await dispatched(sent);
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    abort.abort();
    await Promise.resolve();
    expect(sent).toContainEqual({ event: 'cancel', id });
    expect(resolved).toBe(false);
    const resources = {
      published: false,
      cleanupVerified: true,
      reservationReturned: true,
      admissionClosed: false,
      details: {
        residual: { memoryCurrent: '131072', cpuStat: 'usage_usec 4321' },
        cleanupVerified: true,
      },
    };
    child.emit('message', {
      event: 'result',
      id,
      result: {
        status: 'cancelled',
        failure: { code: 'cancelled', message: 'Render cancelled' },
        resources,
      },
    });
    expect(await promise).toMatchObject({ status: 'cancelled', resources });
    expect(owner.accepting()).toBe(true);
  });

  it('quarantines active work on owner exit instead of claiming resource return', async () => {
    const { child, sent, owner } = client();
    const promise = owner.execute(request());
    await dispatched(sent);
    child.emit('exit', 1);
    expect(await promise).toMatchObject({
      status: 'failed',
      resources: { cleanupVerified: false, reservationReturned: false, admissionClosed: true },
    });
    expect(owner.accepting()).toBe(false);
  });

  it('keeps a published artifact distinct from unreturned reservation', async () => {
    const { child, sent, owner } = client();
    const promise = owner.execute(request());
    const id = await dispatched(sent);
    child.emit('message', {
      event: 'result',
      id,
      result: {
        status: 'succeeded',
        resources: {
          published: true,
          cleanupVerified: false,
          reservationReturned: false,
          admissionClosed: true,
          details: { outputPath: '/work/render-1/output.mp4' },
        },
      },
    });
    expect(await promise).toMatchObject({
      status: 'succeeded',
      resources: { reservationReturned: false },
    });
    expect(owner.accepting()).toBe(false);
  });

  it('does not launch when pressure closes admission during progress publication', async () => {
    const { child, sent, owner } = client();
    const value = request();
    value.onProgress = () => {
      child.emit('message', { event: 'closed' });
    };
    expect(await owner.execute(value)).toMatchObject({ status: 'failed' });
    expect(sent).toHaveLength(0);
  });

  it('does not silently fall back to a chunk executor', async () => {
    const { owner, sent } = client();
    expect(await owner.execute({ ...request(), chunkExecution: { chunkCount: 2 } })).toMatchObject({
      status: 'failed',
    });
    expect(sent).toHaveLength(0);
  });

  it('marks transport deadline as unverified cleanup and disconnects the lifeline', async () => {
    vi.useFakeTimers();
    const { child, sent, owner } = client();
    const promise = owner.execute(request());
    await dispatched(sent);
    await vi.advanceTimersByTimeAsync(5120);
    expect(await promise).toMatchObject({ resources: { reservationReturned: false } });
    expect(child.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects missing settlement evidence', async () => {
    const { child, sent, owner } = client();
    const promise = owner.execute(request());
    const id = await dispatched(sent);
    child.emit('message', { event: 'result', id, result: { status: 'succeeded' } });
    expect(await promise).toMatchObject({
      status: 'failed',
      resources: { reservationReturned: false },
    });
  });

  it('does not report owner exit 1 as clean shutdown', async () => {
    const { child, owner } = client();
    const closing = owner.close();
    child.emit('exit', 1);
    await expect(closing).rejects.toThrow('did not exit cleanly');
  });
});

it('does not let duplicate readiness reopen closed admission', async () => {
  const { child, owner } = client();
  child.emit('message', { event: 'closed' });
  child.emit('message', { event: 'ready' });
  expect(owner.accepting()).toBe(false);
});

it('keeps cleanup unverified when dispatch throws synchronously', async () => {
  const { child, owner } = client();
  child.send = vi.fn(() => {
    throw new Error('IPC closed');
  });
  expect(await owner.execute(request())).toMatchObject({
    status: 'failed',
    resources: { published: 'unknown', cleanupVerified: false, reservationReturned: false },
  });
});
