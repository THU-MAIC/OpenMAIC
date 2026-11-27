/**
 * Holds the process exit for the app's own shutdown.
 *
 * Next.js handles SIGTERM and SIGINT itself: it stops accepting connections,
 * waits for open requests and pending after() work, and then calls
 * process.exit. It does not wait for the shutdown instrumentation.ts starts on
 * the same signal (the agent runner's drain, the other workers, the pool), so
 * with no request open it exits at once and cuts that shutdown off.
 *
 * holdProcessExit() defers such an exit until the shutdown has settled. Open
 * requests may still finish until `httpGraceMs` after the hold began; a
 * long-lived stream would otherwise keep the process up until the platform
 * kills it. Then, or at the latest at `deadlineMs`, the process exits with the
 * code Next.js asked for, or the signal's.
 *
 * Free of imports, so tests/server/next-signal-contract.test.ts can run it in a
 * real Next.js server.
 */

type ExitCode = Parameters<typeof process.exit>[0];

/** The longest delay a Node.js timer keeps; a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ExitHoldOptions {
  /** Settles once the app's shutdown has finished. */
  shutdown: Promise<unknown>;
  /** The exit code when nothing asked for one: 128 + the signal's number. */
  signalCode: number;
  /** Until this long after the hold began, open requests may finish once the shutdown is done. */
  httpGraceMs: number;
  /** Exit this long after the hold began even if the shutdown has not settled. */
  deadlineMs: number;
  /**
   * Checked when the hold ends; true leaves the exit to its owner (a schema
   * refusal), and every other exit stays deferred until the owner releases the hold.
   */
  exitOwnedElsewhere?: () => boolean;
}

export interface ExitHold {
  /** Stop holding without exiting, also after the hold ended for an owner; the caller exits on its own. */
  release(): void;
}

export function holdProcessExit(options: ExitHoldOptions): ExitHold {
  const exit = process.exit;
  const startedAt = Date.now();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let requested: { code: ExitCode } | undefined;
  let shutdownDone = false;
  let ended = false;
  let restored = false;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.exit = exit;
  };
  const end = (exitWith?: { code: ExitCode }): void => {
    if (ended) return;
    ended = true;
    for (const timer of timers) clearTimeout(timer);
    // An owner exits on its own once it has released the hold; until then no
    // other exit may cut it off.
    if (exitWith && options.exitOwnedElsewhere?.()) return;
    restore();
    if (exitWith) exit.call(process, exitWith.code);
  };
  const finish = (): void => end(requested ?? { code: options.signalCode });
  const after = (delayMs: number, run: () => void): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(run, Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS));
    // Until it holds an exit, the hold does not keep the process alive on its own.
    timer.unref?.();
    timers.push(timer);
    return timer;
  };

  const deadline = after(options.deadlineMs, finish);
  process.exit = ((code?: ExitCode) => {
    requested ??= { code };
    // An exit is held now: Node must not end the process on its own (with code
    // 0) before the hold exits with this code, at the latest at the deadline.
    if (!ended) deadline.ref?.();
    if (shutdownDone) finish();
    return undefined as never;
  }) as typeof process.exit;
  void options.shutdown
    .catch(() => {})
    .then(() => {
      shutdownDone = true;
      if (requested) finish();
      else after(startedAt + options.httpGraceMs - Date.now(), finish);
    });

  return {
    release: () => {
      end();
      restore();
    },
  };
}
