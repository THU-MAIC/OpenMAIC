/**
 * KV scope. `account` values are user/account data that a server-backed
 * deployment syncs across devices (provider/model config, profile). `device`
 * values are machine-local UI state (theme, locale, layout) that must never
 * leave the device — every backend honours that, so a `device` write stays
 * local even when `account` writes go to a server.
 */
export type KVScope = 'device' | 'account';

/**
 * Small keyed values not owned by the DSL. The scope defaults to `account`;
 * pass `device` for machine-local preferences. Values must be JSON-serializable
 * — the store owns (de)serialization so callers pass and receive plain values.
 */
export interface KVStore {
  get<T>(key: string, scope?: KVScope): Promise<T | null>;
  set<T>(key: string, value: T, scope?: KVScope): Promise<void>;
  remove(key: string, scope?: KVScope): Promise<void>;
  keys(prefix?: string, scope?: KVScope): Promise<string[]>;
}

/**
 * A `KVStore` whose `device` scope never leaves the device.
 *
 * This is the capability that actually matters when a caller wants to persist
 * `device`-scoped state: not "is the whole store local", but "does a `device`
 * write stay on this machine". Two kinds of store honour it — one that is
 * entirely local, and a composite that routes `device` to a local backend while
 * sending `account` to a server — and both are safe to hand a `device` scope.
 *
 * The brand exists because `KVStore` alone cannot express it. A remote store
 * structurally satisfies `KVStore` — that is the point of the interface — so a
 * `KVStore`-typed parameter asking for a device-safe store would happily accept
 * a pure network transport, and the device-never-leaves-the-device invariant
 * would rest on the caller's good intentions. A store that does *not* keep
 * `device` local cannot acquire this brand by accident: the account-only
 * transport declares itself `false`, which is not assignable to the `true` this
 * requires, so claiming the capability would mean writing the lie out by hand.
 */
export interface DeviceSafeKVStore extends KVStore {
  readonly servesDeviceScopeLocally: true;
}

/**
 * A `KVStore` that keeps *every* value on the machine it runs on — strictly
 * stronger than {@link DeviceSafeKVStore}, which only promises it for `device`.
 *
 * This is what a composite store demands of the backend it injects for the
 * `device` scope: that backend has no second, networked scope to route
 * elsewhere, so nothing it holds can leave. A device-safe composite would not
 * do — nesting one inside another is a loop of routers with no local floor.
 */
export interface LocalKVStore extends DeviceSafeKVStore {
  readonly isLocalKVStore: true;
}

/** The default scope used when a caller omits one. */
export const DEFAULT_KV_SCOPE: KVScope = 'account';

/**
 * A scope a store was asked to serve and cannot. Its own class because the two
 * cases it covers are refusals to route data, not transport failures: an
 * unrecognized scope, and a `device` scope handed to a backend that only serves
 * `account`.
 */
export class KVScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KVScopeViolationError';
  }
}

/**
 * Narrow an untrusted scope to the two the primitive defines, failing closed.
 *
 * Scopes reach backends as ordinary values (the zustand adapter passes one
 * straight through), so a typo like `'Device'` is a runtime possibility even
 * though the type forbids it. Backends must not guess: treating "not `device`"
 * as `account` sends a mistyped device write to a server, and treating "not
 * `account`" as `device` silently strands account data. Both failure modes are
 * worse than throwing.
 */
export function assertKVScope(scope: KVScope): KVScope {
  switch (scope) {
    case 'device':
    case 'account':
      return scope;
    default:
      throw new KVScopeViolationError(
        `@openmaic/storage: unknown KV scope ${JSON.stringify(scope as string)}`,
      );
  }
}

/**
 * The key domain is **truly opaque and unconstrained** — a KV key is any string.
 *
 * This is deliberately *not* validated. Callers compose keys from unconstrained
 * DSL identifiers (a `stageId` is any string), and the browser primitive is a
 * `Map` / `Storage`, which stores any string key of any length, containing any
 * character — NUL, separators, whatever. Adding a transport-driven rule here
 * (a length cap, a `/` ban, a NUL ban) reaches back into that primitive and
 * makes a previously storable key unreadable, which is the bug this package
 * kept reintroducing. So there is no key validator, and no `assertKVKey`.
 *
 * What a key can and cannot *travel over* is a property of the transport, not of
 * the key. The browser backend uses no transport and imposes nothing. The HTTP
 * backend carries a key as a URL path segment, so it inherits that transport's
 * limits — a deployment's URL/header size ceiling, URL path normalization of a
 * whole-key `.` / `..`, and the one character a percent-encoder cannot represent
 * (an unpaired UTF-16 surrogate). Those live in `HttpAccountKV`, are documented
 * as HTTP-deployment concerns, and never constrain the key domain: a key is
 * *valid* on both backends identically (both accept it), even where it is not
 * *reachable* over one transport. Scope, by contrast, is a fixed two-value axis
 * of the primitive, not an opaque string, so it is still narrowed (see
 * `assertKVScope`).
 */
