import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createResourceHandler } from '../src/resource-owner.mjs';
const roots: string[] = [];
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
