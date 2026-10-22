import { afterEach, expect, it, vi } from 'vitest';
import { teachingDeadline } from '@/lib/server/agent-runtime/teaching-deadline';

afterEach(() => vi.useRealTimers());

it('allows a progressing turn past two minutes but times out a later stall with its phase', async () => {
  vi.useFakeTimers();
  const expire = vi.fn();
  const deadline = teachingDeadline(new AbortController().signal, expire);
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
    deadline.activity('model');
  }
  expect(expire).not.toHaveBeenCalled();
  deadline.activity('tool:read_next_skill');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(expire).toHaveBeenCalledExactlyOnceWith(
    new Error('Teaching turn timed out after 120 seconds without progress (tool:read_next_skill).'),
  );
});

it('retains a ten minute ceiling even with repeated progress', async () => {
  vi.useFakeTimers();
  const expire = vi.fn();
  const deadline = teachingDeadline(new AbortController().signal, expire);
  for (let i = 0; i < 9; i++) {
    await vi.advanceTimersByTimeAsync(60_000);
    deadline.activity('model');
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(expire).toHaveBeenCalledExactlyOnceWith(
    new Error('Teaching turn timed out at the 600 second safety limit.'),
  );
});

it.each(['abort', 'dispose'] as const)(
  'does not overwrite a settled or cancelled turn after %s',
  async (end) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const expire = vi.fn();
    const deadline = teachingDeadline(controller.signal, expire);
    if (end === 'abort') controller.abort();
    else deadline.dispose();
    deadline.activity('model');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(expire).not.toHaveBeenCalled();
  },
);
