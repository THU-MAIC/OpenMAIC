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

const S3_RESERVED_PREFIXES = ['xn--', 'sthree-', 'amzn-s3-demo-'];
const S3_RESERVED_SUFFIXES = ['-s3alias', '--ol-s3', '.mrap', '--x-s3', '--table-s3'];

async function loadS3AssetByteStore(bucket: string): Promise<AssetByteStore> {
  // This is the only optional import path. The storage package owns both the
  // SDK dependency and its ignored native import, so resolution happens from
  // the package that declares the peer rather than from this app.
  const storage = await import('@openmaic/storage/asset/s3-bytes');
  return storage.loadS3AssetByteStore(bucket);
}

function configuredS3Bucket(value: string | undefined): string | undefined {
  const bucket = value?.trim();
  if (!bucket) return undefined;
  const invalid =
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) ||
    bucket.includes('..') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket) ||
    S3_RESERVED_PREFIXES.some((prefix) => bucket.startsWith(prefix)) ||
    S3_RESERVED_SUFFIXES.some((suffix) => bucket.endsWith(suffix));
  if (invalid) {
    throw new Error(
      'Invalid ASSET_S3_BUCKET: expected a valid Amazon S3 general purpose bucket name',
    );
  }
  return bucket;
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
): Promise<RequestListener> {
  const s3Bucket = configuredS3Bucket(process.env.ASSET_S3_BUCKET);
  const pool = poolFactory(connectionString);
  const queryable = pool as unknown as ConnectableQueryable;
  try {
    await ensureSchema(queryable);
    await ensureDocumentSchema(queryable);
    await ensureAssetSchema(queryable);
    const withTransaction = nodePostgresTransaction(queryable);
    // ASSET_S3_BUCKET: a valid bucket name opts asset bytes into S3. The
    // optional AWS SDK owns its standard region, credential, and endpoint
    // configuration; this route reads no AWS environment variables itself.
    const byteStore = s3Bucket
      ? await loadS3AssetByteStore(s3Bucket)
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
): Promise<RequestListener> {
  if (handlerState.handlerPromise && handlerState.connectionString === connectionString) {
    return handlerState.handlerPromise;
  }

  handlerState.connectionString = connectionString;
  const initialization = createPersistenceHandler(connectionString, poolFactory).catch((error) => {
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
    // Buffered as bytes rather than as a string. A handler may end with a
    // `Uint8Array`, which `ServerResponse.end` accepts and which is not
    // necessarily valid UTF-8; decoding it would replace every unpaired byte
    // with U+FFFD and silently corrupt the response.
    const body: Buffer[] = [];

    const appendChunk = (chunk: string | Uint8Array) => {
      body.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
    };

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
      write(chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: unknown) {
        // `write` is part of the `ServerResponse` surface this object claims to
        // implement. Omitting it made any chunked handler a runtime TypeError
        // that the `as unknown as ServerResponse` cast hid from the compiler.
        headersSent = true;
        appendChunk(chunk);
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        if (typeof done === 'function') done();
        return true;
      },
      end(chunk?: string | Uint8Array) {
        headersSent = true;
        if (chunk !== undefined) appendChunk(chunk);
        resolve(
          new Response(body.length === 0 ? undefined : Buffer.concat(body), {
            status,
            headers,
          }),
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
      await getPersistenceHandler(connectionString, poolFactory),
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
