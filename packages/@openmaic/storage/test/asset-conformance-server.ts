// Test-only HTTP adapter for the asset contract. Each namespace owns a real
// PgAssetStore on PGlite, so the shared provider suite crosses multipart,
// handler, registry, transaction, and byte-storage boundaries end to end.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import type { AssetByteStore } from '../src/asset/byte-store.js';
import { PgAssetByteStore } from '../src/asset/pg-bytes.js';
import {
  PgAssetStore,
  ensureAssetSchema,
  type Queryable,
  type WithTransaction,
} from '../src/asset/pg.js';
import type { AssetPrincipal, AssetStore } from '../src/asset/types.js';
import {
  createAssetHttpHandler,
  type AssetHttpAuthorize,
  type AssetHttpHandlerOptions,
} from '../src/server/asset.js';

export interface AssetConformanceServer {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

export interface AssetConformanceServerOptions extends Omit<
  AssetHttpHandlerOptions,
  'authenticate' | 'authorizeAssets'
> {
  authenticate?: (req: IncomingMessage) => Promise<AssetPrincipal | undefined>;
  authorizeAssets?: AssetHttpAuthorize;
  byteStore?: (db: PGlite) => AssetByteStore;
  store?: (db: PGlite) => AssetStore;
}

interface NamespaceState {
  db: PGlite;
  ready: Promise<void>;
  handler: ReturnType<typeof createAssetHttpHandler>;
}

function transactions(db: PGlite): WithTransaction {
  return (body) => db.transaction((tx: Queryable) => body(tx));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Start the asset conformance server on an ephemeral loopback port. */
export async function startAssetConformanceServer(
  options: AssetConformanceServerOptions = {},
): Promise<AssetConformanceServer> {
  const states = new Map<string, NamespaceState>();
  const authenticate =
    options.authenticate ??
    (async (req: IncomingMessage) => ({ key: header(req, 'x-asset-principal') ?? 'default' }));

  const stateFor = (req: IncomingMessage): NamespaceState => {
    const namespace = header(req, 'x-asset-store-id') ?? 'default';
    let state = states.get(namespace);
    if (state !== undefined) return state;
    const db = new PGlite();
    const store =
      options.store?.(db) ??
      new PgAssetStore(db, {
        withTransaction: transactions(db),
        byteStore: options.byteStore?.(db) ?? new PgAssetByteStore(db),
      });
    state = {
      db,
      ready: db.waitReady.then(() => ensureAssetSchema(db)),
      handler: createAssetHttpHandler(store, {
        authenticate,
        ...(options.authorizeAssets === undefined
          ? {}
          : { authorizeAssets: options.authorizeAssets }),
        ...(options.renderableTypes === undefined
          ? {}
          : { renderableTypes: options.renderableTypes }),
        ...(options.maxRequestBytes === undefined
          ? {}
          : { maxRequestBytes: options.maxRequestBytes }),
        ...(options.maxAssetBytes === undefined ? {} : { maxAssetBytes: options.maxAssetBytes }),
        ...(options.maxMetaBytes === undefined ? {} : { maxMetaBytes: options.maxMetaBytes }),
        ...(options.maxParts === undefined ? {} : { maxParts: options.maxParts }),
      }),
    };
    states.set(namespace, state);
    return state;
  };

  const server: Server = createServer((req, res) => {
    const state = stateFor(req);
    void state.ready.then(
      () => state.handler(req, res),
      () => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'INTERNAL_ERROR',
              message: '@openmaic/storage: internal server error',
            },
          }),
        );
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Asset conformance server did not bind a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    fetch: globalThis.fetch.bind(globalThis),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all([...states.values()].map((state) => state.db.close()));
    },
  };
}
