/**
 * Host extension hooks: the host-facing surface.
 *
 * Registered once, from `instrumentation.ts` `register()`, next to the owner
 * authenticator:
 *
 * ```ts
 * const { configurePersistenceHooks, configureAssetByteStore } =
 *   await import('@/lib/server/persistence-hooks');
 * configurePersistenceHooks({ name: 'my-host', onCreate, library, beforeAssetAllocate });
 * configureAssetByteStore({ name: 'my-object-store', create, signsReadUrls: true });
 * ```
 *
 * Server-only. See `./types.ts` for what each hook is given and when it runs.
 */
export type {
  AssetAllocateRequest,
  AssetByteStoreContext,
  AssetByteStoreRegistration,
  BeforeAssetAllocate,
  CreateDecision,
  DocumentActor,
  DocumentCreateHook,
  LibraryListContext,
  LibraryProvider,
  PersistenceHooks,
  Queryable,
} from './types';
export { configureAssetByteStore, configurePersistenceHooks } from './registry';
