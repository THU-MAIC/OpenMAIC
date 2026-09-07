/**
 * Node-only process signal hooks for graceful shutdown.
 *
 * Kept in its own module so `instrumentation.ts` can pull it in dynamically:
 * Next compiles an Edge variant of the instrumentation file and flags any
 * static `process.once(...)` in it as a Node.js API. A dynamic import splits
 * this file into a Node-only chunk the Edge bundle never sees — the same
 * pattern used there for the `pg`/fs-backed persistence and config modules.
 */
export function registerShutdownSignals(onShutdown: () => void): void {
  process.once('SIGTERM', onShutdown);
  process.once('SIGINT', onShutdown);
}
