import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { IDBFactory } from 'fake-indexeddb';
import {
  isChatMessageSkeleton,
  isQuizAttemptSkeleton,
  needsRuntimeMigration,
  RUNTIME_DSL_VERSION,
  runtimeDslVersionOf,
  validateRuntimeRecord,
  validateRuntimeSession,
} from '@openmaic/dsl';
import type {
  RuntimeRecordInit,
  RuntimeSession,
  RuntimeSessionStatus,
  ValidationResult,
} from '@openmaic/dsl';
import { BrowserRuntimeStore } from '../src/runtime/browser.js';
import { assertJsonValue } from '../src/runtime/json-value.js';
import type {
  RuntimeAppendOptions,
  RuntimeSessionInit,
  RuntimeStore,
  RuntimeTailOptions,
} from '../src/runtime/types.js';
import { RuntimeAppendConflictError } from '../src/runtime/types.js';

export interface HttpConformanceServer {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

export interface HttpConformanceServerOptions {
  /** Bind a loopback TCP port. Tests can disable this in network-restricted sandboxes. */
  listen?: boolean;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

class ConformanceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    throw new ConformanceHttpError(400, 'VALIDATION_FAILED', 'request body must be a JSON object');
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConformanceHttpError(400, 'VALIDATION_FAILED', message);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ConformanceHttpError(400, 'VALIDATION_FAILED', 'request body must be a JSON object');
  }
  return body as T;
}

function errorResponse(error: unknown): { status: number; body: ErrorBody } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RuntimeAppendConflictError) {
    return {
      status: 409,
      body: {
        error: {
          code: 'RUNTIME_APPEND_CONFLICT',
          message,
          details: {
            sessionId: error.sessionId,
            expectedLastSeq: error.expectedLastSeq,
            actualLastSeq: error.actualLastSeq,
          },
        },
      },
    };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, body: { error: { code: 'VALIDATION_FAILED', message } } };
  }
  if (error instanceof ConformanceHttpError) {
    return { status: error.status, body: { error: { code: error.code, message } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message } } };
}

function validationError(result: ValidationResult, label: string): void {
  if (result.valid) return;
  const detail = result.errors.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  throw new ConformanceHttpError(400, 'VALIDATION_FAILED', `${label}: ${detail}`);
}

function assertAddressableSegment(value: string): void {
  if (value === '.' || value === '..') {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: URL path segment must not be ${JSON.stringify(value)}`,
    );
  }
}

function assertJsonRequestValue(value: unknown, label: string): void {
  try {
    assertJsonValue(value, label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConformanceHttpError(400, 'VALIDATION_FAILED', message);
  }
}

function missingSessionError(sessionId: string): ConformanceHttpError {
  return new ConformanceHttpError(
    404,
    'SESSION_NOT_FOUND',
    `@openmaic/storage: no session ${JSON.stringify(sessionId)}`,
  );
}

function assertNotFutureSession(session: RuntimeSession): void {
  const version = runtimeDslVersionOf(session);
  if (!needsRuntimeMigration(session) && version !== RUNTIME_DSL_VERSION) {
    throw new ConformanceHttpError(
      409,
      'FUTURE_VERSION',
      `@openmaic/storage: session ${JSON.stringify(session.id)} was written at runtime DSL ` +
        `version ${JSON.stringify(version)}, newer than this client's ${RUNTIME_DSL_VERSION}`,
    );
  }
}

function validatePayloadForKind(session: RuntimeSession, payload: unknown): void {
  if (session.kind === 'chat' && !isChatMessageSkeleton(payload)) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      '@openmaic/storage: invalid runtime record: /payload: chat payload must match ' +
        'ChatMessageSkeleton (role + content)',
    );
  }
  if (session.kind === 'quizAttempt' && !isQuizAttemptSkeleton(payload)) {
    throw new ConformanceHttpError(
      400,
      'VALIDATION_FAILED',
      '@openmaic/storage: invalid runtime record: /payload: quizAttempt payload must match ' +
        'QuizAttemptSkeleton (phase + answers)',
    );
  }
}

async function requireSession(store: RuntimeStore, sessionId: string): Promise<RuntimeSession> {
  const session = await store.getSession(sessionId);
  if (session === undefined) throw missingSessionError(sessionId);
  return session;
}

function pathParts(req: IncomingMessage): { parts: string[]; url: URL } {
  const url = new URL(req.url ?? '/', 'http://conformance.invalid');
  const parts = url.pathname.split('/');
  if (parts[0] === '') parts.shift();
  return {
    parts: parts.map((part) => decodeURIComponent(part)),
    url,
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  store: RuntimeStore,
): Promise<void> {
  const { parts, url } = pathParts(req);
  const method = req.method ?? 'GET';

  if (parts[0] !== 'runtime') {
    sendJson(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'route not found' } });
    return;
  }

  if (method === 'POST' && parts.length === 2 && parts[1] === 'sessions') {
    const init = await readJson<RuntimeSessionInit & { runtimeDslVersion?: unknown }>(req);
    assertAddressableSegment(init.id);
    assertAddressableSegment(init.stageId);
    assertAddressableSegment(init.learnerKey);
    validationError(
      validateRuntimeSession({ ...init, runtimeDslVersion: RUNTIME_DSL_VERSION }),
      `@openmaic/storage: invalid runtime session ${JSON.stringify(init.id)}`,
    );
    if (await store.getSession(init.id)) {
      throw new ConformanceHttpError(
        409,
        'SESSION_ALREADY_EXISTS',
        `@openmaic/storage: runtime session ${JSON.stringify(init.id)} already exists`,
      );
    }
    let created: RuntimeSession;
    try {
      created = await store.createSession(init);
    } catch (error) {
      if (await store.getSession(init.id)) {
        throw new ConformanceHttpError(
          409,
          'SESSION_ALREADY_EXISTS',
          `@openmaic/storage: runtime session ${JSON.stringify(init.id)} already exists`,
        );
      }
      throw error;
    }
    sendJson(res, 201, created);
    return;
  }

  if (parts[1] === 'sessions' && parts.length >= 3) {
    const sessionId = parts[2]!;
    if (method === 'GET' && parts.length === 3) {
      const session = await store.getSession(sessionId);
      if (session === undefined) {
        sendJson(res, 404, {
          error: {
            code: 'SESSION_NOT_FOUND',
            message: `@openmaic/storage: no session ${JSON.stringify(sessionId)}`,
          },
        });
      } else {
        sendJson(res, 200, session);
      }
      return;
    }
    if (method === 'PATCH' && parts.length === 4 && parts[3] === 'status') {
      const body = await readJson<
        { status: RuntimeSessionStatus; updatedAt: string } & RuntimeTailOptions
      >(req);
      const session = await requireSession(store, sessionId);
      assertNotFutureSession(session);
      validationError(
        validateRuntimeSession({ ...session, status: body.status, updatedAt: body.updatedAt }),
        `@openmaic/storage: invalid runtime session ${JSON.stringify(sessionId)}`,
      );
      await store.setSessionStatus(sessionId, body.status, body.updatedAt, {
        ...(body.expectedLastSeq === undefined ? {} : { expectedLastSeq: body.expectedLastSeq }),
      });
      sendNoContent(res);
      return;
    }
    if (method === 'DELETE' && parts.length === 3) {
      await store.deleteSession(sessionId);
      sendNoContent(res);
      return;
    }
    if (method === 'POST' && parts.length === 4 && parts[3] === 'records') {
      const body = await readJson<RuntimeRecordInit & RuntimeAppendOptions & { seq?: unknown }>(
        req,
      );
      const { expectedLastSeq, sessionTransition, ...init } = body;
      if (init.sessionId !== sessionId) {
        throw new ConformanceHttpError(
          400,
          'VALIDATION_FAILED',
          'invalid runtime record: body sessionId does not match the request path',
        );
      }
      validationError(
        validateRuntimeRecord({ ...init, seq: 0 }),
        `@openmaic/storage: invalid runtime record ${JSON.stringify(init.id)}`,
      );
      const session = await requireSession(store, sessionId);
      assertNotFutureSession(session);
      validatePayloadForKind(session, init.payload);
      if (session.status !== 'active') {
        throw new ConformanceHttpError(
          400,
          'VALIDATION_FAILED',
          `@openmaic/storage: cannot append to session ${JSON.stringify(sessionId)} with ` +
            `status '${session.status}' — records may only be appended to an active session`,
        );
      }
      sendJson(
        res,
        201,
        await store.appendRecord(init, {
          ...(expectedLastSeq === undefined ? {} : { expectedLastSeq }),
          ...(sessionTransition === undefined ? {} : { sessionTransition }),
        }),
      );
      return;
    }
    if (method === 'GET' && parts.length === 4 && parts[3] === 'records') {
      const sceneId = url.searchParams.get('sceneId');
      sendJson(
        res,
        200,
        await store.listRecords(sessionId, sceneId === null ? undefined : { sceneId }),
      );
      return;
    }
  }

  if (
    parts[1] === 'stages' &&
    parts.length === 6 &&
    parts[3] === 'learners' &&
    parts[5] === 'sessions' &&
    method === 'GET'
  ) {
    sendJson(res, 200, await store.listSessions(parts[2]!, parts[4]!));
    return;
  }

  if (parts[1] === 'learners' && parts[2] === 'merge' && parts.length === 3 && method === 'POST') {
    const body = await readJson<{ fromLearnerKey?: unknown; toLearnerKey?: unknown }>(req);
    if (
      typeof body.fromLearnerKey !== 'string' ||
      body.fromLearnerKey === '' ||
      typeof body.toLearnerKey !== 'string' ||
      body.toLearnerKey === ''
    ) {
      throw new ConformanceHttpError(
        400,
        'VALIDATION_FAILED',
        '@openmaic/storage: learner keys must be non-empty strings',
      );
    }
    assertAddressableSegment(body.toLearnerKey);
    assertJsonRequestValue(body.fromLearnerKey, 'runtime learner merge fromLearnerKey');
    assertJsonRequestValue(body.toLearnerKey, 'runtime learner merge toLearnerKey');
    assertAddressableSegment(body.toLearnerKey);
    sendJson(res, 200, {
      moved: await store.mergeLearner(body.fromLearnerKey, body.toLearnerKey),
    });
    return;
  }

  if (
    parts[1] === 'stages' &&
    parts.length === 5 &&
    parts[3] === 'learners' &&
    method === 'DELETE'
  ) {
    await store.deleteLearnerRuntime(parts[2]!, parts[4]!);
    sendNoContent(res);
    return;
  }

  if (parts[1] === 'stages' && parts.length === 3 && method === 'DELETE') {
    await store.deleteStageRuntime(parts[2]!);
    sendNoContent(res);
    return;
  }

  if (parts.length === 1 && method === 'DELETE') {
    await store.deleteAllRuntime();
    sendNoContent(res);
    return;
  }

  sendJson(res, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'route not found' } });
}

/**
 * Start a test-only HTTP adapter. Each `x-runtime-store-id` value selects a
 * fresh BrowserRuntimeStore so factories used by the shared contract remain
 * isolated without duplicating any persistence logic in this server.
 */
export async function startHttpConformanceServer(
  options: HttpConformanceServerOptions = {},
): Promise<HttpConformanceServer> {
  const stores = new Map<string, RuntimeStore>();
  const storeFor = (req: IncomingMessage): RuntimeStore => {
    const id = req.headers['x-runtime-store-id'];
    const namespace = typeof id === 'string' && id !== '' ? id : 'default';
    let store = stores.get(namespace);
    if (!store) {
      store = new BrowserRuntimeStore({
        indexedDB: new IDBFactory(),
        dbName: `http-runtime-${namespace}`,
      });
      stores.set(namespace, store);
    }
    return store;
  };

  const server = createServer((req, res) => {
    void route(req, res, storeFor(req)).catch((error: unknown) => {
      const mapped = errorResponse(error);
      sendJson(res, mapped.status, mapped.body);
    });
  });

  let baseUrl = 'http://runtime-conformance.invalid';
  if (options.listen !== false) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('HTTP conformance server did not bind a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  const injectedFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const requestBody = await request.text();
    const fakeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers.entries()),
      async *[Symbol.asyncIterator]() {
        if (requestBody !== '') yield Buffer.from(requestBody);
      },
    } as unknown as IncomingMessage;

    let status = 200;
    let responseHeaders: Record<string, string> = {};
    let responseBody: string | undefined;
    const fakeResponse = {
      writeHead(nextStatus: number, headers?: Record<string, string>) {
        status = nextStatus;
        responseHeaders = headers ?? {};
        return this;
      },
      end(chunk?: string) {
        responseBody = chunk;
        return this;
      },
    } as unknown as ServerResponse;

    try {
      await route(fakeRequest, fakeResponse, storeFor(fakeRequest));
    } catch (error) {
      const mapped = errorResponse(error);
      status = mapped.status;
      responseHeaders = { 'content-type': 'application/json' };
      responseBody = JSON.stringify(mapped.body);
    }
    return new Response(status === 204 ? null : responseBody, {
      status,
      headers: responseHeaders,
    });
  };

  return {
    baseUrl,
    fetch: injectedFetch,
    close: () =>
      server.listening
        ? new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          })
        : Promise.resolve(),
  };
}
