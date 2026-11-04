import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import {
  startTeachingExecutionWatchdog,
  PBL_EXECUTION_IDLE_MS,
} from '@/lib/server/pbl-v3/execution-watchdog';
import { abortable } from '@/lib/server/agent-runtime/abortable';
import {
  withLearningWorkspaceAccess,
  assertWorkspaceMutation,
} from '@/lib/server/sandbox/managed-workspace';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('runs independently of Agent admission and provider reconciliation, without overlapping scans', async () => {
  vi.useFakeTimers();
  vi.stubEnv('DATABASE_URL', 'fixture');
  vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'false');
  let release!: () => void;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const schedule = startTeachingExecutionWatchdog(run)!;
  expect(startTeachingExecutionWatchdog(run)).toBe(schedule);
  expect(PBL_EXECUTION_IDLE_MS).toBe(900000);
  await vi.advanceTimersByTimeAsync(120000);
  expect(run).toHaveBeenCalledTimes(1);
  release();
  await schedule.runNow();
  await vi.advanceTimersByTimeAsync(30000);
  expect(run).toHaveBeenCalledTimes(2);
  const stopped = schedule.stop();
  release();
  await stopped;
  await vi.advanceTimersByTimeAsync(60000);
  expect(run).toHaveBeenCalledTimes(2);
});

it('settles an aborted await even when the underlying operation ignores abort and rejects late', async () => {
  const controller = new AbortController();
  let reject!: (error: Error) => void;
  const pending = abortable(
    new Promise<void>((_resolve, no) => {
      reject = no;
    }),
    controller.signal,
  );
  controller.abort(new Error('claim revoked'));
  await expect(pending).rejects.toThrow('claim revoked');
  reject(new Error('late failure'));
  await Promise.resolve();
});

it('closes the workspace mutation scope on abort before an uncooperative operation returns', async () => {
  const controller = new AbortController();
  let release!: () => void;
  let late!: Promise<void>;
  const workspaceId = 'pbl-00000000-0000-0000-0000-000000000000';
  const run = withLearningWorkspaceAccess(
    {
      ownerId: 'owner',
      workspaceId,
      environmentIds: () => ['environment'],
      operations: ['write'],
      signal: controller.signal,
    },
    async () => {
      assertWorkspaceMutation('owner', workspaceId, 'environment', 'write');
      late = new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        assertWorkspaceMutation('owner', workspaceId, 'environment', 'write');
      });
      return late;
    },
  );
  controller.abort(new Error('claim revoked'));
  await expect(run).rejects.toThrow('claim revoked');
  release();
  await expect(late).rejects.toThrow('managed by a learning project');
});
