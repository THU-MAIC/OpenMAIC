import { assertHttpBaseUrl } from '../http/base-url.js';
import { assertJsonValue } from '../runtime/json-value.js';
import {
  assertKVScope,
  DEFAULT_KV_SCOPE,
  KVScopeViolationError,
  type DeviceSafeKVStore,
  type KVScope,
  type LocalKVStore,
} from './types.js';

export interface HttpKVHeadersContext {
  method: string;
  path: string;
}

export type HttpKVHeadersHook = (
  context: HttpKVHeadersContext,
) => HeadersInit | Promise<HeadersInit>;

export interface HttpAccountKVOptions {
  /** Root URL before the contract's `/kv/...` paths. */
  baseUrl: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Called for every request so deployments can attach authentication headers. */
  headers?: HttpKVHeadersHook;
  /**
   * Passed straight to `fetch`. A cookie-authenticated deployment whose base URL
   * is on another origin needs `'include'`: `fetch` sends no cookies
   * cross-origin by default, and the headers hook cannot compensate because
   * `Cookie` is a forbidden header name the browser refuses to let scripts set.
   * Such a deployment also owns the CORS side — the server must answer with
   * `Access-Control-Allow-Credentials` and a concrete origin.
   */
  credentials?: RequestCredentials;
}

export interface HttpKVStoreOptions extends HttpAccountKVOptions {
  /**
   * Backend that owns the `device` scope. Required, and typed as a
   * {@link LocalKVStore} rather than a `KVStore`: a networked store satisfies
   * `KVStore` structurally, so accepting one here would reopen the exact seam
   * this class exists to close. There is deliberately no default — a `KVStore`
   * must be able to answer `device` reads and writes, this client structurally
   * cannot carry them, and "where does this device keep its state" has no
   * sensible guess. Pass the deployment's local backend (e.g.
   * `BrowserKVStore`). Only its `device` scope is ever used.
   */
  deviceStore: LocalKVStore;
}

interface ErrorResponseBody {
  error?: {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

/** A server-side KV failure, retaining its machine-readable HTTP identity. */
export class HttpKVStoreError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpKVStoreError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The scope this transport serves, and the only one it can be asked for.
 *
 * Declaring it narrows a direct call — `set(key, value, 'device')` on a
 * `HttpAccountKV` is a type error. It cannot do more than that, because
 * TypeScript compares method parameters bivariantly: this object stands in for
 * the wider `KVStore` wherever one is expected, and a caller holding it that
 * way passes `KVScope`. That is precisely how a device value reached the wire —
 * the extra argument was accepted by the language and dropped on the floor. So
 * the parameter exists at runtime too, and is checked.
 */
export type AccountScope = 'account';

function assertAccountScope(scope: AccountScope | undefined): void {
  if (scope === undefined || scope === 'account') return;
  throw new KVScopeViolationError(
    `@openmaic/storage: HttpAccountKV serves the account scope only and was asked for ` +
      `${JSON.stringify(scope as string)} — device values never leave the device. Route the ` +
      `device scope through HttpKVStore, which keeps it on a LocalKVStore.`,
  );
}

function notEncodable(label: string, reason: string): HttpKVStoreError {
  return new HttpKVStoreError(
    // No exchange happened; the failure is local to building the request.
    0,
    'KEY_NOT_ENCODABLE',
    `@openmaic/storage: this ${label} cannot be carried over the HTTP URL transport — ${reason}. ` +
      `The key domain still permits it; a browser-backed deployment can store it.`,
  );
}

/**
 * Percent-encode a value into a URL component. The key domain is opaque and
 * unconstrained (see `types.ts`); this is where a key or prefix meets a
 * transport that cannot carry every string. `encodeURIComponent` handles any
 * character — NUL becomes `%00`, a separator `%2F` — with a single structural
 * exception: an unpaired UTF-16 surrogate has no UTF-8 encoding, so it throws.
 * That is a limit of *this transport*, not of the value: the browser backend
 * stores such a key fine. Surface it as a clear transport error, not a bare
 * `URIError`.
 */
function encodeComponent(value: string, label: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    throw notEncodable(
      label,
      'it contains an unpaired UTF-16 surrogate, which has no percent-encoding',
    );
  }
}

/**
 * Encode a key as a URL **path segment**. Beyond the surrogate limit, a whole-key
 * `.` or `..` cannot be carried this way: `encodeURIComponent` leaves the dots
 * untouched (they are unreserved), so `/kv/entries/.` and `/kv/entries/..` are
 * normalized by the URL parser *before the request leaves the client* — the
 * first collapses to the empty-key segment, the second walks up a level. Sent as
 * is, they would silently read, overwrite, or delete a *different* entry (an
 * empty key, or a bad route) with no error. That is the same class of transport
 * limit as the surrogate, so it fails loud here. Only the whole key is affected;
 * a key that merely *contains* a dot (`a.b`, `prefix:id`) is an ordinary segment
 * and round-trips.
 */
function encodeKeyPathSegment(key: string): string {
  if (key === '.' || key === '..') {
    throw notEncodable(
      'kv key',
      `a whole-key ${JSON.stringify(key)} is normalized away by URL path parsing and would ` +
        `silently alias a different entry`,
    );
  }
  return encodeComponent(key, 'kv key');
}

function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  const set = (name: string, value: string): void => {
    normalized[name.toLowerCase()] = value;
  };

  if (init === undefined) return normalized;
  if (Array.isArray(init)) {
    for (const [name, value] of init) set(name, value);
    return normalized;
  }
  if (typeof (init as Headers).forEach === 'function') {
    (init as Headers).forEach((value, name) => set(name, value));
    return normalized;
  }
  for (const [name, value] of Object.entries(init)) set(name, value);
  return normalized;
}

/**
 * Wire client for the account-scoped KV HTTP contract.
 *
 * `device` values never leave the device — that is part of the KV primitive,
 * not a deployment setting — and this type is the seam where that could be
 * broken, because it is the only object in the package that can reach the
 * network. It refuses a device value **twice**, once in the type and once at
 * run time, and the second one is doing the real work:
 *
 * - The `scope` parameter admits `'account'` alone, so writing `'device'` at a
 *   call site here is a type error.
 * - That is not enough on its own. TypeScript compares method parameters
 *   bivariantly, so this class satisfies the wider `KVStore` and any caller
 *   holding it that way passes a full `KVScope`. Before the parameter existed
 *   the extra argument was simply dropped, and the device value went out. So
 *   the scope is checked at run time and anything but `account` throws.
 *
 * The contract underneath has no scope in any channel, which is what makes the
 * two checks sufficient rather than merely diligent: there is no field for a
 * device value to occupy even if one got this far. The routing decision lives
 * one level up, in {@link HttpKVStore}.
 */
export class HttpAccountKV {
  /**
   * Anti-brands, and the reason a device-safe store cannot be one of these. This
   * class satisfies `KVStore` structurally — every method is the same method
   * minus an optional parameter, and TypeScript accepts a shorter signature
   * where a longer one is expected — and no member added here can change that,
   * since extra members never block assignment to a narrower interface. So the
   * barrier is placed on the other side: the branded interfaces this class
   * declares itself *not* to satisfy, backed by runtime checks for the `as` that
   * would erase the difference.
   *
   * `servesDeviceScopeLocally` is the load-bearing one. This transport has no
   * local device backend at all — a `device` value handed to it would go on the
   * wire — so it is the exact store that must never be accepted where a
   * device-safe one is asked for. It declares the capability `false`, which is
   * not assignable to the `true` {@link DeviceSafeKVStore} requires, so no cast
   * short of a hand-written lie can pass it there. `isLocalKVStore` stays for
   * the stronger "fully local" barrier a composite's injected device backend
   * demands.
   */
  readonly isLocalKVStore = false as const;
  readonly servesDeviceScopeLocally = false as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headersHook: HttpKVHeadersHook | undefined;
  private readonly credentials: RequestCredentials | undefined;

  constructor(options: HttpAccountKVOptions) {
    // Bind explicitly: browsers require fetch to be invoked with
    // `this === globalThis` (calling a stored reference as `this.fetchImpl(...)`
    // throws "Illegal invocation"), while node's undici does not care — which is
    // exactly why node-only test suites cannot catch the unbound form.
    // Validate BEFORE binding: .bind on a non-function throws a native
    // TypeError that would preempt the documented error below.
    const selectedFetch = options.fetch ?? globalThis.fetch;
    if (typeof selectedFetch !== 'function') {
      throw new Error('@openmaic/storage: HttpKVStore requires a fetch implementation');
    }
    this.baseUrl = assertHttpBaseUrl(options.baseUrl, 'HttpKVStore');
    this.fetchImpl = selectedFetch.bind(globalThis);
    this.headersHook = options.headers;
    this.credentials = options.credentials;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ body: T; status: number }> {
    const headers = normalizeHeaders(await this.headersHook?.({ method, path }));
    let serializedBody: string | undefined;
    if (body !== undefined) {
      // The body is JSON and nothing else, so a hook-supplied Content-Type is a
      // misconfiguration rather than a preference: the hook exists to attach
      // authentication headers, not to describe the body. Fail loud rather than
      // pick a winner.
      if (headers['content-type'] !== undefined) {
        throw new HttpKVStoreError(
          // No exchange happened, so there is no status to report.
          0,
          'CONTENT_TYPE_CONFLICT',
          '@openmaic/storage: the headers hook must not set Content-Type — KV request bodies ' +
            'are always application/json',
        );
      }
      headers['content-type'] = 'application/json';
      serializedBody = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(this.credentials === undefined ? {} : { credentials: this.credentials }),
      // Reads are never served from a cache. `account` values are exactly the
      // ones another device may have changed a moment ago, and this client has
      // no way to invalidate a cache entry when that happens — a cached read
      // would quietly serve the state this scope exists to move past.
      ...(method === 'GET' ? { cache: 'no-store' as RequestCache } : {}),
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    });
    if (!response.ok) {
      let errorBody: ErrorResponseBody | undefined;
      try {
        errorBody = (await response.json()) as ErrorResponseBody;
      } catch {
        // A non-conforming server still becomes a useful typed HTTP error.
      }
      const code = typeof errorBody?.error?.code === 'string' ? errorBody.error.code : 'HTTP_ERROR';
      const message =
        typeof errorBody?.error?.message === 'string'
          ? errorBody.error.message
          : `@openmaic/storage: KVStore HTTP request failed with status ${response.status}`;
      throw new HttpKVStoreError(response.status, code, message, errorBody?.error?.details);
    }
    if (response.status === 204) return { body: undefined as T, status: response.status };
    try {
      return { body: (await response.json()) as T, status: response.status };
    } catch {
      // A 2xx with an unparseable body is a broken response, not a native
      // SyntaxError for the caller to decode.
      throw new HttpKVStoreError(
        response.status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: KVStore HTTP response body was not valid JSON',
      );
    }
  }

  /** Read one account value, or `null` when the server holds no entry. */
  async get<T>(key: string, scope?: AccountScope): Promise<T | null> {
    assertAccountScope(scope);
    let response: { body: unknown; status: number };
    try {
      response = await this.request<unknown>('GET', `/kv/entries/${encodeKeyPathSegment(key)}`);
    } catch (error) {
      // Both conditions, deliberately. A proxy or gateway that answers 401, 403
      // or 500 while echoing the body's error code must not have that answer
      // read as "no such entry" — `null` is indistinguishable from a legitimate
      // miss, so an outage would look like data loss.
      if (
        error instanceof HttpKVStoreError &&
        error.status === 404 &&
        error.code === 'KEY_NOT_FOUND'
      ) {
        return null;
      }
      throw error;
    }
    const body = response.body;
    if (typeof body !== 'object' || body === null || !('value' in body)) {
      throw new HttpKVStoreError(
        response.status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: KVStore HTTP get response must be an object carrying "value"',
      );
    }
    return (body as { value: T | null }).value;
  }

  /** Write one account value. */
  async set<T>(key: string, value: T, scope?: AccountScope): Promise<void> {
    // Before anything else, including the delete-detection below: a device
    // write must fail, not quietly become a device delete.
    assertAccountScope(scope);
    // A value with no JSON representation at all (`undefined`, a function, a
    // symbol) is a removal, matching `BrowserKVStore`, which would otherwise
    // store the literal string "undefined" and throw on the next read.
    //
    // The test inspects the value directly instead of probing it with
    // `JSON.stringify`. A probe executes caller code (`toJSON`, getters), which
    // both undermines the JSON gate below — a stateful getter can show the probe
    // one value and the real serialization another — and quietly reclassifies
    // values the gate must reject, such as `{ toJSON: () => undefined }`, as
    // deletions.
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return this.remove(key);
    }
    assertJsonValue(value, `kv value for key ${JSON.stringify(key)}`);
    await this.request<void>('PUT', `/kv/entries/${encodeKeyPathSegment(key)}`, { value });
  }

  /** Delete one account value. Absent keys succeed. */
  async remove(key: string, scope?: AccountScope): Promise<void> {
    assertAccountScope(scope);
    await this.request<void>('DELETE', `/kv/entries/${encodeKeyPathSegment(key)}`);
  }

  /** List the account keys, optionally restricted to those under `prefix`. */
  async keys(prefix = '', scope?: AccountScope): Promise<string[]> {
    assertAccountScope(scope);
    const query = prefix === '' ? '' : `?prefix=${encodeComponent(prefix, 'kv key prefix')}`;
    const response = await this.request<unknown>('GET', `/kv/keys${query}`);
    if (!Array.isArray(response.body) || response.body.some((key) => typeof key !== 'string')) {
      throw new HttpKVStoreError(
        response.status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: KVStore HTTP keys response must be an array of strings',
      );
    }
    return response.body as string[];
  }
}

/**
 * `KVStore` over the HTTP contract for `account` values, with `device` values
 * served by the injected local backend.
 *
 * The split is the point. `account` is the scope a server-backed deployment
 * syncs across devices; `device` is machine-local state that must never leave
 * the machine. This class is the only place the two scopes are told apart, and
 * the only object it can reach the network through — {@link HttpAccountKV} —
 * cannot express a device request at all.
 */
export class HttpKVStore implements DeviceSafeKVStore {
  /**
   * Not fully local — its `account` scope goes to the network — so it still may
   * not be another composite's injected device backend, which demands a store
   * with no networked scope to route.
   */
  readonly isLocalKVStore = false as const;
  /**
   * But its `device` scope *does* stay local: it routes `device` to the
   * {@link LocalKVStore} required at construction and only ever reaches the
   * network for `account`. That is exactly the capability a caller needs to
   * persist `device`-scoped state, so this composite is safe to hand a `device`
   * scope even though it is not itself local. This is the distinction the guard
   * on {@link kvPersistStorage} turns on — and the one `HttpAccountKV`, which has
   * no local device backend, declares `false`.
   */
  readonly servesDeviceScopeLocally = true as const;
  private readonly account: HttpAccountKV;
  private readonly device: LocalKVStore;

  constructor(options: HttpKVStoreOptions) {
    const { deviceStore, ...accountOptions } = options;
    // The type already refuses a remote store here, but one `as` at a call site
    // would undo it — and what it would undo is the last thing standing between
    // a device value and the network. Check at runtime as well.
    if (
      deviceStore instanceof HttpAccountKV ||
      deviceStore instanceof HttpKVStore ||
      (deviceStore as LocalKVStore | undefined)?.isLocalKVStore !== true
    ) {
      throw new Error(
        '@openmaic/storage: HttpKVStore deviceStore must be a local KVStore (isLocalKVStore) — ' +
          'device values never leave the device, so a remote store cannot hold them',
      );
    }
    this.account = new HttpAccountKV(accountOptions);
    this.device = deviceStore;
  }

  /**
   * Route by scope, failing closed. An unknown scope is never folded into the
   * account path: that would send a value the caller believed was device-local
   * to a server, the single outcome this class exists to prevent.
   */
  private isDeviceScope(scope: KVScope): boolean {
    return assertKVScope(scope) === 'device';
  }

  async get<T>(key: string, scope: KVScope = DEFAULT_KV_SCOPE): Promise<T | null> {
    return this.isDeviceScope(scope) ? this.device.get<T>(key, 'device') : this.account.get<T>(key);
  }

  async set<T>(key: string, value: T, scope: KVScope = DEFAULT_KV_SCOPE): Promise<void> {
    return this.isDeviceScope(scope)
      ? this.device.set<T>(key, value, 'device')
      : this.account.set<T>(key, value);
  }

  async remove(key: string, scope: KVScope = DEFAULT_KV_SCOPE): Promise<void> {
    return this.isDeviceScope(scope) ? this.device.remove(key, 'device') : this.account.remove(key);
  }

  async keys(prefix = '', scope: KVScope = DEFAULT_KV_SCOPE): Promise<string[]> {
    return this.isDeviceScope(scope)
      ? this.device.keys(prefix, 'device')
      : this.account.keys(prefix);
  }
}
