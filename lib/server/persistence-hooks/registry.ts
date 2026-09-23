import { configuredAssetByteEgress } from '@/lib/persistence/asset-byte-egress';

import type { AssetByteStoreRegistration, LibraryProvider, PersistenceHooks } from './types';

/**
 * The process-wide host extension hooks, registered the way the owner
 * authenticator is (`lib/server/identity/registry.ts`): once, from
 * `instrumentation.ts` `register()`, before the server serves a request.
 *
 * Two entry points, because they are consumed by different layers and sealed
 * at different moments: {@link configurePersistenceHooks} (course creation,
 * the library listing, upload admission) is sealed by the first request that
 * reads the hooks, and {@link configureAssetByteStore} by the first byte store
 * built -- the persistence provider's, or the collector's. Configuring either
 * after its first use throws: a process must not serve some requests with a
 * hook and others without.
 *
 * The state lives on `globalThis` because Next can evaluate this module more
 * than once in one process (the instrumentation hook and route bundles), and
 * all of them must see the one registration.
 */

interface RegistryState {
  hooks?: PersistenceHooks;
  hooksInUse?: boolean;
  byteStore?: AssetByteStoreRegistration;
  byteStoreInUse?: boolean;
}

const REGISTRY_KEY = Symbol.for('openmaic.persistence-hooks.registry');
const globalState = globalThis as typeof globalThis & { [REGISTRY_KEY]?: RegistryState };
function registry(): RegistryState {
  return (globalState[REGISTRY_KEY] ??= {});
}

const NO_HOOKS: PersistenceHooks = Object.freeze({ name: 'default' });

function assertServer(entryPoint: string): void {
  if (typeof window !== 'undefined') throw new Error(`${entryPoint} is server-only`);
}

function isOptionalFunction(value: unknown): boolean {
  return value === undefined || typeof value === 'function';
}

const HOOK_KEYS = ['name', 'authorizeCreate', 'onCreate', 'library', 'beforeAssetAllocate'];
const BYTE_STORE_KEYS = ['name', 'create', 'signsReadUrls'];

/** Levenshtein distance, for the "did you mean" hint. Keys are short. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The first key of `target` that is not a known key, if any.
 *
 * Every hook is optional, so a misspelled one (`authorizeCreat`) would
 * otherwise register cleanly and never run -- for a gate, a silent bypass.
 *
 * - A plain object may carry nothing but known keys.
 * - A class instance legitimately carries state, so only its function-valued
 *   properties are checked: its own and those of its prototype chain up to
 *   `Object.prototype`, excluding `constructor`. A helper method is
 *   indistinguishable from a misspelled hook, so a host class must keep
 *   helpers private (`#helper`), non-function, or pass a plain object.
 */
function unknownKey(target: object, known: readonly string[]): string | undefined {
  const knownKeys = new Set(known);
  const prototype: unknown = Object.getPrototypeOf(target);
  if (prototype === Object.prototype || prototype === null) {
    return Object.keys(target).find((key) => !knownKeys.has(key));
  }
  for (
    let level: object | null = target;
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(level)) {
      if (key === 'constructor' || knownKeys.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(level, key);
      if (typeof descriptor?.value === 'function') return key;
    }
  }
  return undefined;
}

function unknownKeyMessage(key: string, known: readonly string[], kind: string): string {
  const suggestion = known.find((candidate) => editDistance(key, candidate) <= 2);
  return (
    `does not know the ${kind} ${JSON.stringify(key)}` +
    (suggestion ? ` (did you mean ${JSON.stringify(suggestion)}?)` : '') +
    '. A host class must keep helper methods private (#method) or non-function, ' +
    'or register a plain object.'
  );
}

/**
 * A method of `owner`, bound to it, or `undefined`. Read once, through normal
 * property access, so a hook defined on a class prototype -- or as a
 * non-enumerable property -- is kept: copying with `{ ...owner }` takes only
 * own enumerable properties and would silently drop it, and with it a gate
 * such as `authorizeCreate`.
 */
function boundMethod<T>(owner: object, value: unknown): T | undefined {
  return typeof value === 'function' ? (value.bind(owner) as T) : undefined;
}

/** One read of every hook, so what is validated is exactly what is stored. */
interface HooksSnapshot {
  name: unknown;
  authorizeCreate: unknown;
  onCreate: unknown;
  beforeAssetAllocate: unknown;
  library: unknown;
  libraryName: unknown;
  libraryList: unknown;
}

function snapshotHooks(hooks: PersistenceHooks): HooksSnapshot | undefined {
  if (!hooks || typeof hooks !== 'object') return undefined;
  const library: unknown = hooks.library;
  const libraryObject =
    library && typeof library === 'object' ? (library as LibraryProvider) : undefined;
  return {
    name: hooks.name,
    authorizeCreate: hooks.authorizeCreate,
    onCreate: hooks.onCreate,
    beforeAssetAllocate: hooks.beforeAssetAllocate,
    library,
    libraryName: libraryObject?.name,
    libraryList: libraryObject?.list,
  };
}

function describeHooksProblem(
  hooks: PersistenceHooks,
  snapshot: HooksSnapshot | undefined,
): string | undefined {
  if (!snapshot) return 'expects an object';
  if (typeof snapshot.name !== 'string' || !snapshot.name) return 'expects a non-empty name';
  // A misspelled hook is reported rather than silently never called.
  const unknown = unknownKey(hooks, HOOK_KEYS);
  if (unknown !== undefined) return unknownKeyMessage(unknown, HOOK_KEYS, 'hook');
  if (!isOptionalFunction(snapshot.authorizeCreate)) {
    return 'expects authorizeCreate to be a function';
  }
  if (!isOptionalFunction(snapshot.onCreate)) return 'expects onCreate to be a function';
  if (!isOptionalFunction(snapshot.beforeAssetAllocate)) {
    return 'expects beforeAssetAllocate to be a function';
  }
  if (
    snapshot.library !== undefined &&
    (typeof snapshot.library !== 'object' ||
      snapshot.library === null ||
      typeof snapshot.libraryName !== 'string' ||
      !snapshot.libraryName ||
      typeof snapshot.libraryList !== 'function')
  ) {
    return 'expects library to be { name, list(context) }';
  }
  return undefined;
}

/**
 * Register the process-wide persistence hooks. Server-only and single-shot:
 * call it once from `instrumentation.ts` `register()`. Throws -- failing the
 * boot -- when called twice, after the hooks were first read, or with a value
 * that is not a {@link PersistenceHooks} (including an unknown hook name, so a
 * misspelled hook is reported rather than silently never called).
 */
export function configurePersistenceHooks(hooks: PersistenceHooks): void {
  assertServer('configurePersistenceHooks');
  const state = registry();
  if (state.hooks) {
    throw new Error(
      `Persistence hooks are already configured (${state.hooks.name}); ` +
        'configurePersistenceHooks may be called once per process.',
    );
  }
  if (state.hooksInUse) {
    throw new Error(
      'configurePersistenceHooks was called after persistence started using hooks. Call it from ' +
        'instrumentation.ts register(), before the server serves a request.',
    );
  }
  const snapshot = snapshotHooks(hooks);
  const problem = describeHooksProblem(hooks, snapshot);
  if (problem || !snapshot) throw new Error(`configurePersistenceHooks ${problem}`);
  // Each hook was read exactly once, above, and is bound to the object the
  // host passed: what was validated is what runs, whether the host wrote a
  // plain object or a class instance.
  const library = snapshot.library as object | undefined;
  const stored: PersistenceHooks = {
    name: snapshot.name as string,
    authorizeCreate: boundMethod(hooks, snapshot.authorizeCreate),
    onCreate: boundMethod(hooks, snapshot.onCreate),
    beforeAssetAllocate: boundMethod(hooks, snapshot.beforeAssetAllocate),
    library: library
      ? Object.freeze({
          name: snapshot.libraryName as string,
          list: boundMethod<LibraryProvider['list']>(library, snapshot.libraryList)!,
        })
      : undefined,
  };
  state.hooks = Object.freeze(stored);
}

/** The registered hooks, or none. Reading them seals the registration. */
export function getPersistenceHooks(): PersistenceHooks {
  const state = registry();
  state.hooksInUse = true;
  return state.hooks ?? NO_HOOKS;
}

/**
 * Register the process-wide asset byte store. Server-only and single-shot,
 * like {@link configurePersistenceHooks}. Also throws while `ASSET_S3_BUCKET`
 * is set: that variable selects the built-in S3 layer this call replaces, and
 * accepting both would silently ignore one of them.
 */
export function configureAssetByteStore(registration: AssetByteStoreRegistration): void {
  assertServer('configureAssetByteStore');
  const state = registry();
  if (state.byteStore) {
    throw new Error(
      `An asset byte store is already configured (${state.byteStore.name}); ` +
        'configureAssetByteStore may be called once per process.',
    );
  }
  if (state.byteStoreInUse) {
    throw new Error(
      'configureAssetByteStore was called after an asset byte store was built. Call it from ' +
        'instrumentation.ts register(), before the server serves a request.',
    );
  }
  const name: unknown =
    registration && typeof registration === 'object' ? registration.name : undefined;
  const create: unknown =
    registration && typeof registration === 'object' ? registration.create : undefined;
  const signsReadUrls: unknown =
    registration && typeof registration === 'object' ? registration.signsReadUrls : undefined;
  if (
    typeof name !== 'string' ||
    !name ||
    typeof create !== 'function' ||
    (signsReadUrls !== undefined && typeof signsReadUrls !== 'boolean')
  ) {
    throw new Error(
      'configureAssetByteStore expects { name, create(context), signsReadUrls?: boolean }',
    );
  }
  const unknown = unknownKey(registration, BYTE_STORE_KEYS);
  if (unknown !== undefined) {
    throw new Error(
      `configureAssetByteStore ${unknownKeyMessage(unknown, BYTE_STORE_KEYS, 'key')}`,
    );
  }
  if (process.env.ASSET_S3_BUCKET?.trim()) {
    throw new Error(
      'ASSET_S3_BUCKET selects the built-in S3 byte store and cannot be combined with a ' +
        `configured asset byte store (${name}). Unset it.`,
    );
  }
  // Read once and bound, for the same reason as the persistence hooks.
  state.byteStore = Object.freeze({
    name,
    create: boundMethod<AssetByteStoreRegistration['create']>(registration, create)!,
    ...(signsReadUrls === undefined ? {} : { signsReadUrls: signsReadUrls as boolean }),
  });
}

/**
 * The registered byte store, or `undefined` for the built-in choice. Reading
 * it seals the registration; only the byte store factory in
 * `lib/persistence/asset-byte-store.ts` calls this.
 */
export function getAssetByteStoreRegistration(): AssetByteStoreRegistration | undefined {
  const state = registry();
  state.byteStoreInUse = true;
  return state.byteStore;
}

/**
 * Boot-time validation, called from `instrumentation.ts` after the host has
 * registered. Does not seal anything. Throws when:
 *
 * - `ASSET_S3_BUCKET` is set beside a configured byte store (set after
 *   registration, so the registration-time check could not see it);
 * - `ASSET_BYTE_EGRESS=redirect` is set and the configured byte store does not
 *   declare `signsReadUrls`. The built-in layers keep their behavior (the
 *   PostgreSQL column falls back to direct bytes), but a host store that
 *   cannot sign would otherwise be discovered only when the first read found
 *   no signer, so it stops the server instead.
 */
export function validatePersistenceHooksConfiguration(): void {
  const byteStore = registry().byteStore;
  if (!byteStore) return;
  if (process.env.ASSET_S3_BUCKET?.trim()) {
    throw new Error(
      `ASSET_S3_BUCKET cannot be combined with a configured asset byte store (${byteStore.name}).`,
    );
  }
  if (
    configuredAssetByteEgress(process.env.ASSET_BYTE_EGRESS) === 'redirect' &&
    byteStore.signsReadUrls !== true
  ) {
    throw new Error(
      `ASSET_BYTE_EGRESS=redirect requires a byte store that signs read URLs, and the configured ` +
        `asset byte store (${byteStore.name}) does not declare signsReadUrls: true. Unset ` +
        'ASSET_BYTE_EGRESS or register a store that implements signReadUrl.',
    );
  }
}

export function resetPersistenceHooksForTests(): void {
  delete globalState[REGISTRY_KEY];
}
