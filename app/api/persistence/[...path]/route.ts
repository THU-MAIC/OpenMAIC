import { randomUUID } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import {
  createStorageHttpHandler,
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  type AssetIndirectByteEgress,
} from '@openmaic/storage/server';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createLogger } from '@/lib/logger';
import { resolveAssetCollectionGraceMs } from '@/lib/persistence/asset-collection-grace';
import {
  decideDocumentAccess,
  parseDocumentAction,
  type DocumentAccess,
} from '@/lib/persistence/document-access';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { assetPrincipalForOwner, createOwnerAssetStore } from '@/lib/persistence/owner-assets';
import { guardedServerRuntimeStore } from '@/lib/persistence/runtime-tombstone-guard';
import {
  getServerPersistenceProvider,
  type PersistencePoolFactory,
} from '@/lib/persistence/server-provider';
import { readStageMeta } from '@/lib/persistence/stage-meta';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

const ROUTE_PREFIX = '/api/persistence';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const log = createLogger('Persistence');

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function withHeaders(response: Response, headers: Headers): Response {
  for (const [name, value] of headers.entries()) response.headers.append(name, value);
  return response;
}

/**
 * `GET /api/persistence/learner-key`: the runtime learner key the server
 * derives for this request's owner, so the browser can address its own runtime
 * sessions (the runtime contract names the learner key in paths and bodies).
 * The key is the owner id, which owner-scoped responses already carry
 * (folders report it as `userKey`), so this discloses nothing new; it is
 * uncacheable because it is per owner.
 */
const LEARNER_KEY_PATH = '/learner-key';

function learnerKeyResponse(ownerId: string, responseHeaders: Headers): Response {
  const response = Response.json(
    { learnerKey: ownerId },
    { status: 200, headers: { 'cache-control': 'private, no-store' } },
  );
  return withHeaders(response, responseHeaders);
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
  ownerId: string,
  access: DocumentAccess,
  poolFactory?: PersistencePoolFactory,
): Promise<RequestListener> {
  const { pool, runtimeStore, assetStore, withTransaction, assetStoreIn } =
    await getServerPersistenceProvider(connectionString, poolFactory);
  const documentStore = createOwnerBoundDocumentStore({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
  // One identity for all three contracts, resolved server-side by the owner
  // identity seam (lib/server/identity/) for this request:
  //
  // - Documents act as the owner.
  // - Runtime sessions are partitioned by learner key, and the learner key IS
  //   the owner id. Nothing the client sends chooses it: a request that names
  //   another learner's partition in its path or body answers 403
  //   FORBIDDEN_LEARNER from the handler, and a session another learner holds
  //   answers 404. The browser learns its key from GET /api/persistence/learner-key.
  // - Assets are partitioned per owner (lib/persistence/owner-assets.ts), so
  //   quota is per owner and replace/delete reach only the owner's own entries
  //   (plus legacy shared entries only their courses reference). Reads stay
  //   capability-by-id for committed media a live course references, so
  //   viewers of a course keep loading its media.
  //
  // Reclamation is not scheduled from here, and must not be: a route module
  // has no once-per-process guarantee and no shutdown hook. AssetCollector
  // runs from instrumentation.ts instead, over the byte store this same
  // lib/persistence/asset-byte-store selection produces, so the collector
  // always deletes through the layer the request path wrote through. The
  // document store this handler mounts is the other half of that mechanism:
  // createOwnerBoundDocumentStore builds it with reference tracking on, which
  // is what gives the entry pass something to read.
  const assetPrincipal = assetPrincipalForOwner(ownerId);
  const byteEgress = indirectEgressWithinGrace(
    configuredAssetByteEgress(process.env.ASSET_BYTE_EGRESS),
  );
  const guardedRuntimeStore = guardedServerRuntimeStore(runtimeStore, pool);
  return createStorageHttpHandler(guardedRuntimeStore, documentStore, {
    authenticate: async (request) => {
      if (request.url?.startsWith('/assets')) return assetPrincipal;
      return { learnerKey: ownerId };
    },
    authorizeMerge: async () => false,
    authorizeAdmin: async () => false,
    authorizeDocuments: async () => access === 'allow',
    validateScene: validateAppScene,
    validateStage: validateAppStage,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    assetStore: createOwnerAssetStore(assetStore, {
      ownerId,
      queryable: pool,
      legacyMutations: { withTransaction, storeIn: assetStoreIn },
    }),
    ...(byteEgress === undefined ? {} : { byteEgress }),
  });
}

function routeRelativePath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) || '/' : pathname;
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
  poolFactory?: PersistencePoolFactory;
}

function persistenceRequestId(request: Request): string {
  const upstream = request.headers.get('x-request-id')?.trim();
  return upstream && REQUEST_ID_PATTERN.test(upstream) ? upstream : randomUUID();
}

async function responseErrorCode(response: Response): Promise<string> {
  if (!response.headers.get('content-type')?.includes('application/json')) return '-';
  const payload = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { error?: { code?: unknown } } | undefined;
  return typeof payload?.error?.code === 'string' ? payload.error.code : '-';
}

export async function handlePersistenceRequest(
  request: Request,
  deps: PersistenceRequestDeps = {},
): Promise<Response> {
  const requestId = persistenceRequestId(request);
  const response = await handlePersistenceRequestInner(request, deps);
  if (response.status >= 500) {
    const path = new URL(request.url).pathname;
    const code = await responseErrorCode(response);
    log.error(`${request.method} ${path} -> ${response.status} ${code} (requestId=${requestId})`);
  }
  response.headers.set('x-request-id', requestId);
  return response;
}

async function handlePersistenceRequestInner(
  request: Request,
  deps: PersistenceRequestDeps,
): Promise<Response> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return jsonError(404, 'PERSISTENCE_NOT_CONFIGURED', 'server persistence not configured');
  }

  return withRequestOwner(request, async ({ ownerId }, responseHeaders) => {
    try {
      const path = routeRelativePath(request);
      if (path === LEARNER_KEY_PATH) {
        return request.method === 'GET'
          ? learnerKeyResponse(ownerId, responseHeaders)
          : withHeaders(
              jsonError(405, 'METHOD_NOT_ALLOWED', 'learner-key accepts GET only'),
              responseHeaders,
            );
      }
      const action = parseDocumentAction(request.method, path);
      let access: DocumentAccess = 'allow';
      if (path === '/documents' || path.startsWith('/documents/')) {
        const { pool } = await getServerPersistenceProvider(connectionString, deps.poolFactory);
        const queryable = pool;
        access = await decideDocumentAccess(
          action,
          ownerId,
          (stageId) => readStageMeta(queryable, stageId),
          (stageId) =>
            pool
              .query('SELECT 1 FROM document_stages WHERE id = $1', [stageId])
              .then((result) => result.rows.length > 0),
          (stageId) => readStageMeta(queryable, stageId),
        );
      }

      const response =
        access === 'not-found'
          ? jsonError(404, 'DOCUMENT_NOT_FOUND', '@openmaic/storage: document not found')
          : await runNodeHandler(
              await createPersistenceHandler(connectionString, ownerId, access, deps.poolFactory),
              request,
            );
      return withHeaders(response, responseHeaders);
    } catch (error) {
      console.error('Embedded persistence route initialization failed', error);
      return withHeaders(
        jsonError(500, 'PERSISTENCE_INIT_FAILED', 'server persistence initialization failed'),
        responseHeaders,
      );
    }
  });
}

export const GET = (request: Request) => handlePersistenceRequest(request);
export const POST = (request: Request) => handlePersistenceRequest(request);
export const PUT = (request: Request) => handlePersistenceRequest(request);
export const PATCH = (request: Request) => handlePersistenceRequest(request);
export const DELETE = (request: Request) => handlePersistenceRequest(request);
