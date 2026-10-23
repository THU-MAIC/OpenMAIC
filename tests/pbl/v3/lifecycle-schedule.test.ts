import { afterEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/pbl-v3/lifecycle', () => ({ maintainLearningEnvironments: vi.fn() }));
import { startLearningLifecycle } from '@/lib/server/pbl-v3/lifecycle-schedule';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('skips duplicate schedules and overlapping scans, and drains on shutdown', async () => {
  vi.useFakeTimers();
  vi.stubEnv('DATABASE_URL', 'fixture');
  let finish!: () => void;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const schedule = startLearningLifecycle(run)!;
  expect(startLearningLifecycle(run)).toBe(schedule);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(run).toHaveBeenCalledTimes(1);
  const stop = schedule.stop();
  finish();
  await stop;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(1);
});

it('has one bounded, configurable inactivity threshold', async () => {
  vi.stubEnv('DATABASE_URL', 'fixture');
  vi.stubEnv('OPENMAIC_PBL_IDLE_TIMEOUT_MS', '0');
  expect(() => startLearningLifecycle(async () => {})).toThrow('OPENMAIC_PBL_IDLE_TIMEOUT_MS');
});

it('rejects an unbounded archive failure grace before scheduling maintenance', () => {
  vi.stubEnv('DATABASE_URL', 'fixture');
  vi.stubEnv('OPENMAIC_PBL_ARCHIVE_FAILURE_GRACE_MS', 'Infinity');
  expect(() => startLearningLifecycle(async () => {})).toThrow(
    'OPENMAIC_PBL_ARCHIVE_FAILURE_GRACE_MS',
  );
});
