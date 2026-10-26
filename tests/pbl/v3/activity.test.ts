import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPblActivity } from '@/lib/pbl/v3/activity';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

it('reports resumed input immediately without waiting for the next heartbeat', async () => {
  const send = vi.fn(async () => true);
  const activity = createPblActivity(send, () => {});
  activity.mark();
  await activity.flush();
  expect(send).toHaveBeenCalledTimes(1);
  // The learner returns just after idle expiry and before the next client tick.
  // No heartbeat or background timer is run between the input and assertion.
  vi.setSystemTime(new Date('2026-10-23T00:05:01Z'));
  activity.mark();
  expect(send).toHaveBeenCalledTimes(2);
});

it('coalesces interaction bursts and never reports ordinary polling as activity', async () => {
  const send = vi.fn(async () => true);
  const changed = vi.fn();
  const activity = createPblActivity(send, changed);
  await activity.flush();
  expect(send).not.toHaveBeenCalled();
  for (let i = 0; i < 50; i++) activity.mark();
  await activity.flush();
  await activity.flush();
  expect(send).toHaveBeenCalledTimes(1);
});

it('retains failed batches and input arriving while a heartbeat is in flight', async () => {
  let finish!: (recorded: boolean) => void;
  const send = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const activity = createPblActivity(send, () => {});
  activity.mark();
  const first = activity.flush();
  await activity.flush();
  expect(send).toHaveBeenCalledTimes(1);
  activity.mark();
  finish(true);
  await first;
  vi.advanceTimersByTime(30_000);
  const second = activity.flush();
  finish(false);
  await second;
  // Further input after a failure stays coalesced instead of causing a retry storm.
  for (let i = 0; i < 50; i++) activity.mark();
  expect(send).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(30_000);
  const retry = activity.flush();
  finish(true);
  await retry;
  await activity.flush();
  expect(send).toHaveBeenCalledTimes(3);
});

it('throttles continuous input and never sends an empty heartbeat', async () => {
  const send = vi.fn(async () => true);
  const activity = createPblActivity(send, () => {});
  for (let second = 0; second < 30; second++) {
    activity.mark();
    await activity.flush();
    vi.advanceTimersByTime(1000);
  }
  expect(send).toHaveBeenCalledTimes(1);
  activity.mark();
  expect(send).toHaveBeenCalledTimes(2);
  await activity.flush();
  vi.advanceTimersByTime(30_000);
  await activity.flush();
  expect(send).toHaveBeenCalledTimes(2);
});
