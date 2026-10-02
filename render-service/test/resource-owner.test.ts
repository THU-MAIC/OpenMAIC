import { statSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createResourceHandler } from '../src/resource-owner.mjs';
import { assertCanonicalProjectRoot } from '../src/resource-settings.mjs';

const roots: string[] = [];
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const succeeded = {
  status: 'succeeded',
  published: true,
  cleanupVerified: true,
  reservationReturned: true,
  admissionClosed: false,
  details: { cgroupRemoved: true },
};

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resource-owner-')));
  roots.push(root);
  const projectDir = join(root, 'render-1');
  mkdirSync(projectDir);
  const taskRunner = vi.fn(async () => succeeded);
  const send = vi.fn();
  const close = vi.fn();
  const handle = createResourceHandler({
    taskRunner,
    settings: {
      projectRoot: root,
      owner: { workerUid: process.getuid?.() },
      task: { cpuMillis: 1000, memoryBytes: 805306368 },
    },
    send,
    close,
  });
  const request = {
    event: 'render',
    id: 'one',
    projectDir,
    outputPath: join(projectDir, 'output.mp4'),
    options: { fps: 30, quality: 'standard', format: 'mp4' },
    timeoutMs: 5000,
    deadlineNs: String(process.hrtime.bigint() + 5_000_000_000n),
  };
  return { handle, taskRunner, send, close, request };
}

it('ignores cancellation arriving after settlement and reuses the same owner', async () => {
  const { handle, request, taskRunner, close } = fixture();
  await handle(request);
  await handle({ event: 'cancel', id: request.id });
  await handle({ ...request, id: 'two' });
  expect(close).not.toHaveBeenCalled();
  expect(taskRunner).toHaveBeenCalledTimes(2);
});

it('does not turn an expired IPC deadline into a new full task deadline', async () => {
  const { handle, request, taskRunner, send } = fixture();
  await handle({ ...request, deadlineNs: '1' });
  expect(taskRunner).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'result',
      result: expect.objectContaining({
        status: 'failed',
        failure: expect.objectContaining({ code: 'deadline_exceeded' }),
        resources: expect.objectContaining({
          cleanupVerified: true,
          reservationReturned: true,
          details: { notAdmitted: true },
        }),
      }),
    }),
  );
});

it('subtracts transport time before invoking the outer task runner', async () => {
  const { handle, request, taskRunner } = fixture();
  await handle({ ...request, deadlineNs: String(process.hrtime.bigint() + 1_000_000_000n) });
  const taskRequest = taskRunner.mock.calls[0]?.[1];
  expect(taskRequest.timeoutMs).toBeGreaterThan(0);
  expect(taskRequest.timeoutMs).toBeLessThanOrEqual(1000);
});

it('keeps publication and reservation settlement independent', async () => {
  const { handle, request, taskRunner, send } = fixture();
  const details = { publishFailure: 'rename failed after cleanup' };
  taskRunner.mockResolvedValueOnce({
    status: 'failed',
    failureCode: 'execution_failed',
    published: false,
    cleanupVerified: true,
    reservationReturned: true,
    admissionClosed: false,
    details,
  });
  await handle(request);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      result: expect.objectContaining({
        status: 'failed',
        resources: {
          published: false,
          cleanupVerified: true,
          reservationReturned: true,
          admissionClosed: false,
          details,
        },
      }),
    }),
  );
});

it('forwards only the bounded startup diagnostic code alongside private details', async () => {
  const { handle, request, taskRunner, send } = fixture();
  taskRunner.mockResolvedValueOnce({
    status: 'failed',
    failureCode: 'execution_failed',
    published: false,
    cleanupVerified: false,
    reservationReturned: false,
    admissionClosed: true,
    diagnosticCode: 'main_pid_read_error',
    details: { diagnostic: { error: '/proc/42/cgroup: permission denied' } },
  });
  await handle(request);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      result: expect.objectContaining({
        resources: expect.objectContaining({ diagnosticCode: 'main_pid_read_error' }),
      }),
    }),
  );
});

it('forwards cancellation to the active outer task and preserves confirmed cleanup', async () => {
  const { handle, request, taskRunner, send } = fixture();
  taskRunner.mockImplementationOnce(
    async (_settings, _taskRequest, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () =>
            resolve({
              status: 'cancelled',
              failureCode: 'cancelled',
              published: false,
              cleanupVerified: true,
              reservationReturned: true,
              admissionClosed: false,
              details: { platformCleanup: true },
            }),
          { once: true },
        );
      }),
  );
  const pending = handle(request);
  await handle({ event: 'cancel', id: request.id });
  await pending;
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      result: expect.objectContaining({
        status: 'cancelled',
        resources: expect.objectContaining({ reservationReturned: true }),
      }),
    }),
  );
});

it('fails closed for an invoked owner error without inventing cleanup evidence', async () => {
  const { handle, request, taskRunner, send } = fixture();
  taskRunner.mockRejectedValueOnce(new TypeError('unexpected owner error'));
  await handle(request);
  expect(handle.accepting()).toBe(false);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      result: expect.objectContaining({
        status: 'failed',
        resources: expect.objectContaining({
          cleanupVerified: false,
          reservationReturned: false,
          admissionClosed: true,
          details: { unexpectedOwnerFailure: true },
        }),
      }),
    }),
  );
});

it('rejects a pressure-raced request without invoking the task or inventing cleanup work', async () => {
  const { request, taskRunner, send, close } = fixture();
  const root = dirname(request.projectDir);
  const handle = createResourceHandler({
    taskRunner,
    settings: {
      projectRoot: root,
      owner: { workerUid: process.getuid?.() },
      task: { cpuMillis: 1000, memoryBytes: 805306368 },
    },
    send,
    close,
    admissionGuard: () => false,
  });
  await handle(request);
  expect(taskRunner).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(handle.accepting()).toBe(false);
  expect(send).toHaveBeenCalledWith({ event: 'closed' });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'result',
      result: expect.objectContaining({
        status: 'failed',
        resources: expect.objectContaining({
          cleanupVerified: true,
          reservationReturned: true,
          admissionClosed: true,
          details: { notAdmitted: true },
        }),
      }),
    }),
  );
});

it('closes admission after an active task settles without changing its cleanup result', async () => {
  const { handle: unused, request, taskRunner, send, close } = fixture();
  void unused;
  const root = dirname(request.projectDir);
  const admissionGuard = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
  const handle = createResourceHandler({
    taskRunner,
    settings: {
      projectRoot: root,
      owner: { workerUid: process.getuid?.() },
      task: { cpuMillis: 1000, memoryBytes: 805306368 },
    },
    send,
    close,
    admissionGuard,
  });
  await handle(request);
  expect(handle.accepting()).toBe(false);
  expect(send).toHaveBeenCalledWith({ event: 'closed' });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'result',
      result: expect.objectContaining({
        status: 'succeeded',
        resources: expect.objectContaining({
          cleanupVerified: true,
          reservationReturned: true,
          admissionClosed: true,
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

it('keeps internal owner errors out of normal IPC failure messages', async () => {
  const { handle, request, taskRunner, send } = fixture();
  const error = new Error('system.slice/private-session diagnostics');
  taskRunner.mockRejectedValueOnce(error);
  await handle(request);
  const result = send.mock.calls.find(([message]) => message.event === 'result')![0].result;
  expect(result.failure).toEqual({
    code: 'execution_failed',
    message: 'Resource render failed; see service logs',
  });
  expect(result.failure.message).not.toContain('private-session');
  expect(console.error).toHaveBeenCalledWith('Resource render failed:', error);
});

it('binds the task request to the owner-observed directory identity, ignoring IPC identity', async () => {
  const { handle, request, taskRunner } = fixture();
  const actual = statSync(request.projectDir);
  await handle({ ...request, projectIdentity: { dev: -1, ino: -1 } });
  expect(taskRunner.mock.calls[0]?.[1]).toMatchObject({
    projectIdentity: { dev: actual.dev, ino: actual.ino },
  });
});
