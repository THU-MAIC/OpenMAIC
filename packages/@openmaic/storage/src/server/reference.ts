/**
 * Runnable reference composition for the RuntimeStore HTTP handler.
 *
 * This is intentionally not a production identity system. The bearer token is
 * treated as the learner key, merge is limited to a no-op self merge, and the
 * admin plane is denied. Production deployments MUST replace all three policy
 * hooks with their own authenticated identity and authorization decisions.
 *
 * Build the package, install `pg` in the host application, then run:
 *   DATABASE_URL=postgres://... node dist/server/reference.js
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { PgRuntimeStore, ensureSchema } from '../runtime/pg.js';
import type { Queryable, WithTransaction } from '../runtime/pg.js';
import type { RuntimePayloadValidator } from '../runtime/types.js';
import type {
  DocumentStore,
  SceneLike,
  SceneValidator,
  StageValidator,
} from '../document/types.js';
import type { Scene, Stage } from '@openmaic/dsl';
import { createRuntimeHttpHandler, createStorageHttpHandler } from './index.js';
import type {
  DocumentHttpAuthorize,
  RuntimeHttpAuthenticate,
  RuntimeHttpAuthorizeAdmin,
  RuntimeHttpAuthorizeMerge,
  StorageHttpHandlerOptions,
} from './index.js';

export interface ConnectableQueryable extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

export interface ReferenceRuntimeServerOptions<
  TScene extends SceneLike = Scene,
  TStage extends Stage = Stage,
> {
  authenticate?: RuntimeHttpAuthenticate;
  authorizeMerge?: RuntimeHttpAuthorizeMerge;
  authorizeAdmin?: RuntimeHttpAuthorizeAdmin;
  /** Whole-table replacement; pass the same validator table to the store and handler. */
  payloadValidators?: Record<string, RuntimePayloadValidator>;
  /** When supplied, the same server also exposes the `/documents` contract. */
  documentStore?: DocumentStore<TScene, TStage>;
  authorizeDocuments?: DocumentHttpAuthorize;
  /** Pass the same validators configured on documentStore. */
  validateScene?: SceneValidator;
  validateStage?: StageValidator;
  /** Maximum JSON request-body size in bytes. Defaults to 32 MiB. */
  maxBodyBytes?: number;
}

/**
 * Correct node-postgres transaction adapter: every invocation checks out one
 * client, pins BEGIN/body/COMMIT or ROLLBACK to it, and always releases it.
 */
export function nodePostgresTransaction(pool: ConnectableQueryable): WithTransaction {
  return async <T>(body: (queryable: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

/**
 * Compose the reference handler around any host-injected PostgreSQL queryable.
 *
 * **WARNING: the default example bearer authentication is fully impersonatable.**
 * Replace it, and the default authorization hooks, before exposing the server.
 * This factory creates an unbound Server; only main() binds it to an address.
 */
export async function createReferenceRuntimeServer<
  TScene extends SceneLike = Scene,
  TStage extends Stage = Stage,
>(
  pool: ConnectableQueryable,
  options: ReferenceRuntimeServerOptions<TScene, TStage> = {},
): Promise<Server> {
  await ensureSchema(pool);
  const store = new PgRuntimeStore(pool, {
    withTransaction: nodePostgresTransaction(pool),
    ...(options.payloadValidators === undefined
      ? {}
      : { payloadValidators: options.payloadValidators }),
  });
  const handlerOptions: StorageHttpHandlerOptions = {
    authenticate:
      options.authenticate ??
      (async (req) => {
        const authorization = req.headers.authorization;
        if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
          return undefined;
        }
        const learnerKey = authorization.slice('Bearer '.length);
        return learnerKey === '' ? undefined : { learnerKey };
      }),
    authorizeMerge:
      options.authorizeMerge ??
      (async (principal, fromKey, toKey) => principal.learnerKey === fromKey && fromKey === toKey),
    authorizeAdmin: options.authorizeAdmin ?? (async () => false),
    ...(options.payloadValidators === undefined
      ? {}
      : { payloadValidators: options.payloadValidators }),
    ...(options.authorizeDocuments === undefined
      ? {}
      : { authorizeDocuments: options.authorizeDocuments }),
    ...(options.validateScene === undefined ? {} : { validateScene: options.validateScene }),
    ...(options.validateStage === undefined ? {} : { validateStage: options.validateStage }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  };
  return createServer(
    options.documentStore === undefined
      ? createRuntimeHttpHandler(store, handlerOptions)
      : createStorageHttpHandler(store, options.documentStore, handlerOptions),
  );
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  // `pg` is deliberately supplied by the host and is not a runtime dependency
  // of @openmaic/storage. This monorepo has it as a test/development dependency.
  const importHostModule = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<{
    Pool: new (options: {
      connectionString: string;
    }) => ConnectableQueryable & { end(): Promise<void> };
  }>;
  const { Pool } = await importHostModule('pg');
  const pool = new Pool({ connectionString });
  const port = Number(process.env.PORT ?? '3000');
  let server;
  try {
    server = await createReferenceRuntimeServer(pool as ConnectableQueryable);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    // Startup failed after the pool may have opened connections (ensureSchema
    // runs inside createReferenceRuntimeServer); release them before exiting.
    await pool.end().catch(() => {});
    throw error;
  }
  process.stdout.write(`Runtime reference server listening on http://127.0.0.1:${port}\n`);

  const close = (): void => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
