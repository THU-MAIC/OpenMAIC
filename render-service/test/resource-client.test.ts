import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const cleanResult = {
  status: 'succeeded',
  resources: {
    published: true,
    cleanupVerified: true,
    reservationReturned: true,
    admissionClosed: false,
    details: {},
  },
};
it('allows only one dispatch across interleaved progress callbacks', async () => {
  const { owner, child, sent } = client();
  let resume!: () => void;
  const first = owner.execute({
    ...request(),
    onProgress: () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  });
  const second = owner.execute(request());
  const id = await dispatched(sent);
  resume();
  expect(await first).toMatchObject({ status: 'failed' });
  expect(sent).toHaveLength(1);
  child.emit('message', { event: 'result', id, result: cleanResult });
  await expect(second).resolves.toMatchObject({ status: 'succeeded' });
});
it('rejects a wrong result ID and does not settle the active request as successful', async () => {
  const { owner, child, sent } = client();
  const pending = owner.execute(request());
  await dispatched(sent);
  child.emit('message', { event: 'result', id: 'wrong', result: cleanResult });
  expect(await pending).toMatchObject({ resources: { reservationReturned: false } });
  expect(owner.accepting()).toBe(false);
});
it('a duplicate old result fails closed without settling a newer task successfully', async () => {
  const { owner, child, sent } = client();
  const first = owner.execute(request());
  const id = await dispatched(sent);
  child.emit('message', { event: 'result', id, result: cleanResult });
  await first;
  sent.length = 0;
  const second = owner.execute(request());
  await dispatched(sent);
  child.emit('message', { event: 'result', id, result: cleanResult });
  expect(await second).toMatchObject({ resources: { reservationReturned: false } });
});
it('removes cancellation ownership when the result finishes and reuses the slot', async () => {
  const { owner, child, sent } = client();
  const abort = new AbortController();
  const first = owner.execute(request(abort.signal));
  const id = await dispatched(sent);
  child.emit('message', { event: 'result', id, result: cleanResult });
  await first;
  abort.abort();
  expect(sent).toHaveLength(1);
  sent.length = 0;
  const next = owner.execute(request());
  const nextId = await dispatched(sent);
  child.emit('message', { event: 'result', id: nextId, result: cleanResult });
  await expect(next).resolves.toMatchObject({ status: 'succeeded' });
});
it('a result alone closes admission before completing an unknown failure', async () => {
  const { owner, child, sent } = client();
  const pending = owner.execute(request());
  const id = await dispatched(sent);
  child.emit('message', {
    event: 'result',
    id,
    result: {
      status: 'failed',
      failure: { code: 'execution_failed', message: 'Resource render failed; see service logs' },
      resources: {
        published: false,
        cleanupVerified: false,
        reservationReturned: false,
        admissionClosed: true,
        details: { unexpectedFailure: true },
      },
    },
  });
  expect(owner.accepting()).toBe(false);
  await expect(pending).resolves.toMatchObject({ status: 'failed' });
  child.emit('message', { event: 'ready' });
  expect(owner.accepting()).toBe(false);
});

it.each(['startup', 'after-disconnect'])(
  'inherited service stderr preserves %s diagnostics outside public errors',
  async (stage) => {
    const dir = mkdtempSync(join(tmpdir(), 'resource-stderr-'));
    const fixture = join(dir, 'owner.mjs');
    const diagnostic = 'private /root/late-owner-diagnostic';
    writeFileSync(
      fixture,
      stage === 'startup'
        ? `console.error(${JSON.stringify(diagnostic)}); process.exit(1);`
        : `process.on('message', () => { process.disconnect(); setTimeout(() => { console.error(${JSON.stringify(diagnostic)}); process.exit(1); }, 25); }); process.send({event:'ready'});`,
    );
    const script = `
    import { fork } from 'node:child_process';
    import { ResourceClient } from ${JSON.stringify(new URL('../src/resource-client.ts', import.meta.url).href)};
    const child = fork(${JSON.stringify(fixture)}, [], {stdio:['ignore','inherit','inherit','ipc'], execArgv:[]});
    const closed = new Promise(resolve => child.once('close', resolve));
    const owner = new ResourceClient(child, 10);
    try {
      await owner.ready;
      const result = await owner.execute({projectDir:'/work/render',outputPath:'/work/render/output.mp4',options:{fps:30,quality:'standard',format:'mp4'},signal:new AbortController().signal,deadlineMs:1000,onProgress:()=>{}});
      console.log(JSON.stringify(result));
    } catch (error) { console.log(JSON.stringify({startupError:error.message})); }
    await closed;
  `;
    try {
      const processResult = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const process = spawn(
          globalThis.process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script],
          { timeout: 10000 },
        );
        let stdout = '';
        let stderr = '';
        process.stdout.on('data', (bytes) => {
          stdout += bytes;
        });
        process.stderr.on('data', (bytes) => {
          stderr += bytes;
        });
        process.once('error', reject);
        process.once('close', (code) => resolve({ code, stdout, stderr }));
      });
      expect(processResult.code).toBe(0);
      expect(processResult.stderr).toContain(diagnostic);
      expect(processResult.stdout).not.toContain(diagnostic);
      const result = JSON.parse(processResult.stdout);
      if (stage === 'startup') expect(result.startupError).toMatch(/before ready/);
      else
        expect(result).toMatchObject({
          resources: { published: 'unknown', cleanupVerified: false, reservationReturned: false },
        });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
