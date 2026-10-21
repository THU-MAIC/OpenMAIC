/**
 * The one way this app writes material reference roots.
 *
 * `changeAssetRoots` (`@openmaic/storage/asset/pg`) runs in the caller's
 * transaction and leaves three things to the caller (see the docstring of
 * `packages/@openmaic/storage/src/asset/roots.ts`): the order its locks are
 * taken in, how often it is called, and which principals it is given. This
 * wrapper takes all three out of the caller's hands, so they hold by
 * construction rather than by a comment at every call site:
 *
 * - **Order.** It opens the transaction itself, takes the owner's write fence,
 *   then locks every material row the change concerns in ONE ascending
 *   `SELECT ... FOR UPDATE`, and only then runs `body`. That is the order in
 *   which a root write, an owner claim (which takes the identity lock
 *   exclusively, then the material rows, then the entries) and the collector
 *   (entries only) cannot wait on each other in a cycle.
 * - **Once per transaction.** `changeRoots` may be called at most once, and
 *   only while `body` runs. A second call would lock entries in a second
 *   ascending statement, which can deadlock another writer.
 * - **The owner's own partition.** The principals are always exactly the
 *   owner's own partition, never the legacy shared one: the asset layer cannot
 *   tell whose a root is, so a root on a shared entry would belong to no owner
 *   anyone could attribute. Library assets live in their owner's partition.
 *
 * `fence: 'request'` refuses a retired owner (`fenceOwnerWrite`); a write on
 * behalf of a request uses it. `fence: 'background'` follows a claim to the
 * account (`forwardOwnerWrite`); work that started before a claim, and cleanup
 * of rows a claim may have moved, use it. `scope.ownerId` is the owner the
 * write is for after the fence.
 */
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';
import { changeAssetRoots } from '@openmaic/storage/asset/pg';
import { assetPrincipalForOwner } from './owner-assets';
import { fenceOwnerWrite, forwardOwnerWrite } from './owner-merges';

/** The root kind of a library material; the root id is the material id. */
export const MATERIAL_ROOT_KIND = 'material';

/** The assets one material's root is to hold, or stop holding. */
export interface MaterialRootAssets {
  materialId: string;
  assetIds: readonly string[];
}

export interface MaterialRootChange {
  add?: readonly MaterialRootAssets[];
  remove?: readonly MaterialRootAssets[];
}

export interface MaterialRootScope {
  /** The open transaction; the fence and the material row locks are held. */
  tx: Queryable;
  /** The owner the write is for, after the fence. */
  ownerId: string;
  /** Add and remove material roots. At most once, and only inside `body`. */
  changeRoots(change: MaterialRootChange): Promise<void>;
}

export interface MaterialRootTransaction {
  ownerId: string;
  fence: 'request' | 'background';
  /** Every material row the change concerns; locked before `body` runs. */
  materialIds: readonly string[];
}

/** Thrown when `changeRoots` is called a second time, or after `body` ended. */
export class MaterialRootCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterialRootCallError';
  }
}

function toRootChanges(changes: readonly MaterialRootAssets[] | undefined) {
  return (changes ?? []).map((change) => ({
    rootKind: MATERIAL_ROOT_KIND,
    rootId: change.materialId,
    assetIds: change.assetIds,
  }));
}

/**
 * Run `body` in a transaction that holds the owner's fence and the locks of
 * `materialIds`, with a `changeRoots` that may be called once. Any throw rolls
 * the whole transaction back.
 */
export async function withMaterialRoots<T>(
  provider: { withTransaction: WithTransaction },
  input: MaterialRootTransaction,
  body: (scope: MaterialRootScope) => Promise<T>,
): Promise<T> {
  return provider.withTransaction(async (tx) => {
    let ownerId = input.ownerId;
    if (input.fence === 'request') await fenceOwnerWrite(tx, ownerId);
    else ownerId = await forwardOwnerWrite(tx, ownerId);
    await tx.query(
      'SELECT id FROM owner_material WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
      [[...input.materialIds]],
    );

    let state: 'open' | 'used' | 'closed' = 'open';
    // The one root call, once started. The transaction does not end before it
    // has: a body that fails without awaiting it (a refused second call inside
    // `Promise.all`, say) would otherwise roll back while its statements are
    // still queued, and they would then run outside any transaction.
    let started: Promise<void> | undefined;
    const scope: MaterialRootScope = {
      tx,
      ownerId,
      changeRoots(change) {
        if (state === 'used') {
          return Promise.reject(
            new MaterialRootCallError('changeRoots may be called once per transaction'),
          );
        }
        if (state === 'closed') {
          return Promise.reject(
            new MaterialRootCallError('changeRoots called after its transaction ended'),
          );
        }
        state = 'used';
        started = changeAssetRoots(tx, {
          add: toRootChanges(change.add),
          remove: toRootChanges(change.remove),
          principals: [assetPrincipalForOwner(ownerId).key],
        });
        // Observed at once: a body still awaiting something else when this
        // fails must not turn it into an unhandled rejection. The failure is
        // not swallowed -- the `await started` below rethrows it and rolls back.
        started.catch(() => undefined);
        return started;
      },
    };
    let result: T;
    try {
      result = await body(scope);
    } catch (error) {
      // Settle the root call first, then roll back with the body's own error.
      await started?.catch(() => undefined);
      throw error;
    } finally {
      state = 'closed';
    }
    // A body that returned without awaiting the root call still commits only
    // once it has finished, and rolls back if it failed.
    await started;
    return result;
  });
}
