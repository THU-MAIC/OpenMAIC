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
    return {
      pool,
      runtimeStore: new PgRuntimeStore(queryable, {
        withTransaction,
        payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      }),
      documentStore: new PgDocumentStore(queryable, {
        withTransaction,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
      }),
      assetStore: new PgAssetStore(queryable, { withTransaction, byteStore }),
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
