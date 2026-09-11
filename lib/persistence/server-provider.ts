import { PgAssetStore, ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { PgDocumentStore, ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { PgRuntimeStore, ensureSchema } from '@openmaic/storage/runtime/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';
import { Pool } from 'pg';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { lazyAssetByteStore } from '@/lib/persistence/asset-byte-store';
import { resolveAssetPendingTtlMs } from '@/lib/persistence/asset-pending-ttl';
import { resolveAssetQuotaBytes } from '@/lib/persistence/asset-quota';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

export type PersistencePoolFactory = (connectionString: string) => Pool;

export interface ServerPersistenceProvider {
  pool: Pool;
  runtimeStore: PgRuntimeStore;
  documentStore: PgDocumentStore;
  assetStore: PgAssetStore;
}

interface ProviderState {
  connectionString?: string;
  providerPromise?: Promise<ServerPersistenceProvider>;
}

const PROVIDER_STATE_KEY = Symbol.for('openmaic.persistence.provider');
const globalState = globalThis as typeof globalThis & {
  [key: symbol]: ProviderState | undefined;
};
const providerState = (globalState[PROVIDER_STATE_KEY] ??= {});

async function createServerPersistenceProvider(
  connectionString: string,
  poolFactory: PersistencePoolFactory,
): Promise<ServerPersistenceProvider> {
  // Resolved before anything is opened: a malformed ceiling is a configuration
  // mistake, and refusing it here costs no connection and no schema work.
  // Allocation is reachable by any caller this deployment admits, so the
  // store's own quota is what keeps it from growing without bound.
  const quotaBytes = resolveAssetQuotaBytes();
  // Same reason, same moment: the window an allocation has to be claimed by a
  // document before the collector expires it.
  const pendingTtlMs = resolveAssetPendingTtlMs();
  const pool = poolFactory(connectionString);
  const queryable = pool as unknown as ConnectableQueryable;
  try {
    await ensureSchema(queryable);
    await ensureDocumentSchema(queryable);
    await ensureStageMetaSchema(queryable);
    await ensureOwnerMaterialSchema(queryable);
    await ensureAssetSchema(queryable);
    const withTransaction = nodePostgresTransaction(queryable);
    const byteStore = lazyAssetByteStore(process.env.ASSET_S3_BUCKET, queryable);
    const documentStore = new PgDocumentStore(queryable, {
      withTransaction,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      // Unconditional, and it has to be: this function is the only place
      // that decides what server-backed persistence is, and it always
      // ensures the asset schema and always leaves the collector's entry
      // pass on. A document store that did not record references would let
      // that pass expire allocations live documents name.
      trackAssetReferences: true,
    });
    // Say so on the database, rather than waiting for a document write to say
    // it by accident.
    //
    // The collector's entry level refuses to run until some write has recorded
    // a reference, which is the right refusal: releasing entries on a database
    // no writer maintains would delete assets live documents name. But the
    // only thing that used to answer it was a document write, so a cold
    // install -- and an upgraded database that already holds documents, which
    // is the case that matters -- sat refused until someone happened to save a
    // course, and the one-time backfill sat with it. Every store this function
    // builds is a reference writer, and this function is the only thing that
    // builds them, so it is exactly the thing entitled to declare it.
    //
    // Not swallowed: the same posture as the schema work above. If this fails
    // the provider fails, the pool is closed, and the next request retries a
    // fresh initialization -- because a provider that came up without the
    // declaration would leave reclamation refused with nothing to notice it.
    await documentStore.declareAssetReferenceTracking();
    return {
      pool,
      runtimeStore: new PgRuntimeStore(queryable, {
        withTransaction,
        payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      }),
      documentStore,
      assetStore: new PgAssetStore(queryable, {
        withTransaction,
        byteStore,
        pendingTtlMs,
        ...(quotaBytes === undefined ? {} : { quotaBytes }),
      }),
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

/** Shared server bootstrap used by both HTTP persistence and Pi composition. */
export function getServerPersistenceProvider(
  connectionString: string,
  poolFactory: PersistencePoolFactory = (value) => new Pool({ connectionString: value }),
): Promise<ServerPersistenceProvider> {
  if (providerState.providerPromise && providerState.connectionString === connectionString) {
    return providerState.providerPromise;
  }

  providerState.connectionString = connectionString;
  const initialization = createServerPersistenceProvider(connectionString, poolFactory).catch(
    (error) => {
      if (providerState.providerPromise === initialization) {
        providerState.providerPromise = undefined;
        providerState.connectionString = undefined;
      }
      throw error;
    },
  );
  providerState.providerPromise = initialization;
  return initialization;
}
