import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { PgAssetByteStore } from '@openmaic/storage/asset/pg-bytes';
import { PgAssetStore, ensureAssetSchema, type AssetByteStore } from '@openmaic/storage/asset/pg';
import { PgDocumentStore, ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { PgRuntimeStore, ensureSchema } from '@openmaic/storage/runtime/pg';
import { createStorageHttpHandler } from '@openmaic/storage/server';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';
import { Pool } from 'pg';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { authenticatePersistenceRequest } from '@/lib/persistence/server-auth';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

export const runtime = 'nodejs';

const ROUTE_PREFIX = '/api/persistence';

type PoolFactory = (connectionString: string) => Pool;
type S3AssetByteStoreLoader = (bucket: string) => Promise<AssetByteStore>;

const AWS_S3_CLIENT_PACKAGE = '@aws-sdk/client-s3';

async function loadS3AssetByteStore(bucket: string): Promise<AssetByteStore> {
  // Both optional modules load only after ASSET_S3_BUCKET opts this deployment
  // into S3. The app deliberately has no hard AWS SDK dependency.
  const [{ S3AssetByteStore }, sdk] = await Promise.all([
    import('@openmaic/storage/asset/s3-bytes'),
    import(/* webpackIgnore: true */ AWS_S3_CLIENT_PACKAGE),
  ]);
  const { S3Client } = sdk as {
    S3Client: new (options: Record<string, never>) => unknown;
  };
  return new S3AssetByteStore({ bucket, client: new S3Client({}) as never });
}

interface PersistenceHandlerState {
  connectionString?: string;
  handlerPromise?: Promise<RequestListener>;
}

const HANDLER_STATE_KEY = Symbol.for('openmaic.persistence-route.handler');
const globalState = globalThis as typeof globalThis & {
  [key: symbol]: PersistenceHandlerState | undefined;
};
const handlerState = (globalState[HANDLER_STATE_KEY] ??= {});

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function createPersistenceHandler(
  connectionString: string,
  poolFactory: PoolFactory,
  s3AssetByteStoreLoader: S3AssetByteStoreLoader,
): Promise<RequestListener> {
  const pool = poolFactory(connectionString);
  const queryable = pool as unknown as ConnectableQueryable;
  try {
    await ensureSchema(queryable);
    await ensureDocumentSchema(queryable);
    await ensureAssetSchema(queryable);
    const withTransaction = nodePostgresTransaction(queryable);
    // ASSET_S3_BUCKET: a non-empty bucket name opts asset bytes into S3. The
    // optional AWS SDK owns its standard region, credential, and endpoint
    // configuration; this route reads no AWS environment variables itself.
    const s3Bucket = process.env.ASSET_S3_BUCKET?.trim();
    const byteStore = s3Bucket
      ? await s3AssetByteStoreLoader(s3Bucket)
      : new PgAssetByteStore(queryable);
    const runtimeStore = new PgRuntimeStore(queryable, {
      withTransaction,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    const documentStore = new PgDocumentStore(queryable, {
      withTransaction,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    // The asset contract requires a server-derived principal; this development
    // authenticator instead takes the partition key from a client-supplied header.
    // Cross-principal isolation is therefore not in force: asset bytes are as
    // reachable as documents and runtime records under this authenticator. Before
    // asset routes carry anything that matters, production must replace
    // authenticatePersistenceRequest with real session verification. See
    // lib/persistence/server-auth.ts for the token's limits.
    const assetStore = new PgAssetStore(queryable, { withTransaction, byteStore });
    // AssetCollector is intentionally not scheduled by this request route.
    // Without a deployment-managed collector and grace period, unreferenced
    // bytes accumulate without bound; scheduling is a host decision.
    return createStorageHttpHandler(runtimeStore, documentStore, {
      authenticate: authenticatePersistenceRequest,
      authorizeMerge: async () => false,
      authorizeAdmin: async () => false,
      authorizeDocuments: async () => true,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      assetStore,
    });
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

function getPersistenceHandler(
  connectionString: string,
  poolFactory: PoolFactory,
  s3AssetByteStoreLoader: S3AssetByteStoreLoader,
): Promise<RequestListener> {
  if (handlerState.handlerPromise && handlerState.connectionString === connectionString) {
    return handlerState.handlerPromise;
  }

  handlerState.connectionString = connectionString;
  const initialization = createPersistenceHandler(
    connectionString,
    poolFactory,
    s3AssetByteStoreLoader,
  ).catch((error) => {
    // Do not poison the singleton with a rejected promise. createPersistenceHandler
    // has already closed its failed pool, and the next request gets a clean retry.
    if (handlerState.handlerPromise === initialization) {
      handlerState.handlerPromise = undefined;
      handlerState.connectionString = undefined;
    }
    throw error;
  });
  handlerState.handlerPromise = initialization;
  return initialization;
}

function nodeRequest(request: Request): IncomingMessage {
  const url = new URL(request.url);
  const pathname = url.pathname.startsWith(ROUTE_PREFIX)
    ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
    : url.pathname;
  const body = request.body
    ? Readable.fromWeb(
        request.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
      )
    : Readable.from([]);
  return Object.assign(body, {
    method: request.method,
    url: `${pathname}${url.search}`,
    headers: Object.fromEntries(request.headers.entries()),
  }) as IncomingMessage;
}

function setHeaders(target: Headers, source: Record<string, string | number | string[]>): void {
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) target.append(name, item);
    } else {
      target.set(name, String(value));
    }
  }
}

function runNodeHandler(handler: RequestListener, request: Request): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let status = 200;
    const headers = new Headers();
    let headersSent = false;

    const response = {
      get headersSent() {
        return headersSent;
      },
      writeHead(
        statusCode: number,
        statusMessageOrHeaders?: string | Record<string, string | number | string[]>,
        outgoingHeaders?: Record<string, string | number | string[]>,
      ) {
        status = statusCode;
        headersSent = true;
        const values =
          typeof statusMessageOrHeaders === 'string' ? outgoingHeaders : statusMessageOrHeaders;
        if (values) setHeaders(headers, values);
        return this;
      },
      end(chunk?: string | Uint8Array) {
        headersSent = true;
        resolve(
          new Response(
            chunk === undefined
              ? undefined
              : typeof chunk === 'string'
                ? chunk
                : Buffer.from(chunk).toString(),
            {
              status,
              headers,
            },
          ),
        );
        return this;
      },
      destroy(error?: Error) {
        reject(error ?? new Error('Persistence HTTP handler destroyed the response'));
        return this;
      },
    } as unknown as ServerResponse;

    try {
      handler(nodeRequest(request), response);
    } catch (error) {
      reject(error);
    }
  });
}

interface PersistenceRequestDeps {
  poolFactory?: PoolFactory;
  s3AssetByteStoreLoader?: S3AssetByteStoreLoader;
}

export async function handlePersistenceRequest(
  request: Request,
  deps: PersistenceRequestDeps = {},
): Promise<Response> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return jsonError(404, 'PERSISTENCE_NOT_CONFIGURED', 'server persistence not configured');
  }
  if (!process.env.PERSISTENCE_DEV_TOKEN) {
    return jsonError(
      503,
      'PERSISTENCE_DEV_TOKEN_MISSING',
      'server persistence requires PERSISTENCE_DEV_TOKEN (development auth only)',
    );
  }

  try {
    const poolFactory = deps.poolFactory ?? ((value) => new Pool({ connectionString: value }));
    return await runNodeHandler(
      await getPersistenceHandler(
        connectionString,
        poolFactory,
        deps.s3AssetByteStoreLoader ?? loadS3AssetByteStore,
      ),
      request,
    );
  } catch (error) {
    console.error('Embedded persistence route initialization failed', error);
    return jsonError(500, 'PERSISTENCE_INIT_FAILED', 'server persistence initialization failed');
  }
}

export const GET = (request: Request) => handlePersistenceRequest(request);
export const POST = (request: Request) => handlePersistenceRequest(request);
export const PUT = (request: Request) => handlePersistenceRequest(request);
export const PATCH = (request: Request) => handlePersistenceRequest(request);
export const DELETE = (request: Request) => handlePersistenceRequest(request);
