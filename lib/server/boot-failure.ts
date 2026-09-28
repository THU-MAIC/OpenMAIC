/**
 * Terminating the server process when it cannot start.
 *
 * Next.js calls the instrumentation `register()` hook while it prepares the
 * server, but it does not stop when that hook throws: `next start` and the
 * standalone server log "Failed to prepare server", keep listening, and answer
 * every request with a 500. A deployment whose boot failed therefore looked
 * alive (the port is open) while serving nothing.
 *
 * {@link exitOnBootFailure} is the one place that turns such a failure into a
 * process exit with code 1, after writing it to stderr, so a process supervisor
 * or container runtime sees the failure and reports it:
 *
 * - a refused configuration (`isInvalidBootConfigurationError`, see
 *   `./boot-configuration-error.ts`) is one line carrying the original
 *   validation message, which names the setting and the fix;
 * - anything else (a module that cannot be loaded, a bug in startup code) is
 *   labelled as a startup failure and printed with its stack and cause, so it
 *   is not mistaken for a bad setting.
 *
 * It is deliberately a thin wrapper in a module of its own, so tests that drive
 * `register()` stub it and assert the thrown error instead of losing the test
 * process. Node.js runtime only: `register()` returns before any validation on
 * Edge, where there is no process to exit.
 */
import { isInvalidBootConfigurationError } from '@/lib/server/boot-configuration-error';

/** The exit code of a server that failed to boot. */
export const BOOT_FAILURE_EXIT_CODE = 1;

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const own = error.stack ?? `${error.name}: ${error.message}`;
  return error.cause === undefined ? own : `${own}\nCaused by: ${describeError(error.cause)}`;
}

/** What is written to stderr before the process exits. */
export function formatBootFailure(error: unknown): string {
  if (isInvalidBootConfigurationError(error)) {
    return `[boot] Invalid server configuration; the server will not start: ${error.message}`;
  }
  return `[boot] Server startup failed; the server will not start:\n${describeError(error)}`;
}

/**
 * Print the failure and exit the process with {@link BOOT_FAILURE_EXIT_CODE}.
 * The exit waits for stderr to flush (a pipe is asynchronous on some
 * platforms), so the message is not lost with the process. Returns only when
 * `process.exit` itself is stubbed.
 */
export async function exitOnBootFailure(error: unknown): Promise<void> {
  const text = `${formatBootFailure(error)}\n`;
  await new Promise<void>((resolve) => {
    try {
      process.stderr.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
  process.exit(BOOT_FAILURE_EXIT_CODE);
}
