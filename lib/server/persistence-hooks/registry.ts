import { configuredAssetByteEgress } from '@/lib/persistence/asset-byte-egress';

import type { AssetByteStoreRegistration, PersistenceHooks } from './types';

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

function describeHooksProblem(hooks: PersistenceHooks): string | undefined {
  if (!hooks || typeof hooks !== 'object') return 'expects an object';
  if (typeof hooks.name !== 'string' || !hooks.name) return 'expects a non-empty name';
  const known = new Set(['name', 'authorizeCreate', 'onCreate', 'library', 'beforeAssetAllocate']);
  const unknown = Object.keys(hooks).find((key) => !known.has(key));
  if (unknown !== undefined) return `does not know the hook ${JSON.stringify(unknown)}`;
  if (!isOptionalFunction(hooks.authorizeCreate)) return 'expects authorizeCreate to be a function';
  if (!isOptionalFunction(hooks.onCreate)) return 'expects onCreate to be a function';
  if (!isOptionalFunction(hooks.beforeAssetAllocate)) {
    return 'expects beforeAssetAllocate to be a function';
  }
  const library = hooks.library;
  if (
    library !== undefined &&
    (!library ||
      typeof library !== 'object' ||
      typeof library.name !== 'string' ||
      !library.name ||
      typeof library.list !== 'function')
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
  const problem = describeHooksProblem(hooks);
  if (problem) throw new Error(`configurePersistenceHooks ${problem}`);
  state.hooks = Object.freeze({ ...hooks });
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
  if (
    !registration ||
    typeof registration !== 'object' ||
    typeof registration.name !== 'string' ||
    !registration.name ||
    typeof registration.create !== 'function' ||
    (registration.signsReadUrls !== undefined && typeof registration.signsReadUrls !== 'boolean')
  ) {
    throw new Error(
      'configureAssetByteStore expects { name, create(context), signsReadUrls?: boolean }',
    );
  }
  if (process.env.ASSET_S3_BUCKET?.trim()) {
    throw new Error(
      'ASSET_S3_BUCKET selects the built-in S3 byte store and cannot be combined with a ' +
        `configured asset byte store (${registration.name}). Unset it.`,
    );
  }
  state.byteStore = Object.freeze({ ...registration });
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
