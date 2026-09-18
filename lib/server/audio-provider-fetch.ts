/**
 * Strict fetch for audio-provider (TTS/ASR/voice-registration) requests.
 *
 * A BYOK provider `baseUrl` is validated once at the route and then the adapter
 * issues the provider call. Two gaps followed from that split:
 *
 *  1. Redirect bypass — a validated origin answers `302 Location:
 *     http://169.254.169.254/…` (or a loopback/private address) and the default
 *     fetch follows it without re-checking the target.
 *  2. DNS rebinding — the URL-layer guard resolves the hostname once, but the
 *     HTTP client resolves it again when it connects, so an answer set that
 *     changes between the two steers the socket to an internal address.
 *
 * This helper closes both at once by combining the two existing strict
 * primitives:
 *
 *  - {@link fetchWithRedirectValidation} drives `redirect: 'manual'` and
 *    re-validates every hop target under the supplied policy; and
 *  - a pinned undici dispatcher ({@link createValidatedDispatcher}) installs a
 *    custom `connect.lookup` that classifies every resolved address and pins
 *    the vetted answer set, so the socket can only reach an address the guard
 *    approved in the same lookup.
 *
 * The transport is undici's own `fetch` (not the Next-patched global) because
 * the pinned agent is an undici dispatcher: Node's bundled undici and the
 * package's undici are different copies, so the dispatcher is only guaranteed
 * to be honored when both ends come from the same copy. This mirrors the
 * agent-runtime reference call site (`lib/server/agent-runtime/fetch-url.ts`).
 *
 * The same two copies also disagree about *bodies*: the adapters build
 * multipart requests with the platform-global `FormData`/`Blob`/`File`, but
 * undici's serializer only recognizes its own `FormData` and coerces the
 * platform one to the literal string `[object FormData]` (audio and fields
 * gone, `text/plain` on the wire). Before any request leaves this module the
 * body is therefore normalized into shapes this undici version serializes
 * correctly — see {@link normalizeProviderBodyForUndici}.
 *
 * Policy is a server-side decision: a client-supplied BYOK endpoint always
 * runs under the strict public policy (`allowLocalNetworks: false`), while a
 * server-managed provider may inherit the operator's `ALLOW_LOCAL_NETWORKS`
 * opt-in. Cloud metadata endpoints stay refused under every policy. The helper
 * never reads request headers/body for policy.
 */
import {
  fetch as undiciFetch,
  FormData as UndiciFormData,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import { createValidatedDispatcher } from '@/lib/server/pinned-dispatcher';
import {
  allowLocalNetworksEnabled,
  findUnsafeNetworkTargetError,
  type SsrfValidationPolicy,
} from '@/lib/server/ssrf-guard';
import {
  fetchWithRedirectValidation,
  type RedirectValidationFetch,
} from '@/lib/server/fetch-with-redirect-validation';

/** Outbound address policy for one provider request. */
export type AudioProviderFetchPolicy = Partial<SsrfValidationPolicy> & {
  /**
   * When `true`, a redirect answer is a hard failure instead of a followed hop.
   *
   * The audio-download call site has always used `redirect: 'error'` and must
   * not start following redirects: its result-host allowlist only vets the
   * requested URL. {@link fetchWithRedirectValidation} always drives the request
   * as `redirect: 'manual'` and follows hops itself, so this mode takes a thin
   * path instead — the pinned dispatcher is still installed, but the request is
   * issued with the caller's `redirect: 'error'` semantics intact.
   */
  rejectRedirects?: boolean;
};

/** A `fetch`-shaped provider transport bound to one address policy. */
export type AudioProviderFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Resolve the policy when the caller leaves it unset. The default preserves the
 * historical guard behavior (`ALLOW_LOCAL_NETWORKS`); routes with a
 * client-supplied URL pass `false` explicitly so the strict public policy wins
 * over the operator's opt-in.
 */
export function resolveAllowLocalNetworks(allowLocalNetworks?: boolean): boolean {
  return allowLocalNetworks ?? allowLocalNetworksEnabled();
}

// One pooled dispatcher per policy. Keeping the pinned agents alive lets undici
// reuse connections; they are replaced wholesale by the test reset below.
const dispatchers = new Map<boolean, Dispatcher>();

function dispatcherFor(allowLocalNetworks: boolean): Dispatcher {
  let dispatcher = dispatchers.get(allowLocalNetworks);
  if (!dispatcher) {
    dispatcher = createValidatedDispatcher({ allowLocalNetworks });
    dispatchers.set(allowLocalNetworks, dispatcher);
  }
  return dispatcher;
}

const undiciTransport: RedirectValidationFetch = (input, init) =>
  undiciFetch(input, init as UndiciRequestInit) as unknown as Promise<Response>;

// ---------------------------------------------------------------------------
// Body normalization across the two undici copies
// ---------------------------------------------------------------------------

/** The brand every `FormData` class carries, regardless of which copy made it. */
function toStringBrand(value: object): string | undefined {
  return (value as { readonly [Symbol.toStringTag]?: string })[Symbol.toStringTag];
}

/**
 * A `FormData` this transport must rebuild: it brands as `FormData` but is not
 * the undici package's own class (i.e. it came from the platform globals or
 * another undici copy). Undici's serializer brand-checks bodies and coerces
 * such an object to the literal string `[object FormData]`, so the request
 * would leave as `text/plain` with the audio and every field dropped.
 */
function isForeignFormData(body: unknown): body is FormData {
  return (
    typeof body === 'object' &&
    body !== null &&
    toStringBrand(body) === 'FormData' &&
    !(body instanceof UndiciFormData)
  );
}

/**
 * Rebuild `init.body` into shapes this transport's undici serializes correctly.
 *
 * The adapters are right to build bodies with the platform globals — that is
 * the public API boundary — so the mismatch is fixed here, once, for every
 * caller. Only `FormData` needs rebuilding: undici's serializer coerces a
 * foreign one to `[object FormData]`, while bare platform Blob/File bodies and
 * multipart parts alike are accepted as-is (this undici exports no `File`/
 * `Blob` classes and its bare-body brand checks bind the platform ones). A
 * foreign `FormData` is re-created as undici's own with every entry carried
 * over verbatim; all other bodies pass through untouched.
 */
function normalizeProviderBodyForUndici(init: RequestInit | undefined): RequestInit | undefined {
  const body = init?.body;
  if (!isForeignFormData(body)) return init;
  const rebuilt = new UndiciFormData();
  // `append` (not `set`) so repeated field names survive the rebuild exactly as
  // the caller declared them, and no filename argument: a platform File carries
  // its own name/type/lastModified and undici accepts it as a part directly.
  for (const [name, value] of body.entries()) {
    rebuilt.append(name, value);
  }
  return { ...init, body: rebuilt as unknown as FormData };
}

/**
 * Issue one provider request: a pinned dispatcher plus redirect handling under
 * the given policy. By default redirects are followed only after each hop is
 * re-validated; with `rejectRedirects` a 3xx is a hard failure instead. The
 * origin is validated by the caller (the route or the download helper, under
 * the same policy); this helper owns redirect handling and connect-time pinning.
 */
export async function audioProviderFetch(
  input: string | URL,
  init?: RequestInit,
  policy: AudioProviderFetchPolicy = {},
): Promise<Response> {
  const allowLocalNetworks = resolveAllowLocalNetworks(policy.allowLocalNetworks);
  const dispatcher = dispatcherFor(allowLocalNetworks);
  // Normalize the body once, before either transport path can serialize it:
  // both the direct `redirect: 'error'` request and the per-hop loop hand the
  // init to undici's fetch, whose serializer is the one that must recognize it.
  const normalizedInit = normalizeProviderBodyForUndici(init);
  try {
    // Redirect-free mode: the caller owns the exact URL and its allowlist, so a
    // 3xx must stay a hard failure. Issue the request directly with the pinned
    // dispatcher and the caller's `redirect: 'error'`; never hand it to the
    // per-hop loop, which would follow the redirect.
    if (policy.rejectRedirects) {
      return await undiciTransport(input, {
        ...(normalizedInit ?? {}),
        redirect: 'error',
        dispatcher,
      } as RequestInit);
    }
    return await fetchWithRedirectValidation(input, normalizedInit, {
      fetchImpl: undiciTransport,
      dispatcher,
      allowLocalNetworks,
    });
  } catch (error) {
    // Undici reports a connect-time lookup refusal as `TypeError: fetch failed`
    // with the guard error as `cause`; surface the typed refusal so routes can
    // answer 403 (the same mapping `/api/proxy-media` uses) instead of an
    // opaque transport failure.
    const blocked = findUnsafeNetworkTargetError(error);
    if (blocked) throw blocked;
    throw error;
  }
}

/** Bind {@link audioProviderFetch} to one policy (e.g. for the AI SDK). */
export function createAudioProviderFetch(
  policy: AudioProviderFetchPolicy = {},
): AudioProviderFetch {
  return (input, init) => audioProviderFetch(input, init, policy);
}

/** Tear down the pooled pinned dispatchers between tests. */
export function destroyAudioProviderDispatchersForTests(): void {
  for (const dispatcher of dispatchers.values()) {
    void dispatcher.destroy().catch(() => undefined);
  }
  dispatchers.clear();
}
