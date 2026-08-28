/**
 * Node-only shutdown signal wiring.
 *
 * Kept out of `instrumentation.ts` so the Edge runtime bundle never contains
 * `process.once`, which Next's Edge compiler rejects as a Node.js API. The
 * parent module imports this dynamically and only on the Node.js runtime.
 */
export function registerShutdownSignals(shutdown: () => Promise<void>): void {
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
