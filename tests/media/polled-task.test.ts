import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPolledTask } from '@/lib/media/polled-task';

describe('runPolledTask', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an immediately completed submission without waiting or polling', async () => {
    vi.useFakeTimers();
    const submit = vi.fn().mockResolvedValue({ status: 'done', result: 'video-url' });
    const poll = vi.fn();

    const result = await runPolledTask({
      submit,
      poll,
      intervalMs: 1_000,
      maxAttempts: 3,
      label: 'Test task',
    });

    expect(result).toBe('video-url');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an immediately failed submission without waiting or polling', async () => {
    vi.useFakeTimers();
    const submit = vi.fn().mockResolvedValue({ status: 'failed', message: 'submit failed' });
    const poll = vi.fn();

    await expect(
      runPolledTask({
        submit,
        poll,
        intervalMs: 1_000,
        maxAttempts: 3,
        label: 'Test task',
      }),
    ).rejects.toThrow('submit failed');

    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits before each poll and passes the submitted task id until completion', async () => {
    vi.useFakeTimers();
    const submit = vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-123' });
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending', detail: 'queued' })
      .mockResolvedValueOnce({ status: 'done', result: 'video-url' });

    const promise = runPolledTask({
      submit,
      poll,
      intervalMs: 1_000,
      maxAttempts: 3,
      label: 'Test task',
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(poll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenNthCalledWith(1, 'task-123');

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBe('video-url');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenNthCalledWith(2, 'task-123');
  });

  it('rejects a terminal poll failure without scheduling another attempt', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ status: 'failed', message: 'provider failed' });
    const promise = runPolledTask({
      submit: vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-123' }),
      poll,
      intervalMs: 1_000,
      maxAttempts: 3,
      label: 'Test task',
    });
    const rejection = expect(promise).rejects.toThrow('provider failed');

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates submit and poll exceptions without wrapping them', async () => {
    const submitError = new TypeError('submit network error');
    await expect(
      runPolledTask({
        submit: vi.fn().mockRejectedValue(submitError),
        poll: vi.fn(),
        intervalMs: 0,
        maxAttempts: 1,
        label: 'Test task',
      }),
    ).rejects.toBe(submitError);

    const pollError = new SyntaxError('invalid poll response');
    await expect(
      runPolledTask({
        submit: vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-123' }),
        poll: vi.fn().mockRejectedValue(pollError),
        intervalMs: 0,
        maxAttempts: 1,
        label: 'Test task',
      }),
    ).rejects.toBe(pollError);
  });

  it('polls exactly maxAttempts times before using the default timeout message', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ status: 'pending' });
    const promise = runPolledTask({
      submit: vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-123' }),
      poll,
      intervalMs: 250,
      maxAttempts: 3,
      label: 'Test task',
    });
    const rejection = expect(promise).rejects.toThrow('Test task timed out after 3 polls');

    await vi.advanceTimersByTimeAsync(750);

    await rejection;
    expect(poll).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes the latest pending detail and timing data to a custom timeout formatter', async () => {
    vi.useFakeTimers();
    const formatTimeout = vi.fn(
      ({ lastPendingDetail }: { lastPendingDetail?: string }) =>
        `last status: ${lastPendingDetail}`,
    );
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending', detail: 'Queued' })
      .mockResolvedValueOnce({ status: 'pending', detail: 'Processing' });
    const promise = runPolledTask({
      submit: vi.fn().mockResolvedValue({ status: 'submitted', taskId: 'task-123' }),
      poll,
      intervalMs: 500,
      maxAttempts: 2,
      label: 'Test task',
      formatTimeout,
    });
    const rejection = expect(promise).rejects.toThrow('last status: Processing');

    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(formatTimeout).toHaveBeenCalledWith({
      label: 'Test task',
      taskId: 'task-123',
      attempts: 2,
      intervalMs: 500,
      elapsedMs: 1_000,
      lastPendingDetail: 'Processing',
    });
  });
});
