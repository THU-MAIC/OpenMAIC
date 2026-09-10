import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TRANSIENT_ATTEMPTS,
  fetchProxiedMediaUrl,
  isProxyMediaTransientBlocked,
  proxyMediaPermanentStatus,
  proxyMediaRetainedBodyCount,
  recordProxyMediaFailure,
  resetProxyMediaFailureCache,
} from '@/lib/media/proxy-media-cache';
import { createProxiedFetch } from '@/lib/export/proxied-fetch';

const URL = 'https://cdn.example.com/api/classroom-media/c1/audio/tts.mp3';

/**
 * A signal that aborts after `ms` via the (fake-)timers — the deterministic
 * stand-in for `AbortSignal.timeout`, which `fetchMediaUrl` passes to every
 * remote media fetch.
 */
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

describe('proxy-media session negative cache', () => {
  beforeEach(() => {
    resetProxyMediaFailureCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetProxyMediaFailureCache();
  });

  it('Case 1: 4xx marks the URL permanently failed: later calls short-circuit with no network request', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ success: false }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchProxiedMediaUrl(URL);
    expect(first.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(proxyMediaPermanentStatus(URL)).toBe(401);

    // Same URL again (and again) must never reach the network.
    const second = await fetchProxiedMediaUrl(URL);
    expect(second.status).toBe(401);
    const third = await fetchProxiedMediaUrl(URL);
    expect(third.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Case 1: fetchMediaUrl: after a 4xx, a second call to the same URL does not fetch', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ success: false }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchMediaUrl } = await import('@/lib/media/fetch-media-url');

    const first = await fetchMediaUrl(URL, 5_000);
    expect(first.status).toBe(401);
    await fetchMediaUrl(URL, 5_000);
    await fetchMediaUrl(URL, 5_000);
    // Only the first call hit the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Case 1: the recorded status is preserved in the short-circuited response (caller contract)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    await fetchProxiedMediaUrl(URL);
    const cached = await fetchProxiedMediaUrl(URL);
    expect(cached.status).toBe(403);
    const body = (await cached.json()) as { errorCode?: string; error?: string };
    expect(body.errorCode).toBe('UPSTREAM_ERROR');
    expect(typeof body.error).toBe('string');
  });

  it('Case 2: 5xx stays retryable: real attempts resume after the backoff window and cap at MAX_TRANSIENT_ATTEMPTS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn(async () => new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    // Attempt 1: a real request, and the failure is NOT permanent.
    const first = await fetchProxiedMediaUrl(URL);
    expect(first.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(proxyMediaPermanentStatus(URL)).toBeUndefined();

    // Inside the first backoff window: short-circuits without a request.
    await fetchProxiedMediaUrl(URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Backoff(1)=400ms elapsed: a second REAL attempt happens.
    vi.setSystemTime(400);
    await fetchProxiedMediaUrl(URL);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Inside the second backoff window: short-circuits again.
    await fetchProxiedMediaUrl(URL);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Backoff(2)=800ms elapsed: the third (final) real attempt.
    vi.setSystemTime(400 + 800);
    await fetchProxiedMediaUrl(URL);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The per-URL cap is reached: every later call short-circuits.
    await fetchProxiedMediaUrl(URL);
    await fetchProxiedMediaUrl(URL);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(isProxyMediaTransientBlocked(URL)).toBe(true);
  });

  it('Case 2: network errors are transient: counted toward the cap, and the rejection contract is preserved', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProxiedMediaUrl(URL)).rejects.toThrow('Failed to fetch');
    expect(proxyMediaPermanentStatus(URL)).toBeUndefined();
    expect(isProxyMediaTransientBlocked(URL, 0)).toBe(true); // backoff window open
    expect(isProxyMediaTransientBlocked(URL, 500)).toBe(false); // window elapsed, cap not reached

    vi.setSystemTime(500);
    await expect(fetchProxiedMediaUrl(URL)).rejects.toThrow('Failed to fetch');
    vi.setSystemTime(500 + 800);
    await expect(fetchProxiedMediaUrl(URL)).rejects.toThrow('Failed to fetch');
    // Cap reached: the next call short-circuits instead of throwing/reaching the network.
    const shortCircuited = await fetchProxiedMediaUrl(URL);
    expect(shortCircuited.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('Case 2: retryable 4xx (408/425/429) is transient: a recovered 429 returns 200 after the backoff window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response('bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    // A rate-limited first response is NOT a permanent verdict.
    const first = await fetchProxiedMediaUrl(URL);
    expect(first.status).toBe(429);
    expect(proxyMediaPermanentStatus(URL)).toBeUndefined();

    // Inside the backoff window: short-circuits, no real request.
    await fetchProxiedMediaUrl(URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Backoff(1)=400ms elapsed: the retry is a REAL request and the upstream
    // has recovered — the 200 is read and returned, not synthesized.
    vi.setSystemTime(400);
    const recovered = await fetchProxiedMediaUrl(URL);
    expect(recovered.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Case 2: 408/425/429 are the only 4xx that take the transient path; other 4xx stay permanent', async () => {
    for (const status of [408, 425, 429]) {
      recordProxyMediaFailure(URL, status);
      expect(proxyMediaPermanentStatus(URL), String(status)).toBeUndefined();
      expect(isProxyMediaTransientBlocked(URL, 0), String(status)).toBe(true);
      resetProxyMediaFailureCache();
    }
    for (const status of [400, 401, 403, 404, 418, 422]) {
      recordProxyMediaFailure(URL, status);
      expect(proxyMediaPermanentStatus(URL), String(status)).toBe(status);
      resetProxyMediaFailureCache();
    }
  });

  it('Case 3: the negative cache is session-scoped memory: a reset (page refresh) allows re-probing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Record one permanent (4xx) and one transient (5xx) verdict.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchProxiedMediaUrl(URL);
    await fetchProxiedMediaUrl(URL + '#other'); // distinct URL for the 5xx record
    expect(proxyMediaPermanentStatus(URL)).toBe(401);

    // A page refresh forgets everything…
    resetProxyMediaFailureCache();
    expect(proxyMediaPermanentStatus(URL)).toBeUndefined();
    expect(isProxyMediaTransientBlocked(URL)).toBe(false);

    // …and the same URL is fetched again (a recovered URL gets one more chance).
    fetchMock.mockResolvedValue(new Response('bytes', { status: 200 }));
    const retried = await fetchProxiedMediaUrl(URL);
    expect(retried.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('Case 3: nothing is persisted outside the module: only in-memory Maps are touched', async () => {
    // The cache module has no storage imports; prove the verdicts live only in
    // the session by re-importing the module (as a reload would) and observing
    // an empty cache that fetches again.
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    recordProxyMediaFailure(URL, 401);
    expect(proxyMediaPermanentStatus(URL)).toBe(401);

    vi.resetModules();
    const fresh = await import('@/lib/media/proxy-media-cache');
    expect(fresh.proxyMediaPermanentStatus(URL)).toBeUndefined();
    await fresh.fetchProxiedMediaUrl(URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('covers the export proxied-fetch: a 4xx recorded through it short-circuits later calls', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ success: false }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pfetch = createProxiedFetch();

    const first = await pfetch(URL);
    expect(first.status).toBe(401);
    const second = await pfetch(URL);
    expect(second.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('same-origin absolute URLs go direct without overriding HTTP revalidation by default', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost:3000', href: 'http://localhost:3000/' });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ success: false }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { fetchMediaUrl } = await import('@/lib/media/fetch-media-url');
    const sameOriginUrl = 'http://localhost:3000/api/classroom-media/c1/audio/a.mp3';

    await fetchMediaUrl(sameOriginUrl, 5_000);
    await fetchMediaUrl(sameOriginUrl, 5_000);
    // Both calls bypass the app's proxy cache and preserve the endpoint's
    // default must-revalidate semantics for exports and other consumers.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      sameOriginUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const directInit = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1];
    expect(directInit).not.toHaveProperty('cache');
    expect(proxyMediaPermanentStatus(sameOriginUrl)).toBeUndefined();
  });

  it('lets the progressive converter explicitly reuse a just-rendered same-origin response', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost:3000', href: 'http://localhost:3000/' });
    const fetchMock = vi.fn(async () => new Response(new Blob(['media']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchMediaUrl } = await import('@/lib/media/fetch-media-url');
    const sameOriginUrl = 'http://localhost:3000/api/classroom-media/c1/audio/a.mp3';

    await fetchMediaUrl(sameOriginUrl, 5_000, { cache: 'force-cache' });

    expect(fetchMock).toHaveBeenCalledWith(
      sameOriginUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal), cache: 'force-cache' }),
    );
  });

  it('waits for an in-flight rendered image before issuing the conversion fetch', async () => {
    const sameOriginUrl = 'http://localhost:3000/api/classroom-media/c1/images/a.png';
    vi.stubGlobal('location', { origin: 'http://localhost:3000', href: 'http://localhost:3000/' });
    const renderedImage = Object.assign(new EventTarget(), {
      tagName: 'IMG',
      currentSrc: sameOriginUrl,
      complete: false,
      getAttribute: () => sameOriginUrl,
    });
    vi.stubGlobal('document', {
      querySelectorAll: () => [renderedImage],
    });
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    const fetchMock = vi.fn(async () => new Response(new Blob(['media']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchMediaUrl } = await import('@/lib/media/fetch-media-url');

    const conversionFetch = fetchMediaUrl(sameOriginUrl, 5_000, {
      cache: 'force-cache',
      waitForRenderedMedia: true,
    });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    renderedImage.dispatchEvent(new Event('load'));
    await conversionFetch;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it(`rapid-fire back-to-back calls (the spam loop) let only one real request through`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    // The observed symptom: a caller loop re-invoking the same URL every
    // ~400ms. While the backoff window is open, every further call
    // short-circuits — no network request is fired.
    for (let i = 0; i < 20; i += 1) {
      await fetchProxiedMediaUrl(URL);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Even after the backoff window elapses, the session cap bounds the total.
    vi.setSystemTime(400);
    await fetchProxiedMediaUrl(URL);
    vi.setSystemTime(400 + 800);
    await fetchProxiedMediaUrl(URL);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TRANSIENT_ATTEMPTS);
    await fetchProxiedMediaUrl(URL);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_TRANSIENT_ATTEMPTS);
  });

  it('concurrent in-flight calls for the same URL share ONE real request (P2-3)', async () => {
    // P2-3: a serial loop was never the failure — 10 callers hitting the same
    // URL at once all passed the blocked check before any failure was
    // recorded, so 10 real requests fired. In-flight dedupe must collapse the
    // burst onto a single fetch.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(null, { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = Array.from({ length: 10 }, () => fetchProxiedMediaUrl(URL));
    // All 10 are in flight (the fetch is gated) — and only one real request
    // has been fired.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release();
    const responses = await Promise.all(pending);
    expect(responses).toHaveLength(10);
    expect(responses.every((r) => r.status === 503)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After settlement the 503 was recorded once: the URL is now transient-
    // blocked, so the next call short-circuits without a network request.
    const next = await fetchProxiedMediaUrl(URL);
    expect(next.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('each concurrent consumer reads the FULL body of the shared response (R2-P2-4)', async () => {
    // R2-P2-4: dedupe handed every consumer the SAME Response object, so the
    // first caller to consume the body made it unreadable for the rest — a
    // shared success was only readable by one consumer. Every consumer must
    // receive its own clone with the complete bytes.
    const bytes = 'media-bytes-0123456789-abcdef';
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([fetchProxiedMediaUrl(URL), fetchProxiedMediaUrl(URL)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).not.toBe(b); // distinct Response objects, not one shared instance

    await expect(a.text()).resolves.toBe(bytes);
    await expect(b.text()).resolves.toBe(bytes);
  });

  it('aborting ONE caller rejects only that caller; others keep the 200 and the URL stays clean (R2-P2-5)', async () => {
    // R2-P2-5: the shared fetch must not inherit any single caller's signal.
    // Caller A cancels; caller B (no signal) must still receive the real 200
    // and the URL must not be poisoned with a transient failure/backoff.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response('bytes', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const owner = new AbortController();
    const a = fetchProxiedMediaUrl(URL, { signal: owner.signal });
    const b = fetchProxiedMediaUrl(URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Only caller A is cancelled — with the DOM abort contract (AbortError).
    owner.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });

    // B is untouched: the shared request is still pending on the internal
    // controller, and B reads the full 200 response.
    release();
    const bResponse = await b;
    expect(bResponse.status).toBe(200);
    expect(await bResponse.text()).toBe('bytes');

    // The caller cancellation was never recorded as a failure: no backoff and
    // no cap — the next call fires a REAL request again.
    expect(isProxyMediaTransientBlocked(URL)).toBe(false);
    const after = await fetchProxiedMediaUrl(URL);
    expect(after.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborting EVERY caller aborts the real fetch — the teardown records ONE transient failure (R3-P2-1)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let internalSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      internalSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = new AbortController();
    const b = new AbortController();
    const pa = fetchProxiedMediaUrl(URL, { signal: a.signal });
    const pb = fetchProxiedMediaUrl(URL, { signal: b.signal });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A leaves: refcount is not zero yet (B is still in), so the real fetch
    // keeps running — caller-driven cancellation while OTHERS wait records
    // nothing.
    a.abort();
    await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
    expect(internalSignal?.aborted).toBe(false);

    // B leaves too: refcount hits zero → the internal controller aborts the
    // real fetch. NO caller received a result and the fetch never settled, so
    // the teardown records ONE transient failure (status 0) — a dead/slow URL
    // must not be re-fired back-to-back by the next caller. Callers still saw
    // only their own AbortError.
    b.abort();
    await expect(pb).rejects.toMatchObject({ name: 'AbortError' });
    expect(internalSignal?.aborted).toBe(true);
    expect(isProxyMediaTransientBlocked(URL)).toBe(true);

    // The recorded failure opens the backoff window: the next call
    // short-circuits without a network request…
    const shortCircuited = await fetchProxiedMediaUrl(URL);
    expect(shortCircuited.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // …and after the window elapses a fresh REAL request is made (the URL is
    // retryable, not permanently poisoned).
    vi.setSystemTime(400);
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    const retried = await fetchProxiedMediaUrl(URL);
    expect(retried.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a dead URL whose callers time out enters backoff and short-circuits the next call (R3-P2-1)', async () => {
    // fetchMediaUrl always passes AbortSignal.timeout(15_000). When the
    // upstream/proxy hangs, every caller times out and the teardown abort is
    // the URL's only signal — before this fix it was treated as plain caller
    // cancellation and the next load/export fired the same dead request
    // forever, never entering the backoff or the attempt cap.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Caller 1 times out: nobody received a result → the teardown records the
    // URL's FIRST transient failure and the backoff window opens.
    const signal1 = timeoutSignal(5_000);
    const p1 = fetchProxiedMediaUrl(URL, { signal: signal1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isProxyMediaTransientBlocked(URL)).toBe(true); // backoff(1)=400ms open

    // Backoff(1) elapses: caller 2 times out the same way → attempt 2.
    vi.advanceTimersByTime(400);
    const signal2 = timeoutSignal(5_000);
    const p2 = fetchProxiedMediaUrl(URL, { signal: signal2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Caller 3 arrives inside the backoff window: the call short-circuits —
    // no real request, no third timeout.
    const third = await fetchProxiedMediaUrl(URL);
    expect(third.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a teardown abort while the 2xx body is still buffering records exactly once (R3-P2-1)', async () => {
    // The shared fetch RESOLVED (status 200) but the body was still streaming
    // into the buffer when the last caller left. The teardown aborts the
    // internal controller, the body read rejects with AbortError, and that
    // rejection must NOT be recorded a second time (the teardown already
    // recorded the URL's one transient failure).
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener('abort', () => {
                controller.error(new DOMException('Aborted', 'AbortError'));
              });
            },
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const owner = new AbortController();
    const pending = fetchProxiedMediaUrl(URL, { signal: owner.signal });
    owner.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Exactly ONE transient failure is on the books: the backoff(1)=400ms
    // window is open. A double count would have armed the longer window.
    expect(isProxyMediaTransientBlocked(URL)).toBe(true);
    vi.setSystemTime(400);
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    const retried = await fetchProxiedMediaUrl(URL);
    expect(retried.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('buffers the shared 2xx body ONCE — 5 consumers × 512 KiB read the full bytes, 1 fetch (R3-P2-5)', async () => {
    // The clone-per-consumer design formed a tee chain: N concurrent readers
    // kept N stream branches of the unread original in memory. The shared
    // path now buffers the body exactly once into a single Blob and every
    // consumer synthesizes a fresh Response over that same Blob — memory is
    // ONE body copy, never N ReadableStream branches and never N per-consumer
    // Response byte copies.
    const bytes = 'x'.repeat(512 * 1024); // 512 KiB, the acceptance body size
    const fetchMock = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const responses = await Promise.all(Array.from({ length: 5 }, () => fetchProxiedMediaUrl(URL)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Every consumer gets its OWN fresh Response (never a shared instance)…
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(responses).size).toBe(5);
    // …and reads the COMPLETE body, byte-identical.
    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(bodies.every((b) => b === bytes)).toBe(true);
    // The synthesized responses preserved the content-type.
    expect(responses[0]?.headers.get('content-type')).toBe('audio/mpeg');
  });

  it('memory contract: 5 consumer Responses over ONE shared Blob cost < 2× body, not 5× (R4-P2-1)', async () => {
    // R4-P2-1: `new Response(shared.body)` with an ArrayBuffer body copied the
    // bytes PER CONSUMER at construction (Node 22.22.0 probe: 5 ×
    // new Response(20 MiB ArrayBuffer) → arrayBuffers +120 MiB ≈ 6× body).
    // The shared path now buffers once into ONE Blob; undici reads a Blob
    // body lazily by reference, so constructing N consumer Responses adds no
    // byte copies (probe: 5 × new Response(20 MiB Blob) → +0.1 MiB).
    const size = 512 * 1024;
    // The single upstream byte copy the shared request reads once — held by
    // the test so the measured window covers exactly the module's buffering
    // plus the N Response constructions (the finding), not the upstream read.
    const buffered = new ArrayBuffer(size);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg', 'content-length': String(size) }),
      arrayBuffer: async () => buffered,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const before = process.memoryUsage().arrayBuffers;
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetchProxiedMediaUrl(URL)));
    const delta = process.memoryUsage().arrayBuffers - before;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The shared path's total byte cost: ONE Blob copy (the module's single
    // "buffer once" construction, 1× body) + 5 lazy Response(Blob)
    // constructions (~0). If consumer Responses copied the bytes (the
    // regression), the delta would be ≥ 5× body. Threshold 2× body: the
    // buffered-once Blob is exactly 1×, leaving a full body-size of headroom
    // for the Response objects and allocator noise.
    expect(delta).toBeLessThan(2 * size);
    // The bytes ARE the same single copy: every consumer reads the complete,
    // byte-identical body.
    const read = await Promise.all(responses.map((r) => r.arrayBuffer()));
    expect(read.every((b) => b.byteLength === size)).toBe(true);
    const first = new Uint8Array(read[0]);
    for (const b of read.slice(1)) {
      expect(new Uint8Array(b).every((v, i) => v === first[i])).toBe(true);
    }
  });

  it('no module-level retention: 8 sequential URLs leave ZERO buffered bodies behind (R4-P2-2)', async () => {
    // R4-P2-2: the removed `bufferedMedia` map kept every successful URL's
    // full body for the session (probe: 8 × 4 MiB URLs → 32 MiB retained
    // until an explicit reset). The payload now lives ONLY inside the
    // in-flight entry: it is handed to the joined consumers and, once the
    // last consumer leaves, the entry is dropped — the module references no
    // body bytes.
    const fetchMock = vi.fn(
      async () => new Response('body-'.repeat(64 * 1024), { status: 200 }), // 320 KiB each
    );
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 8; i += 1) {
      const res = await fetchProxiedMediaUrl(`${URL}?seq=${i}`);
      expect(res.status).toBe(200);
      await res.text(); // fully consumed, then dropped
      expect(proxyMediaRetainedBodyCount()).toBe(0);
    }
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('no response cache: a caller arriving AFTER settle starts a fresh fetch (R4-P2-2)', async () => {
    // Deduplication covers only the concurrency window of a shared request —
    // it must never cache the settled response: sequential callers to the
    // same URL each fire a real request (the negative caches are the only
    // session memory, and they never store a 2xx body).
    const fetchMock = vi.fn(async () => new Response('bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchProxiedMediaUrl(URL);
    expect(await first.text()).toBe('bytes');
    expect(proxyMediaRetainedBodyCount()).toBe(0);
    const second = await fetchProxiedMediaUrl(URL);
    expect(await second.text()).toBe('bytes');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(proxyMediaRetainedBodyCount()).toBe(0);
  });

  it('the retention probe counts nothing while a request is still streaming (R4-P2-2)', async () => {
    // The probe counts payloads the module HOLDS (settled Blobs inside joined
    // entries). While the shared request is still in flight the bytes live in
    // the network stream — never in the module — so the count is 0 before and
    // after the fetch.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response('bytes', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchProxiedMediaUrl(URL);
    expect(proxyMediaRetainedBodyCount()).toBe(0); // in flight, nothing buffered
    release();
    const res = await pending;
    expect(proxyMediaRetainedBodyCount()).toBe(0); // delivered, entry dropped
    await res.text();
    expect(proxyMediaRetainedBodyCount()).toBe(0);
  });
});
