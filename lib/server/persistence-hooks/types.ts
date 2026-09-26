/**
 * Host extension hooks for server persistence.
 *
 * Four points where a host adds product behavior without forking a route:
 *
 * - {@link PersistenceHooks.authorizeCreate} / {@link PersistenceHooks.onCreate}:
 *   refuse, or add side effects to, the creation of a course, inside the
 *   transaction that creates it.
 * - {@link LibraryProvider}: which courses `GET /api/stages` lists.
 * - {@link BeforeAssetAllocate}: refuse an asset upload before anything is
 *   stored or counted against a quota.
 * - {@link AssetByteStoreRegistration}: the byte layer asset bytes live in, for
 *   the request path and the offline collector alike.
 *
 * All of them are registered once, at server bootstrap, from
 * `instrumentation.ts` `register()` (see `./registry.ts`). With nothing
 * registered, every point behaves exactly as it did before the hook existed.
 */
import type { AssetByteStore } from '@openmaic/storage/asset/pg';
import type { Queryable } from '@openmaic/storage/document/pg';

import type { OwnerPrincipal } from '@/lib/server/identity/types';

export type { Queryable };

/**
 * Who a document write is performed for. Discriminated by `source`, so a hook
 * cannot mistake one kind of write for the other:
 *
 * - `'request'`: a request-driven write (`/api/persistence`, `/api/stages`).
 *   `principal` is what the owner identity seam resolved for that request.
 * - `'background'`: an agent run writing on the owner's behalf after the
 *   request that started it has ended. A run records only the owner id, so
 *   there is no principal, and the hooks never re-derive one. It is not a
 *   trusted or internal caller: the owner started it, and a policy that
 *   limits what an owner may create must apply to it as well.
 *
 * `ownerId` is always the owner the course is created under.
 */
export type DocumentActor =
  | {
      readonly source: 'request';
      readonly ownerId: string;
      readonly principal: OwnerPrincipal;
    }
  | {
      readonly source: 'background';
      readonly ownerId: string;
      readonly principal?: undefined;
    };

/** The answer of {@link PersistenceHooks.authorizeCreate}. */
export type CreateDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      /** Shown to the client in the `403 CREATE_REFUSED` error body. */
      readonly message?: string;
    };

/**
 * Called inside the transaction that creates a course. `tx` is that
 * transaction: statements on it commit or roll back with the course.
 */
export type DocumentCreateHook<T> = (
  tx: Queryable,
  actor: DocumentActor,
  stageId: string,
) => Promise<T>;

/** What {@link LibraryProvider.list} is given. */
export interface LibraryListContext {
  readonly principal: OwnerPrincipal;
  /** A pooled connection for the provider's own reads. Not a transaction. */
  readonly queryable: Queryable;
  /** The default listing: the ids of the principal's own live courses. */
  ownedStageIds(): Promise<string[]>;
}

/**
 * Which courses `GET /api/stages` lists for a principal.
 *
 * The provider chooses ids; it does not build list items. The route turns the
 * ids into the same `DocumentSummary` items it has always returned, in the
 * order the provider gave (duplicates keep their first position), and drops
 * every id the document read path would refuse -- one without an ownership
 * row, or a deleted course. A provider therefore cannot make a course appear
 * that `GET /api/stages/{id}` would not serve. `folderId` is reported only for
 * the principal's own courses: another owner's folder means nothing here.
 *
 * Reads are capability-by-id, so listing an id is handing it out: a provider
 * lists another owner's course only when the principal is entitled to know
 * the id (it saved it, it was shared with it). That decision is the host's.
 */
export interface LibraryProvider {
  /** Short label for logs and boot errors. */
  readonly name: string;
  list(context: LibraryListContext): Promise<readonly string[]>;
}

/**
 * An upload {@link BeforeAssetAllocate} is asked about. No body.
 *
 * `operation` and `assetId` are the storage handler's own routing decision,
 * made on the decoded path it serves; base a policy on them rather than on
 * matching `url`, whose spelling the handler normalizes.
 */
export interface AssetAllocateRequest {
  /** `create`: `POST /assets`. `replace`: `PUT /assets/{id}/content`. */
  readonly operation: 'create' | 'replace';
  /** The asset being replaced, decoded as the handler decodes it. Only on `replace`. */
  readonly assetId?: string;
  readonly method: string;
  /** The request URL as received, for logging. */
  readonly url: string;
  readonly headers: Headers;
}

/**
 * Called for every request that stores asset bytes over
 * `/api/persistence/assets` -- an allocation (`POST /assets`) or a replace
 * (`PUT /assets/{id}/content`) -- after the owner is resolved and before the
 * upload body is read: no bytes are stored and no quota is counted yet.
 * Resolve `undefined` to let the upload proceed, or a `Response` to answer the
 * request with it instead.
 *
 * Scope: HTTP uploads. Media an agent run generates on the server (images,
 * videos) is stored by the run directly; it is bounded by the per-owner quota
 * and by which generation tools the deployment enables, not by this hook.
 */
export type BeforeAssetAllocate = (
  principal: OwnerPrincipal,
  req: AssetAllocateRequest,
) => Promise<Response | undefined>;

/** The hooks {@link configurePersistenceHooks} registers. Every hook is optional. */
export interface PersistenceHooks {
  /** Short label for logs and boot errors. */
  readonly name: string;
  /**
   * May this actor create this course? Called once per created course, inside
   * the create transaction, after the course rows are written and before
   * {@link onCreate}. A refusal rolls the transaction back and answers
   * `403 CREATE_REFUSED`.
   */
  readonly authorizeCreate?: DocumentCreateHook<CreateDecision>;
  /**
   * Side effects that must exist exactly when the course does. Called once per
   * created course, inside the create transaction, after
   * {@link authorizeCreate} allowed it. A throw rolls the whole create back.
   */
  readonly onCreate?: DocumentCreateHook<void>;
  readonly library?: LibraryProvider;
  readonly beforeAssetAllocate?: BeforeAssetAllocate;
}

/** What {@link AssetByteStoreRegistration.create} is given. */
export interface AssetByteStoreContext {
  /** The caller's database connection (the request pool, or the collector's own). */
  readonly queryable: Queryable;
}

/**
 * The byte layer asset bytes live in, replacing the built-in choice
 * (`ASSET_S3_BUCKET` set: S3; unset: a PostgreSQL column).
 *
 * `create` is called lazily, by the persistence request path and by the
 * offline collector, each with its own connection; both always use this one
 * registration, so the collector deletes through the layer the route wrote
 * through. A failed `create` fails asset requests only, and is retried on the
 * next one.
 *
 * The store must keep its bytes outside the registry's PostgreSQL and say so
 * with `writesOutsideRegistryDatabase: true` (see `AssetByteStore` in
 * `@openmaic/storage`). The flag is trusted, not checked: a store that sets it
 * but writes through the registry database can deadlock the registry's write
 * transaction. An in-database byte layer is the built-in default and cannot be
 * registered.
 */
export interface AssetByteStoreRegistration {
  /** Short label for logs and boot errors. */
  readonly name: string;
  create(context: AssetByteStoreContext): AssetByteStore | Promise<AssetByteStore>;
  /**
   * Whether the stores `create` returns implement `signReadUrl`. Required for
   * `ASSET_BYTE_EGRESS=redirect`, which is refused at boot without it. A store
   * that declares it but cannot sign is logged and served with direct bytes;
   * the collector never signs.
   */
  readonly signsReadUrls?: boolean;
}
