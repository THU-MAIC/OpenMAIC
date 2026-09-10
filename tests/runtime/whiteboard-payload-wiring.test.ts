import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  BrowserDocumentStore,
  BrowserRuntimeStore,
  RuntimeAppendConflictError,
} from '@openmaic/storage';
import { HttpRuntimeStore, HttpRuntimeStoreError } from '@openmaic/storage/runtime/http';
import { createStorageHttpHandler } from '@openmaic/storage/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import type {
  WhiteboardRuntimeOperationV1,
  WhiteboardRuntimePayloadV1,
} from '@/lib/whiteboard/runtime/types';

const NOW = '2026-08-06T00:00:00.000Z';

function validPayload(operationId = 'legacy-import:valid') {
  return {
    payloadVersion: 1,
    operationId,
    operation: {
      kind: 'legacy_snapshot_imported',
      source: {
        kind: 'stage.whiteboard',
        fingerprint: `sha256:${'a'.repeat(64)}`,
      },
      whiteboard: {
        id: 'board-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [],
      },
    },
  } as const;
}

function validElementPayload(operationId = 'element-add:valid') {
  return {
    payloadVersion: 1,
    operationId,
    operation: {
      kind: 'element_added',
      element: {
        id: 'text-added',
        type: 'text',
        left: 40,
        top: 50,
        width: 240,
        height: 60,
        rotate: 0,
        content: 'learner text',
        defaultFontName: 'Inter',
        defaultColor: '#000000',
      },
    },
  } as const;
}

function operationPayload(
  operationId: string,
  operation: WhiteboardRuntimeOperationV1,
): WhiteboardRuntimePayloadV1 {
  return { payloadVersion: 1, operationId, operation };
}

function handlerFetch(handler: RequestListener): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    const fakeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers.entries()),
      async *[Symbol.asyncIterator]() {
        if (body !== '') yield Buffer.from(body);
      },
    } as unknown as IncomingMessage;
    return new Promise<Response>((resolve, reject) => {
      let status = 200;
      let headers: Record<string, string> = {};
      const fakeResponse = {
        get headersSent() {
          return false;
        },
        writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
          status = nextStatus;
          headers = nextHeaders ?? {};
          return this;
        },
        end(chunk?: string | Buffer) {
          resolve(
            new Response(status === 204 ? null : chunk?.toString(), {
              status,
              headers,
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

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

describe('default BrowserRuntimeStore app payload wiring', () => {
  it('retains chat/quiz gates and adds the whiteboard gate', async () => {
    const { getRuntimeStore } = await import('@/lib/runtime/store');
    const store = getRuntimeStore();
    const now = '2026-08-06T00:00:00.000Z';
    for (const kind of ['chat', 'quizAttempt', 'whiteboard']) {
      await store.createSession({
        id: `${kind}-session`,
        kind,
        stageId: 'stage-1',
        learnerKey: 'learner-1',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    }

    await expect(
      store.appendRecord({
        id: 'bad-chat',
        sessionId: 'chat-session',
        createdAt: now,
        payload: { role: 'assistant' },
      }),
    ).rejects.toThrow('ChatMessageSkeleton');
    await expect(
      store.appendRecord({
        id: 'bad-quiz',
        sessionId: 'quizAttempt-session',
        createdAt: now,
        payload: { phase: 'draft' },
      }),
    ).rejects.toThrow('QuizAttemptSkeleton');
    await expect(
      store.appendRecord({
        id: 'bad-whiteboard',
        sessionId: 'whiteboard-session',
        createdAt: now,
        payload: { payloadVersion: 1 },
      }),
    ).rejects.toThrow('invalid runtime record');
    await expect(
      store.appendRecord(
        {
          id: 'element-add:valid',
          sessionId: 'whiteboard-session',
          createdAt: now,
          payload: validElementPayload(),
        },
        { expectedLastSeq: null },
      ),
    ).resolves.toMatchObject({ seq: 0 });
    await expect(
      store.appendRecord(
        {
          id: 'code-edit:valid',
          sessionId: 'whiteboard-session',
          createdAt: now,
          payload: operationPayload('code-edit:valid', {
            kind: 'code_lines_edited',
            elementId: 'code-1',
            edit: {
              kind: 'replace_lines',
              lineIds: ['L2', 'L1'],
              lines: [
                { id: 'host-A', content: '' },
                { id: 'host-B', content: 'replacement' },
              ],
            },
          }),
        },
        { expectedLastSeq: 0 },
      ),
    ).resolves.toMatchObject({ seq: 1 });
    await expect(
      store.appendRecord(
        {
          id: 'element-delete:valid',
          sessionId: 'whiteboard-session',
          createdAt: now,
          payload: operationPayload('element-delete:valid', {
            kind: 'element_deleted',
            elementId: 'text-added',
          }),
        },
        { expectedLastSeq: 1 },
      ),
    ).resolves.toMatchObject({ seq: 2 });
    await expect(
      store.appendRecord(
        {
          id: 'elements-clear:valid',
          sessionId: 'whiteboard-session',
          createdAt: now,
          payload: operationPayload('elements-clear:valid', { kind: 'elements_cleared' }),
        },
        { expectedLastSeq: 2 },
      ),
    ).resolves.toMatchObject({ seq: 3 });
    await expect(
      store.appendRecord(
        {
          id: 'element-add:invalid-target',
          sessionId: 'whiteboard-session',
          createdAt: now,
          payload: {
            ...validElementPayload('element-add:invalid-target'),
            operation: {
              ...validElementPayload().operation,
              whiteboardId: 'model-selected-board',
            },
          },
        },
        { expectedLastSeq: 3 },
      ),
    ).rejects.toThrow('invalid runtime record');
    await expect(
      store.appendRecord(
        {
          id: 'code-edit:invalid-lines',
          sessionId: 'whiteboard-session',
          createdAt: now,
          payload: operationPayload('code-edit:invalid-lines', {
            kind: 'code_lines_edited',
            elementId: 'code-1',
            edit: { kind: 'delete_lines', lineIds: [] },
          }),
        },
        { expectedLastSeq: 3 },
      ),
    ).rejects.toThrow('invalid runtime record');
  });

  it('enforces the same whiteboard validator and CAS through HTTP', async () => {
    const runtime = new BrowserRuntimeStore({
      indexedDB: new IDBFactory(),
      dbName: 'whiteboard-http-wiring',
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    const documents = new BrowserDocumentStore({ indexedDB: new IDBFactory() });
    const handler = createStorageHttpHandler(runtime, documents, {
      authenticate: async () => ({ learnerKey: 'learner-1' }),
      authorizeDocuments: async () => false,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    const client = new HttpRuntimeStore({
      baseUrl: 'http://whiteboard-storage.invalid',
      fetch: handlerFetch(handler),
    });
    await client.createSession({
      id: 'http-whiteboard',
      kind: 'whiteboard',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(
      client.appendRecord(
        {
          id: 'http-invalid',
          sessionId: 'http-whiteboard',
          createdAt: NOW,
          payload: { payloadVersion: 1 },
        },
        { expectedLastSeq: null },
      ),
    ).rejects.toMatchObject({
      name: HttpRuntimeStoreError.name,
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    const httpCommitted = await client.appendRecord(
      {
        id: 'http-record',
        sessionId: 'http-whiteboard',
        createdAt: NOW,
        payload: validPayload('legacy-import:http'),
      },
      { expectedLastSeq: null },
    );
    expect(httpCommitted.seq).toBe(0);

    await client.createSession({
      id: 'http-whiteboard-element',
      kind: 'whiteboard',
      stageId: 'stage-1',
      learnerKey: 'learner-1',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(
      client.appendRecord(
        {
          id: 'element-add:http',
          sessionId: 'http-whiteboard-element',
          createdAt: NOW,
          payload: validElementPayload('element-add:http'),
        },
        { expectedLastSeq: null },
      ),
    ).resolves.toMatchObject({ seq: 0 });
    await expect(
      client.appendRecord(
        {
          id: 'code-edit:http',
          sessionId: 'http-whiteboard-element',
          createdAt: NOW,
          payload: operationPayload('code-edit:http', {
            kind: 'code_lines_edited',
            elementId: 'code-1',
            edit: {
              kind: 'insert_after',
              lineId: 'L1',
              lines: [{ id: 'host-line', content: '' }],
            },
          }),
        },
        { expectedLastSeq: 0 },
      ),
    ).resolves.toMatchObject({ seq: 1 });
    await expect(
      client.appendRecord(
        {
          id: 'element-delete:http',
          sessionId: 'http-whiteboard-element',
          createdAt: NOW,
          payload: operationPayload('element-delete:http', {
            kind: 'element_deleted',
            elementId: 'text-added',
          }),
        },
        { expectedLastSeq: 1 },
      ),
    ).resolves.toMatchObject({ seq: 2 });
    await expect(
      client.appendRecord(
        {
          id: 'elements-clear:http',
          sessionId: 'http-whiteboard-element',
          createdAt: NOW,
          payload: operationPayload('elements-clear:http', { kind: 'elements_cleared' }),
        },
        { expectedLastSeq: 2 },
      ),
    ).resolves.toMatchObject({ seq: 3 });
    await expect(
      client.appendRecord(
        {
          id: 'element-add:http-invalid',
          sessionId: 'http-whiteboard-element',
          createdAt: NOW,
          payload: {
            ...validElementPayload('element-add:http-invalid'),
            operation: {
              ...validElementPayload().operation,
              whiteboardId: 'model-selected-board',
            },
          },
        },
        { expectedLastSeq: 3 },
      ),
    ).rejects.toMatchObject({
      name: HttpRuntimeStoreError.name,
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    await expect(
      client.appendRecord(
        {
          id: 'code-edit:http-invalid',
          sessionId: 'http-whiteboard-element',
          createdAt: NOW,
          payload: operationPayload('code-edit:http-invalid', {
            kind: 'code_lines_edited',
            elementId: 'code-1',
            edit: {
              kind: 'replace_lines',
              lineIds: ['L1', 'L1'],
              lines: [{ id: 'host-line', content: 'replacement' }],
            },
          }),
        },
        { expectedLastSeq: 3 },
      ),
    ).rejects.toMatchObject({
      name: HttpRuntimeStoreError.name,
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    const stale = await client
      .appendRecord(
        {
          id: 'http-stale',
          sessionId: 'http-whiteboard',
          createdAt: NOW,
          payload: validPayload('legacy-import:stale'),
        },
        { expectedLastSeq: null },
      )
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(RuntimeAppendConflictError);
    expect(stale).toMatchObject({
      name: RuntimeAppendConflictError.name,
      sessionId: 'http-whiteboard',
      expectedLastSeq: null,
      actualLastSeq: 0,
    });
  });
});
