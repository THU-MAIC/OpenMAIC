import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { IDBFactory } from 'fake-indexeddb';
import { DSL_VERSION_KEY } from '@openmaic/dsl';
import { describe, expect, test } from 'vitest';
import { BrowserDocumentStore } from '../src/document/browser.js';
import { DocumentVersionError } from '../src/document/types.js';
import { HttpDocumentStore, HttpDocumentStoreError } from '../src/document/http.js';
import type { StageValidator } from '../src/document/types.js';
import { BrowserRuntimeStore } from '../src/runtime/browser.js';
import { createStorageHttpHandler } from '../src/server/index.js';
import { makeDocument, runDocumentStoreContract, slideScene } from './document-contract.js';

const BASE_URL = 'http://storage-reference.invalid';

function handlerFetch(handler: RequestListener): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    const headers = Object.fromEntries(request.headers.entries());
    headers.authorization ??= 'Bearer document-contract';
    const fakeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== '') yield Buffer.from(body);
      },
    } as unknown as IncomingMessage;

    return new Promise<Response>((resolve, reject) => {
      let status = 200;
      let responseHeaders: Record<string, string> = {};
      let responseBody: string | undefined;
      let headersSent = false;
      const fakeResponse = {
        get headersSent() {
          return headersSent;
        },
        writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
          status = nextStatus;
          responseHeaders = nextHeaders ?? {};
          headersSent = true;
          return this;
        },
        end(chunk?: string | Buffer) {
          responseBody = chunk === undefined ? undefined : chunk.toString();
          resolve(
            new Response(status === 204 ? null : responseBody, {
              status,
              headers: responseHeaders,
            }),
          );
          return this;
        },
        destroy(error?: Error) {
          reject(error ?? new Error('response destroyed'));
          return this;
        },
      } as unknown as ServerResponse;
      handler(fakeRequest, fakeResponse);
    });
  };
}

async function reStampStage(
  idb: IDBFactory,
  dbName: string,
  stageId: string,
  version: string | undefined,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('stages', 'readwrite');
    const stages = transaction.objectStore('stages');
    const request = stages.get(stageId);
    request.onsuccess = () => {
      const row = request.result as Record<string, unknown>;
      if (version === undefined) delete row[DSL_VERSION_KEY];
      else row[DSL_VERSION_KEY] = version;
      stages.put(row);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

let harnessDb = 0;
function makeHarness(
  authorizeDocuments: () => boolean = () => true,
  options: { maxBodyBytes?: number; validateStage?: StageValidator } = {},
) {
  const idb = new IDBFactory();
  const dbName = `http-document-contract-${harnessDb++}`;
  const documents = new BrowserDocumentStore({ indexedDB: idb, dbName });
  const runtime = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
  const handler = createStorageHttpHandler(runtime, documents, {
    authenticate: async (req) => {
      const authorization = req.headers.authorization;
      return typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? { learnerKey: 'author' }
        : undefined;
    },
    authorizeDocuments: async () => authorizeDocuments(),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.validateStage === undefined ? {} : { validateStage: options.validateStage }),
  });
  const fetch = handlerFetch(handler);
  return {
    documents,
    fetch,
    client: new HttpDocumentStore({ baseUrl: BASE_URL, fetch }),
    seedStoredVersion: (stageId: string, version: string | undefined) =>
      reStampStage(idb, dbName, stageId, version),
  };
}

runDocumentStoreContract('reference HTTP', () => {
  const harness = makeHarness();
  return {
    store: harness.client,
    seedStoredVersion: harness.seedStoredVersion,
  };
});

describe('HttpDocumentStore contract mapping', () => {
  test('uses injected request headers and the reference server requires authentication', async () => {
    const { fetch } = makeHarness();
    const unauthenticated = await fetch(`${BASE_URL}/documents`, {
      headers: { authorization: '' },
    });
    expect(unauthenticated.status).toBe(401);

    let context: { method: string; path: string } | undefined;
    const client = new HttpDocumentStore({
      baseUrl: BASE_URL,
      fetch,
      headers: (next) => {
        context = next;
        return { authorization: 'Bearer author' };
      },
    });
    await client.listDocuments();
    expect(context).toEqual({ method: 'GET', path: '/documents' });
  });

  test('maps document authorization denial to a typed 403', async () => {
    const { client } = makeHarness(() => false);
    await expect(client.listDocuments()).rejects.toMatchObject({
      name: 'HttpDocumentStoreError',
      status: 403,
      code: 'FORBIDDEN_DOCUMENTS',
    });
  });

  test('maps malformed request JSON to VALIDATION_FAILED', async () => {
    const { fetch } = makeHarness();
    const response = await fetch(`${BASE_URL}/documents/stage-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  test('rejects oversized bodies with 413 while allowing an under-limit request', async () => {
    const { fetch } = makeHarness(() => true, { maxBodyBytes: 256 });
    const overLimit = await fetch(`${BASE_URL}/documents/stage-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(300) }),
    });
    expect(overLimit.status).toBe(413);
    await expect(overLimit.json()).resolves.toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });

    const underLimit = await fetch(`${BASE_URL}/documents/stage-1/stage`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'stage-1',
        name: 'Missing parent',
        createdAt: 1,
        updatedAt: 2,
      }),
    });
    expect(underLimit.status).toBe(404);
  });

  test('fails loud when a structured-clone document is not JSON-safe on read', async () => {
    const { documents, fetch } = makeHarness();
    const document = makeDocument();
    document.outline = { generatedAt: new Date('2026-01-01T00:00:00.000Z') };
    await documents.saveDocument(document);

    const response = await fetch(`${BASE_URL}/documents/stage-1`);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'NOT_JSON_SAFE',
        message: expect.stringMatching(/document response.*outline.*Date/i),
      },
    });
  });

  test('maps missing required parents to typed 404 errors with browser wording', async () => {
    const { client } = makeHarness();
    const failure = client.putStage('ghost', {
      id: 'ghost',
      name: 'Ghost',
      createdAt: 1,
      updatedAt: 2,
    });
    await expect(failure).rejects.toBeInstanceOf(HttpDocumentStoreError);
    await expect(failure).rejects.toMatchObject({ status: 404, code: 'DOCUMENT_NOT_FOUND' });
    await expect(failure).rejects.toThrow(/missing document/);
  });

  test.each([
    [
      'putStage',
      (client: HttpDocumentStore) =>
        client.putStage('stage-1', {
          id: 'stage-1',
          name: 'Stale update',
          createdAt: 1,
          updatedAt: 2,
        }),
    ],
    [
      'putScene',
      (client: HttpDocumentStore) =>
        client.putScene('stage-1', slideScene('stage-1', 'scene-c', 2)),
    ],
    ['deleteScene', (client: HttpDocumentStore) => client.deleteScene('stage-1', 'scene-a')],
  ])('maps unversioned %s to 400 VALIDATION_FAILED', async (_operation, write) => {
    const { client, seedStoredVersion } = makeHarness();
    await client.saveDocument(makeDocument());
    await seedStoredVersion('stage-1', undefined);

    await expect(write(client)).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  test('maps a future-version save to FUTURE_VERSION without overwriting current data', async () => {
    const { client } = makeHarness();
    await client.saveDocument(makeDocument());
    const future = makeDocument();
    future.dslVersion = '99.0.0';
    future.stage.name = 'Future';

    const failure = client.saveDocument(future);
    await expect(failure).rejects.toBeInstanceOf(DocumentVersionError);
    await expect(failure).rejects.toMatchObject({
      stageId: 'stage-1',
      kind: 'future',
      storedVersion: '99.0.0',
    });
    await expect(failure).rejects.toThrow(
      `@openmaic/storage: refusing to save document "stage-1" — it was written at DSL version ` +
        `"99.0.0", newer than this client's`,
    );
    expect((await client.loadDocument('stage-1'))!.stage.name).toBe('Intro Course');
  });

  test('rematerializes a typed future-version error classified from the backing store', async () => {
    const { client, seedStoredVersion } = makeHarness();
    await client.saveDocument(makeDocument());
    await seedStoredVersion('stage-1', '99.0.0');
    const replacement = makeDocument();
    replacement.stage.name = 'Old Client Overwrite';

    const failure = client.saveDocument(replacement);
    await expect(failure).rejects.toBeInstanceOf(DocumentVersionError);
    await expect(failure).rejects.toMatchObject({
      stageId: 'stage-1',
      kind: 'future',
      storedVersion: '99.0.0',
    });
    await expect(failure).rejects.toThrow(/refusing to overwrite document/);
  });

  test('client-side validators fail before fetch', async () => {
    let calls = 0;
    const client = new HttpDocumentStore({
      baseUrl: BASE_URL,
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      },
    });
    const bad = makeDocument();
    delete (bad.stage as { name?: string }).name;
    await expect(client.saveDocument(bad)).rejects.toThrow(/invalid stage/);
    expect(calls).toBe(0);
  });

  test('retains structured validator details on HttpDocumentStoreError', async () => {
    const details = [
      { path: '/name', message: 'name is invalid' },
      { path: '/updatedAt', message: 'updatedAt is invalid' },
    ];
    const { client } = makeHarness(() => true, {
      validateStage: () => ({ valid: false, errors: details }),
    });

    await expect(
      client.putStage('stage-1', {
        id: 'stage-1',
        name: 'Rejected by server validator',
        createdAt: 1,
        updatedAt: 2,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      details,
    });
  });
});
