/**
 * The abort signal for the ASR request currently in flight.
 *
 * Server-side media extraction wraps each ASR call in `runASRWithTimeout`,
 * which publishes its timeout/cancellation signal here so the provider
 * adapters can pass it into their requests. The wrappers that patch
 * `globalThis.fetch` cannot see transports that import undici's fetch
 * directly (the pinned provider transport does), so an adapter whose request
 * should die with the extraction reads this store instead — no cycle back to
 * the extractor module.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const asrFetchSignal = new AsyncLocalStorage<AbortSignal>();
