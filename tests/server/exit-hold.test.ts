/**
 * holdProcessExit: Next.js' own SIGTERM/SIGINT exit is held until the app's
 * shutdown has settled, open requests keep a bounded grace, and the hold never
 * outlives its deadline or a caller that exits on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { holdProcessExit } from '@/lib/server/exit-hold';

let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function hold(options: { exitOwnedElsewhere?: () => boolean } = {}) {
  const shutdown = Promise.withResolvers<void>();
  const handle = holdProcessExit({
    shutdown: shutdown.promise,
    signalCode: 143,
    httpGraceMs: 10_000,
    deadlineMs: 30_000,
    ...options,
  });
  return { handle, finishShutdown: () => shutdown.resolve() };
}

describe('holdProcessExit', () => {
  it('defers the exit Next.js asks for until the shutdown has settled', async () => {
    const { finishShutdown } = hold();
    process.exit(143);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exit).not.toHaveBeenCalled();
    finishShutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(143);
    // The hold is gone: later exits go straight through.
    expect(process.exit).toBe(exit);
  });

  it('keeps the process up once it holds an exit', async () => {
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const { handle } = hold();
    const deadline = timeouts.mock.results[0]?.value as NodeJS.Timeout;
    timeouts.mockRestore();
    // On its own the hold does not keep the process alive...
    expect(deadline.hasRef()).toBe(false);
    // ...but once it holds an exit, Node must not end the process first (with
    // code 0) when nothing else keeps it alive: the hold exits with this code.
    process.exit(143);
    expect(deadline.hasRef()).toBe(true);
    handle.release();
  });

  it('lets open requests finish until the grace after the signal, then exits with its code', async () => {
    const { finishShutdown } = hold();
    finishShutdown();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('exits as soon as Next.js asks once the shutdown is done', async () => {
    const { finishShutdown } = hold();
    finishShutdown();
    await vi.advanceTimersByTimeAsync(2_000);
    process.exit(0);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).toHaveBeenCalledOnce();
  });

  it('exits without the grace when the shutdown outlasted it', async () => {
    const { finishShutdown } = hold();
    await vi.advanceTimersByTimeAsync(15_000);
    finishShutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('exits at the deadline when the shutdown never settles', async () => {
    hold();
    process.exit(130);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(130);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the exit to its owner when one exits on its own', async () => {
    let owned = false;
    const { handle, finishShutdown } = hold({ exitOwnedElsewhere: () => owned });
    process.exit(143);
    owned = true;
    finishShutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).not.toHaveBeenCalled();
    // The owner releases the hold and exits with its own code.
    handle.release();
    expect(process.exit).toBe(exit);
    process.exit(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps deferring Next.js' exit for an owner until it releases the hold", async () => {
    const { handle, finishShutdown } = hold({ exitOwnedElsewhere: () => true });
    finishShutdown();
    // The grace runs out before Next.js asks (a request was still open).
    await vi.advanceTimersByTimeAsync(10_000);
    process.exit(143);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).not.toHaveBeenCalled();
    handle.release();
    expect(process.exit).toBe(exit);
  });

  it('keeps a deadline longer than a timer can wait instead of exiting at once', async () => {
    const shutdown = Promise.withResolvers<void>();
    const handle = holdProcessExit({
      shutdown: shutdown.promise,
      signalCode: 143,
      httpGraceMs: 10_000,
      deadlineMs: 2 ** 31,
    });
    process.exit(143);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exit).not.toHaveBeenCalled();
    handle.release();
  });

  it('stops holding without exiting when released', async () => {
    const { handle } = hold();
    process.exit(143);
    handle.release();
    expect(process.exit).toBe(exit);
    expect(vi.getTimerCount()).toBe(0);
    process.exit(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still ends the hold when the shutdown fails', async () => {
    const shutdown = Promise.withResolvers<void>();
    holdProcessExit({
      shutdown: shutdown.promise,
      signalCode: 143,
      httpGraceMs: 0,
      deadlineMs: 30_000,
    });
    shutdown.reject(new Error('worker drain failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(143);
  });
});
