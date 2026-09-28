/**
 * Terminating the server process when its configuration is invalid.
 *
 * Next.js calls the instrumentation `register()` hook while it prepares the
 * server, but it does not stop when that hook throws: `next start` and the
 * standalone server log "Failed to prepare server", keep listening, and answer
 * every request with a 500. A deployment whose configuration was refused at
 * boot therefore looked alive (the port is open) while serving nothing.
 *
 * {@link exitOnInvalidBootConfiguration} is the one place that turns such a
 * refusal into a process exit: one clear line on stderr carrying the original
 * validation message, then exit code 1, so a process supervisor or container
 * runtime sees the failure and reports it. It is deliberately a thin wrapper
 * in a module of its own, so tests that drive `register()` stub it and assert
 * the thrown error instead of losing the test process.
 *
 * Node.js runtime only: `register()` returns before any validation on Edge,
 * where there is no process to exit.
 */

/** The exit code of a server that refused its configuration. */
export const INVALID_BOOT_CONFIGURATION_EXIT_CODE = 1;

/** The single stderr line printed before the process exits. */
export function formatBootConfigurationFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `[boot] Invalid server configuration; the server will not start: ${message}`;
}

/**
 * Print the refusal and exit the process with
 * {@link INVALID_BOOT_CONFIGURATION_EXIT_CODE}. The exit waits for stderr to
 * flush (a pipe is asynchronous on some platforms), so the message is not lost
 * with the process. Returns only when `process.exit` itself is stubbed.
 */
export async function exitOnInvalidBootConfiguration(error: unknown): Promise<void> {
  const line = `${formatBootConfigurationFailure(error)}\n`;
  await new Promise<void>((resolve) => {
    try {
      process.stderr.write(line, () => resolve());
    } catch {
      resolve();
    }
  });
  process.exit(INVALID_BOOT_CONFIGURATION_EXIT_CODE);
}
