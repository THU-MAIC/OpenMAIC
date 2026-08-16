import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { PgAssetStore, ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { PgDocumentStore, ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { PgRuntimeStore, ensureSchema } from '@openmaic/storage/runtime/pg';
import {
  createStorageHttpHandler,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  type AssetIndirectByteEgress,
} from '@openmaic/storage/server';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';
import { Pool } from 'pg';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { lazyAssetByteStore } from '@/lib/persistence/asset-byte-store';
import { resolveAssetCollectionGraceMs } from '@/lib/persistence/asset-collection-grace';
import { authenticatePersistenceRequest } from '@/lib/persistence/server-auth';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

export const runtime = 'nodejs';

const ROUTE_PREFIX = '/api/persistence';

type PoolFactory = (connectionString: string) => Pool;

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

/**
 * ASSET_BYTE_EGRESS: set to `redirect` to answer asset byte GETs with a 302 to
 * a short-lived signed URL, when the byte layer can sign (S3 can; the
 * PostgreSQL byte column cannot, and falls back to direct bytes). Anything
 * else, including unset and `direct`, keeps the default byte-for-byte
 * behavior. The tradeoff this opts into -- the redirect target names the
 * content hash -- is specified in the storage package's asset HTTP contract.
 */
function configuredAssetByteEgress(value: string | undefined): 'redirect' | undefined {
  const raw = value?.trim().toLowerCase();
  if (raw === 'redirect') return 'redirect';
  if (raw === undefined || raw === '' || raw === 'direct') return undefined;
  console.warn(`ASSET_BYTE_EGRESS=${value} is not recognized; using direct byte egress`);
  return undefined;
}

/**
 * Redirect egress and the collection grace must agree: a signed URL that
 * outlives its object turns a valid read into an object-store error. The
 * handler enforces that invariant itself, on the grace passed here, and this
 * grace is resolved by the collector's own parser so both components run on one
 * number.
 *
 * A grace too short for the default lifetime degrades to direct egress with a
 * loud warning rather than failing initialization: the asset backend is
 * optional, and its misconfiguration must never take document and runtime
 * traffic down with it.
 */
function indirectEgressWithinGrace(
  egress: 'redirect' | undefined,
): AssetIndirectByteEgress | undefined {
  if (egress !== 'redirect') return undefined;
  const collectionGraceMs = resolveAssetCollectionGraceMs();
  if (collectionGraceMs < DEFAULT_SIGNED_URL_TTL_SECONDS * 1000 * 10) {
    console.warn(
      `ASSET_BYTE_EGRESS=redirect requires ASSET_COLLECTION_GRACE_MS to be at least ten times ` +
        `the signed URL lifetime (${DEFAULT_SIGNED_URL_TTL_SECONDS}s); got ${collectionGraceMs}ms. ` +
        `Falling back to direct byte egress.`,
    );
    return undefined;
  }
  return { mode: 'redirect', collectionGraceMs };
}

async function createPersistenceHandler(
  connectionString: string,
  poolFactory: PoolFactory,
): Promise<RequestListener> {
  const pool = poolFactory(connectionString);
  const queryable = pool as unknown as ConnectableQueryable;
  try {
    await ensureSchema(queryable);
    await ensureDocumentSchema(queryable);
    await ensureAssetSchema(queryable);
    const withTransaction = nodePostgresTransaction(queryable);
    // Deferred to first asset use: the asset backend is optional, so its
    // misconfiguration (an invalid ASSET_S3_BUCKET, an unresolvable AWS SDK)
    // must fail asset requests only, never this handler's initialization.
    const byteStore = lazyAssetByteStore(process.env.ASSET_S3_BUCKET, queryable);
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
    // Reclamation is not scheduled from here, and must not be: a route module
    // has no once-per-process guarantee and no shutdown hook. AssetCollector
    // runs from instrumentation.ts instead, over the byte store this same
    // lib/persistence/asset-byte-store selection produces, so the collector
    // always deletes through the layer the request path wrote through.
    const byteEgress = indirectEgressWithinGrace(
      configuredAssetByteEgress(process.env.ASSET_BYTE_EGRESS),
    );
    return createStorageHttpHandler(runtimeStore, documentStore, {
      authenticate: authenticatePersistenceRequest,
      authorizeMerge: async () => false,
      authorizeAdmin: async () => false,
      authorizeDocuments: async () => true,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      assetStore,
      ...(byteEgress === undefined ? {} : { byteEgress }),
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

type ResponseCallback = () => void;

function responseEncoding(encodingOrCallback?: BufferEncoding | ResponseCallback): BufferEncoding {
  const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8';
  if (!Buffer.isEncoding(encoding)) {
    // Let Buffer produce Node's ERR_UNKNOWN_ENCODING TypeError.
    Buffer.from('', encoding);
  }
  return encoding;
}

function responseCallback(
  encodingOrCallback?: BufferEncoding | ResponseCallback,
  callback?: ResponseCallback,
): ResponseCallback | undefined {
  return typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
}

function suppressesResponseBody(request: Request, status: number): boolean {
  return request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
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

    const appendChunk = (chunk: string | Uint8Array, encoding: BufferEncoding) => {
      body.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
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
      write(
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ResponseCallback,
        callback?: ResponseCallback,
      ) {
        // `write` is part of the `ServerResponse` surface this object claims to
        // implement. Omitting it made any chunked handler a runtime TypeError
        // that the `as unknown as ServerResponse` cast hid from the compiler.
        headersSent = true;
        appendChunk(chunk, responseEncoding(encodingOrCallback));
        const done = responseCallback(encodingOrCallback, callback);
        if (done) process.nextTick(done);
        return true;
      },
      end(
        chunkOrCallback?: string | Uint8Array | ResponseCallback,
        encodingOrCallback?: BufferEncoding | ResponseCallback,
        callback?: ResponseCallback,
      ) {
        headersSent = true;
        const chunk = typeof chunkOrCallback === 'function' ? undefined : chunkOrCallback;
        const done =
          typeof chunkOrCallback === 'function'
            ? chunkOrCallback
            : responseCallback(encodingOrCallback, callback);
        if (chunk !== undefined) appendChunk(chunk, responseEncoding(encodingOrCallback));
        resolve(
          new Response(
            suppressesResponseBody(request, status) || body.length === 0
              ? undefined
              : Buffer.concat(body),
            {
              status,
              headers,
            },
          ),
        );
        if (done) process.nextTick(done);
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
