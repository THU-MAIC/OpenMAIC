import type {
  DocumentFolderStore,
  DocumentStore,
  StageFreshnessManifestStore,
} from '@openmaic/storage';

import { withPlainJsonDocumentWrites } from '@/lib/document-store/plain-json-store';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { canonicalizeOwner, isOwnerRetiredError } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import type { AppScene } from '@/lib/types/stage';
import type { Queryable } from '@openmaic/storage/document/pg';

/**
 * The owner-bound document store for one HTTP request, plus the
 * trigger-maintained freshness manifest read the PG backend provides.
 */
export type OwnerScopedDocumentStore = DocumentStore<AppScene, AppStage> &
  DocumentFolderStore &
  StageFreshnessManifestStore;

/**
 * The owner-bound document store for one HTTP request.
 *
 * This is the exact seam the agent runner uses (`runner.ts`): the document
 * provider is bound to the resolved owner through the stage access layer.
 * Reads are capability-by-id, writes and listings are owner-only, and every
 * operation re-checks `stage_meta` inside its transaction. A browser holding a
 * course id may therefore read it without gaining mutation authority.
 * `withPlainJsonDocumentWrites` keeps the write
 * boundary identical to the agent tools' (undefined-valued members are never
 * persisted as JSON nulls).
 */
export async function getOwnerScopedDocumentStore(
  owner: string | OwnerPrincipal,
  mutationFence?: (queryable: Queryable) => Promise<void>,
): Promise<OwnerScopedDocumentStore> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return ownerBoundStore(
    pool,
    owner,
    mutationFence,
  )(typeof owner === 'string' ? owner : owner.ownerId);
}

function ownerBoundStore(
  pool: Awaited<ReturnType<typeof getServerPersistenceProvider>>['pool'],
  owner: string | OwnerPrincipal,
  mutationFence?: (queryable: Queryable) => Promise<void>,
): (ownerId: string) => OwnerScopedDocumentStore {
  // A request passes its resolved principal, so the host create hooks see it;
  // a background run knows only the owner id.
  const principal = typeof owner === 'string' ? undefined : owner;
  return (ownerId) =>
    withPlainJsonDocumentWrites(
      createOwnerBoundDocumentStore<AppScene, AppStage>({
        pool,
        ownerId,
        ...(principal ? { principal } : {}),
        validateScene: validateAppScene,
        validateStage: validateAppStage,
        mutationFence,
      }) as unknown as OwnerScopedDocumentStore,
    );
}

/**
 * The document store of background work (an agent run) for the owner id it
 * recorded: {@link getOwnerScopedDocumentStore}, following the owner forward
 * when a claim retires it mid-run (see {@link forwardingDocumentStore}).
 * Request handlers use {@link getOwnerScopedDocumentStore}: a request that
 * still presents a retired identity is refused, never forwarded.
 */
export async function getBackgroundDocumentStore(
  storedOwnerId: string,
  mutationFence?: (queryable: Queryable) => Promise<void>,
): Promise<OwnerScopedDocumentStore> {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return forwardingDocumentStore(
    storedOwnerId,
    ownerBoundStore(pool, storedOwnerId, mutationFence),
    pool as unknown as Queryable,
  );
}

/**
 * A background run's store: bound to whatever owner its stored owner id is
 * now. A claim can retire the run's owner while the run is going (a visitor
 * signs in while their course generates); the run then keeps working for the
 * account the work was claimed into, instead of writing under a retired id
 * (which the write fence refuses) or losing access to the courses that moved.
 *
 * Every call canonicalizes the owner first (one indexed lookup) and uses the
 * store bound to the result. The fence inside the write transaction is what is
 * exact: a claim that commits between the lookup and the write makes the
 * write fail as retired, and the call is retried once on the new owner.
 */
function forwardingDocumentStore(
  storedOwnerId: string,
  build: (ownerId: string) => OwnerScopedDocumentStore,
  queryable: Queryable,
): OwnerScopedDocumentStore {
  let bound = { ownerId: storedOwnerId, store: build(storedOwnerId) };
  const current = async (): Promise<OwnerScopedDocumentStore> => {
    const ownerId = await canonicalizeOwner(queryable, storedOwnerId);
    if (ownerId !== bound.ownerId) bound = { ownerId, store: build(ownerId) };
    return bound.store;
  };
  return new Proxy({} as OwnerScopedDocumentStore, {
    get(_target, property) {
      // Not a thenable: `await store` must yield the store, not call `then`.
      if (typeof property !== 'string' || property === 'then') return undefined;
      // Only methods are forwarded (and re-resolved per call); anything else
      // is read from the store bound now, as it is.
      const value = (bound.store as unknown as Record<string, unknown>)[property];
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const invoke = (store: OwnerScopedDocumentStore) => {
          const method = (store as unknown as Record<string, unknown>)[property];
          if (typeof method !== 'function') {
            throw new TypeError(`owner-scoped document store has no method ${property}`);
          }
          return (method as (...values: unknown[]) => Promise<unknown>).apply(store, args);
        };
        const first = await current();
        try {
          return await invoke(first);
        } catch (error) {
          if (!isOwnerRetiredError(error)) throw error;
          const next = await current();
          if (next === first) throw error;
          return invoke(next);
        }
      };
    },
  });
}
