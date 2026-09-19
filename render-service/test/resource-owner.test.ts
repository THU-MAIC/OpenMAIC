import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createResourceHandler } from '../src/resource-owner.mjs';
import { assertCanonicalProjectRoot } from '../src/resource-settings.mjs';
const roots: string[] = [];
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
class BudgetedRenderError extends Error {
  constructor(readonly settlement: object) {
    super('cancelled with cleanup');
  }
}
function handler() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resource-owner-')));
  roots.push(root);
  const projectDir = join(root, 'render-1');
  mkdirSync(projectDir);
  const render = vi.fn(async (_request, _budget, _run) => ({
    reservationReturned: true,
    residual: { cpuStat: 'usage_usec 1' },
  }));
  const send = vi.fn();
  const close = vi.fn();
  const handle = createResourceHandler({
    producer: { render, status: () => ({ closed: false }) },
    settings: {
      projectRoot: root,
      owner: { workerUid: process.getuid?.() },
      task: { cpuMillis: 1000, memoryBytes: 805306368 },
    },
    createRenderRequest: (value) => value,
    BudgetedRenderError,
    send,
    close,
  });
  const request = {
    event: 'render',
    id: 'one',
    projectDir,
    outputPath: join(projectDir, 'output.mp4'),
    options: { fps: 30, quality: 'standard' },
    timeoutMs: 5000,
    deadlineNs: String(process.hrtime.bigint() + 5_000_000_000n),
  };
  return { handle, render, send, close, request };
}
it('ignores cancellation arriving after the result and reuses the same owner', async () => {
  const { handle, request, render, close } = handler();
  await handle(request);
  await handle({ event: 'cancel', id: request.id });
  await handle({ ...request, id: 'two' });
  expect(close).not.toHaveBeenCalled();
  expect(render).toHaveBeenCalledTimes(2);
});
it('does not turn an expired IPC deadline into a new full task deadline', async () => {
  const { handle, request, render, send } = handler();
  await handle({ ...request, deadlineNs: '1' });
  expect(render).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'result',
      result: expect.objectContaining({
        status: 'failed',
        failure: expect.objectContaining({ code: 'deadline_exceeded' }),
        resources: expect.objectContaining({
          reservationReturned: true,
          details: {
            published: false,
            cleanupVerified: true,
            reservationReturned: true,
            notAdmitted: true,
          },
        }),
      }),
    }),
  );
});
it('subtracts transport time before invoking the original Producer API', async () => {
  const { handle, request, render } = handler();
  await handle({ ...request, deadlineNs: String(process.hrtime.bigint() + 1_000_000_000n) });
  const run = render.mock.calls[0]?.[2];
  expect(run.timeoutMs).toBeGreaterThan(0);
  expect(run.timeoutMs).toBeLessThanOrEqual(1000);
});
it('preserves deadline classification and settlement when the worker error contains only logs', async () => {
  const { handle, request, render, send } = handler();
  const details = {
    published: false,
    cleanupVerified: true,
    reservationReturned: true,
    residual: { memoryCurrent: '123' },
  };
  const clock = vi.spyOn(process.hrtime, 'bigint').mockReturnValue(1_000_000_000n);
  try {
    render.mockImplementationOnce(async () => {
      clock.mockReturnValue(3_000_000_000n);
      const error = new BudgetedRenderError(details);
      error.message = '[INFO] encoding frames';
      throw error;
    });
    await handle({ ...request, deadlineNs: '2000000000' });
    expect(render).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'result',
        result: expect.objectContaining({
          status: 'failed',
          failure: { code: 'deadline_exceeded', message: 'Render exceeded the deadline' },
          resources: expect.objectContaining({ reservationReturned: true, details }),
        }),
      }),
    );
  } finally {
    clock.mockRestore();
  }
});
it('forwards cancellation to the active original Producer and preserves failed settlement', async () => {
  const { handle, request, render, send } = handler();
  const details = {
    published: false,
    cleanupVerified: true,
    reservationReturned: true,
    residual: { cpuStat: 'usage_usec 44', memoryCurrent: '123' },
  };
  render.mockImplementationOnce(
    async (_request, _budget, run) =>
      new Promise((_resolve, reject) => {
        run.signal.addEventListener('abort', () => reject(new BudgetedRenderError(details)), {
          once: true,
        });
      }),
  );
  const pending = handle(request);
  await handle({ event: 'cancel', id: request.id });
  await pending;
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'result',
      result: expect.objectContaining({
        status: 'cancelled',
        resources: expect.objectContaining({ reservationReturned: true, details }),
      }),
    }),
  );
});

it('fails closed for an invoked Producer error without inventing settlement evidence', async () => {
  const { handle, request, render, send } = handler();
  render.mockRejectedValueOnce(new TypeError('unexpected producer error'));
  await handle(request);
  expect(send).not.toHaveBeenCalledWith({ event: 'closed' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'result',
      result: expect.objectContaining({
        status: 'failed',
        resources: expect.objectContaining({
          cleanupVerified: false,
          reservationReturned: false,
          admissionClosed: true,
          details: { unexpectedFailure: true },
        }),
      }),
    }),
  );
});

it('rejects an actual symlinked ancestor before accepting the configured project root', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resource-root-')));
  roots.push(root);
  mkdirSync(join(root, 'real/projects'), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'alias'));
  expect(() => assertCanonicalProjectRoot(join(root, 'alias/projects'))).toThrow('canonical');
  expect(() => assertCanonicalProjectRoot(join(root, 'real/projects'))).not.toThrow();
});

it.each(['settled', 'unexpected'])(
  'keeps %s internal errors out of normal IPC failure messages',
  async (kind) => {
    const { handle, request, render, send } = handler();
    const error =
      kind === 'settled'
        ? new BudgetedRenderError({
            published: false,
            cleanupVerified: true,
            reservationReturned: true,
          })
        : new Error();
    error.message = 'guardian /sys/fs/cgroup/private-session diagnostics';
    render.mockRejectedValueOnce(error);
    await handle(request);
    const result = send.mock.calls.find(([message]) => message.event === 'result')![0].result;
    expect(result.failure).toEqual({
      code: 'execution_failed',
      message: 'Resource render failed; see service logs',
    });
    expect(result.failure.message).not.toContain('private-session');
    expect(console.error).toHaveBeenCalledWith('Resource render failed:', error);
  },
);
