/**
 * Session-scoped negative cache for /api/proxy-media responses.
 *
 * The proxy contract (`app/api/proxy-media/route.ts`) forwards upstream 4xx
 * as-is and treats most of them as PERMANENT: the upstream asserted the bytes
 * are gone or not reachable, so re-requesting the same URL later in this
 * session cannot succeed. Client callers that re-run on every load/play tick
 * (legacy asset conversion, the media-generation blob fallback, the exporters)
 * had no memory of that verdict, so a course whose TTS URLs live on an
 * unreachable origin hammered the proxy with the same dead URLs forever.
 * This module is the missing memory, shared by every caller that POSTs to
 * /api/proxy-media:
 *
 * - 4xx: the URL is permanently failed for the session; later calls
 *   short-circuit to a synthetic response carrying the recorded status and
 *   never touch the network. EXCEPT the retryable 4xx set (408 request
 *   timeout, 425 too early, 429 rate limited): those are transient failures —
 *   a rate limit or a temporarily unready origin can recover, so they take
 *   the same backoff path as 5xx instead of poisoning the URL for the rest
 *   of the session.
 * - 5xx / network errors: stay retryable (the caller still receives the
 *   failure and may retry), but repeated attempts are throttled with a
 *   simple exponential backoff and a session cap of
 *   {@link MAX_TRANSIENT_ATTEMPTS} real requests per URL. Calls that arrive
 *   inside a backoff window short-circuit without a request, and after the
 *   cap the URL is blocked for the rest of the session. This is a transient
 *   cap, not a permanent verdict: a page refresh starts a fresh session and
 *   a URL that recovered is probed again.
 * - A shared request that was torn down before settling (every caller left,
 *   nobody received a result — e.g. every caller timed out) records ONE
 *   transient failure (status 0), so a dead/slow URL enters the backoff and
 *   the attempt cap instead of being re-fired back-to-back by the next
 *   caller. A caller that aborts while OTHERS still wait records nothing.
 *
 * Concurrent in-flight requests for the SAME URL share ONE real request (the
 * promise is deduped per URL), so a burst of callers cannot blow through the
 * attempt cap or the anti-abuse intent before any failure state is recorded.
 * The shared request is owned by the module, not by any single caller: it runs
 * on an INTERNAL AbortController, each caller races only its OWN signal, and
 * the internal fetch is aborted only when the last caller leaves. A caller's
 * cancellation therefore rejects just that caller and — while others still
 * wait — is never recorded as a failure (no backoff/cap poison for the URL).
 *
 * Success responses are BUFFERED exactly once (the proxy caps a single
 * resource at 25 MiB, so one in-memory copy per shared request is the bounded
 * price): the shared request resolves to the bytes and the module builds ONE
 * shared Blob over that single copy. Every consumer synthesizes its own fresh
 * Response over the SAME Blob — undici reads a Blob body lazily by reference,
 * so constructing N consumer Responses adds no byte copies: N concurrent
 * consumers cost one body copy, not N, with no clone()/tee chain and no
 * per-consumer stream accumulation. The payload lives ONLY inside its
 * in-flight entry: it is handed to the joined consumers and, once the last
 * consumer leaves, the entry is dropped and the module references no body
 * bytes. A caller arriving AFTER the shared request settled starts a FRESH
 * fetch — deduplication covers the concurrency window only and never acts as
 * a response cache. Failure responses are never buffered: every consumer
 * receives a synthesized error response carrying the recorded status and the
 * same JSON body the short-circuit path uses, so the caller-visible contract
 * (status + error classification) is identical whether the verdict was just
 * recorded or already cached.
 *
 * Deliberately in-memory only: nothing is written to IndexedDB, localStorage,
 * or any server, so a refresh resets the whole cache (and with it the right
 * to retry a URL that may have recovered).
 */

interface TransientState {
  attempts: number;
  blockedUntil: number;
}

/** The shared outcome of one real proxied request, buffered for every consumer. */
interface SharedMediaResult {
  status: number;
  /**
   * The 2xx body as ONE shared Blob — buffered exactly once, then referenced
   * lazily by every consumer's Response (undici does not copy a Blob body at
   * `new Response(blob, …)` construction). Absent for non-2xx (synthesized).
   */
  blob?: Blob;
  /** content-type / content-length subset preserved from the real response. */
  headers: Record<string, string>;
}

/** A shared real request for one URL plus the callers currently joined to it. */
interface InFlightEntry {
  promise: Promise<SharedMediaResult>;
  /** Internal controller: no caller's signal is ever forwarded to the fetch. */
  controller: AbortController;
  /** Number of callers still waiting on (or tearing down) this entry. */
  consumers: number;
  /** Whether the shared request has settled (resolve or reject). */
  settled: boolean;
  /**
   * The settled result, once the shared request resolved. A 2xx payload (the
   * shared Blob) is referenced ONLY here while the entry is joined: it is
   * handed to the waiting consumers and, when the last consumer leaves and
   * the entry is dropped, the module holds no body bytes — there is no
   * module-level response cache beyond the entry.
   */
  result?: SharedMediaResult;
}

const permanentFailures = new Map<string, number>();
const transientFailures = new Map<string, TransientState>();
/** Real requests currently in flight, keyed by URL: concurrent callers join one. */
const inFlightRequests = new Map<string, InFlightEntry>();

/** Real network attempts allowed per URL for transient (5xx/network) failures. */
export const MAX_TRANSIENT_ATTEMPTS = 3;

/**
 * 4xx statuses that can recover before the page is reloaded: the upstream is
 * not saying the bytes are gone, only that it cannot serve them right now
 * (request timeout, too early, rate limited). They take the TRANSIENT path;
 * every other 4xx remains a permanent verdict.
 */
const TRANSIENT_4XX_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

const BACKOFF_BASE_MS = 400;
const BACKOFF_MAX_MS = 4_000;

/** Test hook: forget every recorded verdict, as a page refresh would. */
export function resetProxyMediaFailureCache(): void {
  permanentFailures.clear();
  transientFailures.clear();
}

/** The recorded permanent (4xx) status for a URL, or undefined when none. */
export function proxyMediaPermanentStatus(url: string): number | undefined {
  return permanentFailures.get(url);
}

/**
 * Whether a transient (5xx/network) failure currently blocks a real request
 * for this URL: the exponential backoff window is still open, or the
 * per-session attempt cap was reached.
 */
export function isProxyMediaTransientBlocked(url: string, now = Date.now()): boolean {
  const state = transientFailures.get(url);
  if (!state) return false;
  return state.attempts >= MAX_TRANSIENT_ATTEMPTS || state.blockedUntil > now;
}

/**
 * Record a proxy failure for a URL.
 *
 * - 4xx is permanent per the proxy contract, EXCEPT the retryable set
 *   (408/425/429) which the upstream may recover from before a reload.
 * - Anything else (5xx, retryable 4xx, or `status === 0` for a network-level
 *   failure) is transient: it counts toward the per-URL cap and re-arms the
 *   backoff window for the next attempt.
 */
export function recordProxyMediaFailure(url: string, status: number, now = Date.now()): void {
  if (status >= 400 && status < 500 && !TRANSIENT_4XX_STATUSES.has(status)) {
    permanentFailures.set(url, status);
    return;
  }
  const state = transientFailures.get(url) ?? { attempts: 0, blockedUntil: 0 };
  state.attempts += 1;
  if (state.attempts >= MAX_TRANSIENT_ATTEMPTS) {
    state.blockedUntil = Number.POSITIVE_INFINITY;
  } else {
    const backoffMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (state.attempts - 1));
    state.blockedUntil = now + backoffMs;
  }
  transientFailures.set(url, state);
}

/**
 * Test hook: how many 2xx body payloads the module currently holds. A shared
 * request's payload (its Blob) lives ONLY inside its in-flight entry — handed
 * to the joined consumers, dropped when the last consumer leaves — so this
 * count is the module's ENTIRE body retention: after every consumer of a URL
 * has finished, its entry is gone and this is 0. A count, never the bytes:
 * tests assert that nothing is retained, they do not read buffered bodies.
 */
export function proxyMediaRetainedBodyCount(): number {
  let count = 0;
  for (const entry of inFlightRequests.values()) {
    if (entry.result?.blob) count += 1;
  }
  return count;
}

/** Mimic the proxy's JSON error body so cached verdicts behave like real ones. */
function syntheticProxyError(status: number): Response {
  return new Response(
    JSON.stringify({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
      error: `Upstream returned ${status}`,
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * POST one media URL through the same-origin /api/proxy-media, honoring the
 * session negative cache. Every proxy-media caller routes through this
 * function so a permanent 4xx verdict is recorded once and shared by all of
 * them (conversion, generation fallback, exports), and a transient failure
 * cannot be re-fired back-to-back by whichever caller loop is running.
 *
 * Concurrent calls for the SAME URL are deduped onto one in-flight request
 * (they share the same promise): a burst of callers can never fire N real
 * requests before any failure state is recorded, so the attempt cap and the
 * anti-abuse intent hold under true concurrency, not just serial loops.
 *
 * The shared request runs on an INTERNAL AbortController — no caller's signal
 * is forwarded to it. A caller's own `init.signal` is raced per call: aborting
 * it rejects ONLY that caller with an AbortError, other consumers are
 * untouched, and the internal fetch is aborted only when the last consumer
 * leaves (refcount zero). While other callers still wait, a cancellation is
 * never recorded as a failure. When the LAST caller leaves while the real
 * request is still pending — no caller ever received a result — the teardown
 * abort is the URL's only failure signal and records ONE transient failure
 * (status 0), so a dead/slow URL (e.g. `fetchMediaUrl`'s fixed
 * `AbortSignal.timeout`) enters the backoff and the session attempt cap
 * instead of being re-fired by the next caller.
 *
 * Success responses are buffered exactly once into ONE shared Blob and every
 * consumer synthesizes its own fresh Response over that same Blob — undici
 * reads a Blob body lazily by reference, so N concurrent consumers cost ONE
 * body copy with no clone()/tee chain and no per-consumer byte copy. The
 * payload lives only inside the in-flight entry: after the last consumer
 * leaves, the entry is dropped and the module retains no body bytes (a caller
 * arriving later starts a fresh fetch; dedup never acts as a response cache).
 * Non-2xx responses are delivered as synthesized error responses with the
 * same JSON body the short-circuit path uses, so callers that classify 4xx vs
 * 5xx (e.g. the legacy converter) make exactly the same decision they would
 * have made for the original response.
 */
export async function fetchProxiedMediaUrl(url: string, init?: RequestInit): Promise<Response> {
  const permanent = proxyMediaPermanentStatus(url);
  if (permanent !== undefined) return syntheticProxyError(permanent);
  if (isProxyMediaTransientBlocked(url)) return syntheticProxyError(502);
  const callerSignal = init?.signal;
  if (callerSignal?.aborted) throw createAbortError();
  let entry = inFlightRequests.get(url);
  if (!entry) {
    const controller = new AbortController();
    const promise = performProxiedFetch(url, controller);
    const fresh: InFlightEntry = { promise, controller, consumers: 0, settled: false };
    // Flip `settled` as soon as the shared request settles and remember its
    // result, so the teardown never aborts a request that already produced
    // its response. The payload (a 2xx Blob) is referenced only here, inside
    // the in-flight entry: it is delivered to the joined consumers and dies
    // with the entry when the last consumer leaves — no module-level response
    // cache keeps it after that.
    promise.then(
      (result) => {
        fresh.settled = true;
        fresh.result = result;
      },
      () => void (fresh.settled = true),
    );
    entry = fresh;
    inFlightRequests.set(url, entry);
  }
  entry.consumers += 1;
  try {
    // The shared request buffered the body ONCE into a single shared Blob;
    // every consumer builds its OWN fresh Response over that same Blob.
    // Undici reads a Blob body lazily by reference, so this construction does
    // NOT copy the bytes per consumer — memory stays at one body copy for the
    // whole burst.
    const shared = await waitForCaller(entry.promise, callerSignal);
    if (shared.blob) {
      return new Response(shared.blob, { status: shared.status, headers: shared.headers });
    }
    // Non-2xx: a synthesized error response — the same caller-visible
    // contract as the short-circuit path, and no stream to share at all.
    return syntheticProxyError(shared.status);
  } finally {
    entry.consumers -= 1;
    // Only the last caller to leave tears the shared request down — and only
    // while it is still the entry (a late replacement is never torn down).
    // Aborting the internal controller cancels the real request only when
    // every caller is gone (all finished or all cancelled) and it is still
    // pending. When NO caller received a result from a request that never
    // settled, the teardown abort records ONE transient failure so the URL
    // cannot be re-fired back-to-back; callers that cancelled still saw their
    // own AbortError.
    if (entry.consumers <= 0 && inFlightRequests.get(url) === entry) {
      inFlightRequests.delete(url);
      if (!entry.settled) {
        entry.controller.abort();
        recordProxyMediaFailure(url, 0);
      }
    }
  }
}

/** Mimic the DOM fetch abort contract (`error.name === 'AbortError'`). */
function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('Aborted', 'AbortError');
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

/**
 * Await the shared request while racing the CALLER's own signal: aborting
 * that signal rejects ONLY this caller with an AbortError — the shared
 * request keeps running on its internal controller for whoever is left. With
 * no signal, await the shared request directly.
 */
function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function performProxiedFetch(
  url: string,
  controller: AbortController,
): Promise<SharedMediaResult> {
  let response: Response;
  try {
    response = await fetch('/api/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
  } catch (error) {
    // An AbortError here means the INTERNAL controller was aborted: either a
    // caller-driven cancellation while the fetch still serves someone, or the
    // last-caller teardown — which records its own transient failure. Neither
    // is recorded here (no double count), and the rejection is preserved so
    // callers handle it exactly as they do today. Any other rejection
    // (connection reset, timeout, CORS) is transient: count it once toward
    // the per-URL cap but keep the rejection contract.
    if ((error as Error)?.name === 'AbortError') throw error;
    recordProxyMediaFailure(url, 0);
    throw error;
  }
  if (!response.ok) {
    recordProxyMediaFailure(url, response.status);
    // Failure responses are delivered as synthesized responses (same shape
    // as the short-circuit path); the real error body is never shared.
    return { status: response.status, headers: {} };
  }
  // Buffer the 2xx body exactly once. The proxy caps a single resource at
  // 25 MiB, so one in-memory copy per shared request is the bounded price
  // that removes the clone/tee chain N concurrent consumers used to form.
  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch (error) {
    // Same rules as the fetch rejection above: a teardown-triggered AbortError
    // is already recorded by the teardown (no double count); any other
    // mid-body read failure is a network-level transient failure.
    if ((error as Error)?.name === 'AbortError') throw error;
    recordProxyMediaFailure(url, 0);
    throw error;
  }
  // Construct ONE shared Blob over the buffered bytes — the module's single
  // "buffer once" copy (Node copies the buffer into the Blob store at
  // construction). Every consumer wraps THIS Blob, never the bytes: undici
  // references a Blob body lazily, so N `new Response(blob, …)` constructions
  // add no byte copies per consumer.
  return {
    status: response.status,
    headers: pickMediaHeaders(response.headers),
    blob: new Blob([body]),
  };
}

/** The header subset consumers may rely on, preserved from the real response. */
function pickMediaHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of ['content-type', 'content-length']) {
    const value = headers.get(name);
    if (value) picked[name] = value;
  }
  return picked;
}
