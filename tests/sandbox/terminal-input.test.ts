import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxRequestError } from '@/components/sandbox/client';
import { createTerminalInput } from '@/components/sandbox/terminal-input';
afterEach(() => vi.useRealTimers());
describe('terminal input transport', () => {
  it('batches typed characters into one ordered request', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const t = createTerminalInput(send, vi.fn());
    for (const c of 'echo hello\n') t.input(c);
    await vi.advanceTimersByTimeAsync(20);
    expect(send.mock.calls).toEqual([[{ action: 'input', data: 'echo hello\n' }]]);
    t.dispose();
  });
  it('buffers the next batch and serializes resize with pending input', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            release = r;
          }),
      )
      .mockResolvedValue(undefined);
    const t = createTerminalInput(send, vi.fn());
    t.input('a');
    await vi.advanceTimersByTimeAsync(20);
    t.input('b');
    t.input('c');
    t.resize(80, 24);
    t.resize(100, 30);
    await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(send.mock.calls).toEqual([
      [{ action: 'input', data: 'a' }],
      [{ action: 'input', data: 'bc' }],
      [{ action: 'resize', cols: 100, rows: 30 }],
    ]);
    t.dispose();
  });
  it('never retries uncertain input or flushes later buffered input', async () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const send = vi.fn().mockRejectedValue(new Error('lost response'));
    const t = createTerminalInput(send, fail);
    t.input('run\n');
    await vi.advanceTimersByTimeAsync(20);
    t.input('again\n');
    await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledOnce();
  });
  it('retries only a confirmed pre-dispatch busy rejection and preserves subsequent input order', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        new SandboxRequestError('busy', 409, 'SANDBOX_CONFLICT', 'ENVIRONMENT_BUSY'),
      )
      .mockResolvedValue(undefined);
    const fail = vi.fn();
    const t = createTerminalInput(send, fail);
    t.input('a');
    await vi.advanceTimersByTimeAsync(25);
    t.input('b');
    await vi.advanceTimersByTimeAsync(300);
    expect(send.mock.calls).toEqual([
      [{ action: 'input', data: 'a' }],
      [{ action: 'input', data: 'a' }],
      [{ action: 'input', data: 'b' }],
    ]);
    expect(fail).not.toHaveBeenCalled();
    t.dispose();
  });
  it('cancels a busy retry when disposed and never retries a permission rejection', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValue(
        new SandboxRequestError('busy', 409, 'SANDBOX_CONFLICT', 'ENVIRONMENT_BUSY'),
      );
    const t = createTerminalInput(send, vi.fn());
    t.input('a');
    await vi.advanceTimersByTimeAsync(25);
    t.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledOnce();
    const denied = vi
      .fn()
      .mockRejectedValue(
        new SandboxRequestError('denied', 409, 'SANDBOX_CONFLICT', 'WORKBENCH_ACCESS_DENIED'),
      );
    const fail = vi.fn();
    createTerminalInput(denied, fail).input('a');
    await vi.advanceTimersByTimeAsync(500);
    expect(denied).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledOnce();
  });
  it('bounds queued UTF8 bytes and drops disposed input', async () => {
    vi.useFakeTimers();
    const fail = vi.fn();
    const send = vi.fn();
    const t = createTerminalInput(send, fail);
    t.input('中'.repeat(6000));
    await vi.advanceTimersByTimeAsync(100);
    expect(send).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledOnce();
    const second = createTerminalInput(send, fail);
    second.input('pending');
    second.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).not.toHaveBeenCalled();
  });
});
