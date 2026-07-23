import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, test } from 'vitest';
import { BrowserDocumentStore } from '../src/document/browser.js';
import { HttpDocumentStore, HttpDocumentStoreError } from '../src/document/http.js';
import { BrowserRuntimeStore } from '../src/runtime/browser.js';
import { createStorageHttpHandler } from '../src/server/index.js';
import { makeDocument, runDocumentStoreContract } from './document-contract.js';

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

function makeHarness(authorizeDocuments: () => boolean = () => true) {
  const documents = new BrowserDocumentStore({ indexedDB: new IDBFactory() });
  const runtime = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
  const handler = createStorageHttpHandler(runtime, documents, {
    authenticate: async (req) => {
      const authorization = req.headers.authorization;
      return typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? { learnerKey: 'author' }
        : undefined;
    },
    authorizeDocuments: async () => authorizeDocuments(),
  });
  const fetch = handlerFetch(handler);
  return {
    documents,
    fetch,
    client: new HttpDocumentStore({ baseUrl: BASE_URL, fetch }),
  };
}

runDocumentStoreContract('reference HTTP', () => makeHarness().client);

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

  test('maps a future-version save to FUTURE_VERSION without overwriting current data', async () => {
    const { client } = makeHarness();
    await client.saveDocument(makeDocument());
    const future = makeDocument();
    future.dslVersion = '99.0.0';
    future.stage.name = 'Future';

    await expect(client.saveDocument(future)).rejects.toMatchObject({
      status: 409,
      code: 'FUTURE_VERSION',
    });
    expect((await client.loadDocument('stage-1'))!.stage.name).toBe('Intro Course');
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
});
