import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const DESCRIPTOR_MEDIA_TYPE = 'application/vnd.openmaic.asset-descriptor+json';
const DEPLOYMENT_HEADER = 'x-deployment-token';
const DEPLOYMENT_SECRET = 'deployment-secret';
const STORAGE_DIST = resolve(process.cwd(), 'packages/@openmaic/storage/dist');

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
}

interface LoopbackServer {
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const runningServers = new Set<Server>();

async function startServer(
  handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<LoopbackServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: { ...request.headers },
    });
    void Promise.resolve(handle(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : 'fixture server failed');
    });
  });
  runningServers.add(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => {
          runningServers.delete(server);
          resolveClose();
        });
      }),
  };
}

function allowCors(request: IncomingMessage, response: ServerResponse, origin: string): void {
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Vary', 'Origin');
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader(
      'Access-Control-Allow-Headers',
      request.headers['access-control-request-headers'] ?? '',
    );
  }
}

async function startAppServer(): Promise<LoopbackServer> {
  return startServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><title>Asset CORS fixture</title>');
      return;
    }
    if (!path.startsWith('/storage/')) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const file = resolve(STORAGE_DIST, path.slice('/storage/'.length));
    if (!file.startsWith(`${STORAGE_DIST}${sep}`)) {
      response.statusCode = 403;
      response.end();
      return;
    }
    response.setHeader(
      'Content-Type',
      extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream',
    );
    response.end(await readFile(file));
  });
}

async function resolveInBrowser(
  page: Page,
  apiOrigin: string,
  assetId: string,
): Promise<
  | { kind: 'success'; text: string; mediaType: string }
  | { kind: 'missing' }
  | { kind: 'error'; code?: string; status?: number }
> {
  return page.evaluate(
    async ({ apiOrigin: baseUrl, assetId: id, deploymentHeader, deploymentSecret }) => {
      const modulePath = '/storage/asset/http.js';
      const { HttpAssetStore } = await import(modulePath);
      const store = new HttpAssetStore({
        baseUrl,
        headers: () => ({ [deploymentHeader]: deploymentSecret }),
        credentials: 'include',
      });
      try {
        const objectUrl = await store.resolve(id);
        if (objectUrl === null) return { kind: 'missing' as const };
        const blob = await (await fetch(objectUrl)).blob();
        return {
          kind: 'success' as const,
          text: await blob.text(),
          mediaType: blob.type,
        };
      } catch (error: unknown) {
        const value = error as { code?: unknown; status?: unknown };
        return {
          kind: 'error' as const,
          ...(typeof value?.code === 'string' ? { code: value.code } : {}),
          ...(typeof value?.status === 'number' ? { status: value.status } : {}),
        };
      } finally {
        await store.close();
      }
    },
    {
      apiOrigin,
      assetId,
      deploymentHeader: DEPLOYMENT_HEADER,
      deploymentSecret: DEPLOYMENT_SECRET,
    },
  );
}

test.afterEach(async () => {
  await Promise.all(
    [...runningServers].map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.closeAllConnections();
          server.close(() => {
            runningServers.delete(server);
            resolveClose();
          });
        }),
    ),
  );
});

test('resolves indirect bytes across real CORS boundaries without leaking credentials', async ({
  context,
  page,
}) => {
  const app = await startAppServer();
  const objectStore = await startServer((request, response) => {
    allowCors(request, response, app.origin);
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'image/png');
    response.end('signed-bytes');
  });
  const assetApi = await startServer((request, response) => {
    allowCors(request, response, app.origin);
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.setHeader('Content-Type', DESCRIPTOR_MEDIA_TYPE);
    response.end(JSON.stringify({ url: `${objectStore.origin}/signed/asset.png`, revision: 7 }));
  });

  await context.addCookies([
    {
      name: 'object-store-cookie',
      value: 'must-not-leak',
      url: objectStore.origin,
    },
  ]);
  await page.goto(app.origin);

  await expect(resolveInBrowser(page, assetApi.origin, 'ast_example')).resolves.toEqual({
    kind: 'success',
    text: 'signed-bytes',
    mediaType: 'image/png',
  });

  const preflight = assetApi.requests.find(({ method }) => method === 'OPTIONS');
  expect(preflight).toBeDefined();
  expect(String(preflight?.headers['access-control-request-headers']).toLowerCase()).toContain(
    DEPLOYMENT_HEADER,
  );

  const descriptorGet = assetApi.requests.find(({ method }) => method === 'GET');
  expect(descriptorGet?.headers.accept).toBe(`${DESCRIPTOR_MEDIA_TYPE}, */*;q=0.9`);
  expect(descriptorGet?.headers[DEPLOYMENT_HEADER]).toBe(DEPLOYMENT_SECRET);
  expect(descriptorGet?.headers.cookie).toContain('object-store-cookie=must-not-leak');

  const signedGet = objectStore.requests.find(({ method }) => method === 'GET');
  expect(signedGet).toBeDefined();
  expect(signedGet?.headers[DEPLOYMENT_HEADER]).toBeUndefined();
  expect(signedGet?.headers.cookie).toBeUndefined();

  await Promise.all([app.close(), assetApi.close(), objectStore.close()]);
});

test('surfaces an object-store response without CORS permission as a fetch failure', async ({
  page,
}) => {
  const app = await startAppServer();
  const objectStore = await startServer((_request, response) => {
    response.setHeader('Content-Type', 'image/png');
    response.end('blocked-by-cors');
  });
  const assetApi = await startServer((request, response) => {
    allowCors(request, response, app.origin);
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.setHeader('Content-Type', DESCRIPTOR_MEDIA_TYPE);
    response.end(JSON.stringify({ url: `${objectStore.origin}/signed/asset.png`, revision: 7 }));
  });

  await page.goto(app.origin);

  await expect(resolveInBrowser(page, assetApi.origin, 'ast_no_cors')).resolves.toEqual({
    kind: 'error',
    code: 'HTTP_REQUEST_FAILED',
    status: 0,
  });
  expect(objectStore.requests.some(({ method }) => method === 'GET')).toBe(true);

  await Promise.all([app.close(), assetApi.close(), objectStore.close()]);
});
