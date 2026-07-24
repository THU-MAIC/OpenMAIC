import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

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

async function createPersistenceHandler(
  connectionString: string,
  poolFactory: PoolFactory,
): Promise<RequestListener> {
  const pool = poolFactory(connectionString);
  const queryable = pool as unknown as ConnectableQueryable;
  try {
    await ensureSchema(queryable);
    await ensureDocumentSchema(queryable);
    const withTransaction = nodePostgresTransaction(queryable);
    const runtimeStore = new PgRuntimeStore(queryable, { withTransaction });
    const documentStore = new PgDocumentStore(queryable, {
      withTransaction,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    return createStorageHttpHandler(runtimeStore, documentStore, {
      authenticate: authenticatePersistenceRequest,
      authorizeMerge: async () => false,
      authorizeAdmin: async () => false,
      authorizeDocuments: async () => true,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
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
