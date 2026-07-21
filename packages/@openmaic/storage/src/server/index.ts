import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
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
import { assertJsonValue } from '../runtime/json-value.js';
import type {
  RuntimePayloadValidator,
  RuntimeSessionInit,
  RuntimeStore,
} from '../runtime/types.js';

export interface RuntimeHttpPrincipal {
  learnerKey?: string;
}

export type RuntimeHttpAuthenticate = (
  req: IncomingMessage,
) => Promise<RuntimeHttpPrincipal | undefined>;

export type RuntimeHttpAuthorizeMerge = (
  principal: RuntimeHttpPrincipal,
  fromKey: string,
  toKey: string,
) => boolean | Promise<boolean>;

export type RuntimeHttpAuthorizeAdmin = (
  principal: RuntimeHttpPrincipal,
) => boolean | Promise<boolean>;

export interface RuntimeHttpHandlerOptions {
  authenticate: RuntimeHttpAuthenticate;
  authorizeMerge?: RuntimeHttpAuthorizeMerge;
  authorizeAdmin?: RuntimeHttpAuthorizeAdmin;
  /**
   * Per-kind payload validators. This REPLACES the default DSL skeleton table;
   * pass the same table configured on the injected store.
   */
  payloadValidators?: Record<string, RuntimePayloadValidator>;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

class RuntimeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
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
    throw validationFailure('request body must be a JSON object');
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw validationFailure(error instanceof Error ? error.message : String(error));
  }
  if (!isObject(body)) throw validationFailure('request body must be a JSON object');
  return body as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationFailure(message: string, details?: unknown): RuntimeHttpError {
  return new RuntimeHttpError(400, 'VALIDATION_FAILED', message, details);
}

function validationError(result: ValidationResult, label: string): void {
  if (result.valid) return;
  const details = result.errors;
  const detail = details.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  throw validationFailure(`${label}: ${detail}`, details);
}

function assertAddressableSegment(
  value: unknown,
  label = 'URL path segment',
): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    throw validationFailure(`@openmaic/storage: ${label} must be a non-empty string`);
  }
  if (value === '.' || value === '..') {
    throw validationFailure(
      `@openmaic/storage: URL path segment must not be ${JSON.stringify(value)}`,
    );
  }
}

function assertJsonRequestValue(value: unknown, label: string): void {
  try {
    assertJsonValue(value, label);
  } catch (error) {
    throw validationFailure(error instanceof Error ? error.message : String(error));
  }
}

const DEFAULT_PAYLOAD_VALIDATORS: Record<string, RuntimePayloadValidator> = {
  chat: (payload) =>
    isChatMessageSkeleton(payload)
      ? { valid: true }
      : {
          valid: false,
          errors: [
            {
              path: '/payload',
              message: 'chat payload must match ChatMessageSkeleton (role + content)',
            },
          ],
        },
  quizAttempt: (payload) =>
    isQuizAttemptSkeleton(payload)
      ? { valid: true }
      : {
          valid: false,
          errors: [
            {
              path: '/payload',
              message: 'quizAttempt payload must match QuizAttemptSkeleton (phase + answers)',
            },
          ],
        },
};

function missingSessionError(sessionId: string): RuntimeHttpError {
  return new RuntimeHttpError(
    404,
    'SESSION_NOT_FOUND',
    `@openmaic/storage: no session ${JSON.stringify(sessionId)}`,
  );
}

function assertNotFutureSession(session: RuntimeSession): void {
  const version = runtimeDslVersionOf(session);
  if (!needsRuntimeMigration(session) && version !== RUNTIME_DSL_VERSION) {
    throw new RuntimeHttpError(
      409,
      'FUTURE_VERSION',
      `@openmaic/storage: session ${JSON.stringify(session.id)} was written at runtime DSL ` +
        `version ${JSON.stringify(version)}, newer than this client's ${RUNTIME_DSL_VERSION}`,
    );
  }
}

function validatePayloadForKind(
  session: RuntimeSession,
  recordId: string,
  payload: unknown,
  payloadValidators: Record<string, RuntimePayloadValidator>,
): void {
  const validator = Object.hasOwn(payloadValidators, session.kind)
    ? payloadValidators[session.kind]
    : undefined;
  if (validator) {
    validationError(
      validator(payload),
      `@openmaic/storage: invalid runtime record ${JSON.stringify(recordId)}`,
    );
  }
}

function forbiddenLearner(): RuntimeHttpError {
  return new RuntimeHttpError(
    403,
    'FORBIDDEN_LEARNER',
    '@openmaic/storage: authenticated learner may not access the requested learner partition',
  );
}

function forbiddenAdmin(): RuntimeHttpError {
  return new RuntimeHttpError(
    403,
    'FORBIDDEN_ADMIN',
    '@openmaic/storage: admin authorization required',
  );
}

function requireLearner(principal: RuntimeHttpPrincipal, learnerKey: string): void {
  if (principal.learnerKey !== learnerKey) throw forbiddenLearner();
}

function requireLearnerCapability(principal: RuntimeHttpPrincipal): asserts principal is {
  learnerKey: string;
} {
  if (principal.learnerKey === undefined) throw forbiddenLearner();
}

async function existingSessionOwnedByPrincipal(
  store: RuntimeStore,
  principal: RuntimeHttpPrincipal,
  sessionId: string,
): Promise<RuntimeSession | undefined> {
  requireLearnerCapability(principal);
  const session = await store.getSession(sessionId);
  if (session === undefined) return undefined;
  if (session.learnerKey !== principal.learnerKey) throw missingSessionError(sessionId);
  return session;
}

async function ownedSession(
  store: RuntimeStore,
  principal: RuntimeHttpPrincipal,
  sessionId: string,
): Promise<RuntimeSession> {
  const session = await existingSessionOwnedByPrincipal(store, principal, sessionId);
  if (session === undefined) throw missingSessionError(sessionId);
  return session;
}

async function writableSession(
  store: RuntimeStore,
  principal: RuntimeHttpPrincipal,
  sessionId: string,
): Promise<RuntimeSession> {
  const session = await ownedSession(store, principal, sessionId);
  assertNotFutureSession(session);
  return session;
}

async function rethrowClassifiedSessionWriteFailure(
  store: RuntimeStore,
  principal: RuntimeHttpPrincipal,
  sessionId: string,
  error: unknown,
): Promise<never> {
  let current: RuntimeSession | undefined;
  try {
    current = await existingSessionOwnedByPrincipal(store, principal, sessionId);
  } catch (classificationError) {
    if (classificationError instanceof RuntimeHttpError) throw classificationError;
    throw error;
  }
  if (current === undefined) throw missingSessionError(sessionId);
  assertNotFutureSession(current);
  if (current.status !== 'active') {
    throw validationFailure(
      `@openmaic/storage: session ${JSON.stringify(sessionId)} is no longer active; ` +
        `its current status is '${current.status}'`,
    );
  }
  throw error;
}

async function rethrowClassifiedMergeFailure(
  store: RuntimeStore,
  fromLearnerKey: string,
  error: unknown,
): Promise<never> {
  // RuntimeStore predates typed write errors. Narrowly extract the id from the
  // contract's canonical future-version error, then use a structured read as
  // the authority: message text alone never determines the HTTP response.
  const match =
    error instanceof Error
      ? /^@openmaic\/storage: session ("(?:[^"\\]|\\.)*") was written at runtime DSL version /.exec(
          error.message,
        )
      : null;
  if (match?.[1] !== undefined) {
    let sessionId: unknown;
    try {
      sessionId = JSON.parse(match[1]) as unknown;
    } catch {
      throw error;
    }
    if (typeof sessionId === 'string') {
      let current: RuntimeSession | undefined;
      try {
        current = await store.getSession(sessionId);
      } catch {
        throw error;
      }
      if (current?.learnerKey === fromLearnerKey) assertNotFutureSession(current);
    }
  }
  throw error;
}

function parsePath(req: IncomingMessage): { parts: string[]; url: URL } {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://runtime.invalid');
    const parts = url.pathname
      .split('/')
      .filter((part, index) => index !== 0 || part !== '')
      .map((part) => decodeURIComponent(part));
    return { parts, url };
  } catch (error) {
    throw validationFailure(error instanceof Error ? error.message : String(error));
  }
}

function mappedError(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof RuntimeHttpError && error.status < 500) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: '@openmaic/storage: internal server error',
      },
    },
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  store: RuntimeStore,
  options: RuntimeHttpHandlerOptions,
): Promise<void> {
  const { parts, url } = parsePath(req);
  const method = req.method ?? 'GET';
  if (parts[0] !== 'runtime') {
    throw new RuntimeHttpError(404, 'ROUTE_NOT_FOUND', 'route not found');
  }

  const principal = await options.authenticate(req);
  if (principal === undefined) {
    throw new RuntimeHttpError(
      401,
      'UNAUTHENTICATED',
      '@openmaic/storage: authentication required',
    );
  }
  if (
    principal.learnerKey !== undefined &&
    (typeof principal.learnerKey !== 'string' || principal.learnerKey === '')
  ) {
    throw new RuntimeHttpError(
      500,
      'INTERNAL_ERROR',
      '@openmaic/storage: authenticate returned an invalid principal',
    );
  }

  if (method === 'POST' && parts.length === 2 && parts[1] === 'sessions') {
    const init = await readJson<RuntimeSessionInit & { runtimeDslVersion?: unknown }>(req);
    assertAddressableSegment(init.id);
    assertAddressableSegment(init.stageId);
    assertAddressableSegment(init.learnerKey, 'learnerKey');
    requireLearner(principal, init.learnerKey);
    validationError(
      validateRuntimeSession({ ...init, runtimeDslVersion: RUNTIME_DSL_VERSION }),
      `@openmaic/storage: invalid runtime session ${JSON.stringify(init.id)}`,
    );
    assertJsonRequestValue(
      { ...init, runtimeDslVersion: RUNTIME_DSL_VERSION },
      `runtime session ${JSON.stringify(init.id)}`,
    );
    const existing = await store.getSession(init.id);
    if (existing !== undefined) {
      requireLearner(principal, existing.learnerKey);
      throw new RuntimeHttpError(
        409,
        'SESSION_ALREADY_EXISTS',
        `@openmaic/storage: session ${JSON.stringify(init.id)} already exists`,
      );
    }
    try {
      sendJson(res, 201, await store.createSession(init));
    } catch (error) {
      // A post-failure existence check classifies duplicate races without
      // depending on a database driver's message text.
      const raced = await store.getSession(init.id);
      if (raced !== undefined) {
        requireLearner(principal, raced.learnerKey);
        throw new RuntimeHttpError(
          409,
          'SESSION_ALREADY_EXISTS',
          `@openmaic/storage: session ${JSON.stringify(init.id)} already exists`,
        );
      }
      throw error;
    }
    return;
  }

  if (parts[1] === 'sessions' && parts.length >= 3) {
    const sessionId = parts[2]!;
    assertAddressableSegment(sessionId);
    if (method === 'GET' && parts.length === 3) {
      sendJson(res, 200, await ownedSession(store, principal, sessionId));
      return;
    }
    if (method === 'PATCH' && parts.length === 4 && parts[3] === 'status') {
      const body = await readJson<{ status: RuntimeSessionStatus; updatedAt: string }>(req);
      const session = await writableSession(store, principal, sessionId);
      validationError(
        validateRuntimeSession({ ...session, status: body.status, updatedAt: body.updatedAt }),
        `@openmaic/storage: invalid runtime session ${JSON.stringify(sessionId)}`,
      );
      try {
        await store.setSessionStatus(sessionId, body.status, body.updatedAt);
      } catch (error) {
        await rethrowClassifiedSessionWriteFailure(store, principal, sessionId, error);
      }
      sendNoContent(res);
      return;
    }
    if (method === 'DELETE' && parts.length === 3) {
      const session = await existingSessionOwnedByPrincipal(store, principal, sessionId);
      if (session === undefined) {
        sendNoContent(res);
        return;
      }
      // Re-read ownership immediately before deletion. A concurrent merge after
      // this check is linearized after this delete; see the documented threat model.
      const rechecked = await existingSessionOwnedByPrincipal(store, principal, sessionId);
      if (rechecked === undefined) {
        sendNoContent(res);
        return;
      }
      await store.deleteSession(sessionId);
      sendNoContent(res);
      return;
    }
    if (method === 'POST' && parts.length === 4 && parts[3] === 'records') {
      const init = await readJson<RuntimeRecordInit & { seq?: unknown }>(req);
      if (init.sessionId !== sessionId) {
        throw validationFailure(
          'invalid runtime record: body sessionId does not match the request path',
        );
      }
      validationError(
        validateRuntimeRecord({ ...init, seq: 0 }),
        `@openmaic/storage: invalid runtime record ${JSON.stringify(init.id)}`,
      );
      const normalizedRecord = { ...init, seq: 0 } as Record<string, unknown>;
      for (const key of ['sceneId', 'actionIndex', 'subAnchor']) {
        if (normalizedRecord[key] === undefined) delete normalizedRecord[key];
      }
      assertJsonRequestValue(normalizedRecord, `runtime record ${JSON.stringify(init.id)}`);
      const session = await writableSession(store, principal, sessionId);
      validatePayloadForKind(
        session,
        init.id,
        init.payload,
        options.payloadValidators ?? DEFAULT_PAYLOAD_VALIDATORS,
      );
      if (session.status !== 'active') {
        throw validationFailure(
          `@openmaic/storage: cannot append to session ${JSON.stringify(sessionId)} with ` +
            `status '${session.status}' — records may only be appended to an active session`,
        );
      }
      try {
        sendJson(res, 201, await store.appendRecord(init));
      } catch (error) {
        await rethrowClassifiedSessionWriteFailure(store, principal, sessionId, error);
      }
      return;
    }
    if (method === 'GET' && parts.length === 4 && parts[3] === 'records') {
      requireLearnerCapability(principal);
      const session = await store.getSession(sessionId);
      // Absent and foreign sessions answer identically (404), so the status
      // cannot become an existence oracle; clients restore the store
      // contract's "absent lists as empty" by mapping SESSION_NOT_FOUND to [].
      if (session === undefined || session.learnerKey !== principal.learnerKey) {
        throw missingSessionError(sessionId);
      }
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
    method === 'GET' &&
    parts.length === 6 &&
    parts[1] === 'stages' &&
    parts[3] === 'learners' &&
    parts[5] === 'sessions'
  ) {
    const stageId = parts[2]!;
    const learnerKey = parts[4]!;
    assertAddressableSegment(stageId);
    assertAddressableSegment(learnerKey);
    requireLearner(principal, learnerKey);
    const sessions = await store.listSessions(stageId, learnerKey);
    sendJson(res, 200, sessions);
    return;
  }

  if (method === 'POST' && parts.length === 3 && parts[1] === 'learners' && parts[2] === 'merge') {
    const body = await readJson<{ fromLearnerKey?: unknown; toLearnerKey?: unknown }>(req);
    if (
      typeof body.fromLearnerKey !== 'string' ||
      body.fromLearnerKey === '' ||
      typeof body.toLearnerKey !== 'string' ||
      body.toLearnerKey === ''
    ) {
      throw validationFailure('@openmaic/storage: learner keys must be non-empty strings');
    }
    assertAddressableSegment(body.fromLearnerKey);
    assertAddressableSegment(body.toLearnerKey);
    assertJsonRequestValue(body.fromLearnerKey, 'runtime learner merge fromLearnerKey');
    assertJsonRequestValue(body.toLearnerKey, 'runtime learner merge toLearnerKey');
    if (!(await options.authorizeMerge?.(principal, body.fromLearnerKey, body.toLearnerKey))) {
      throw forbiddenLearner();
    }
    try {
      sendJson(res, 200, {
        moved: await store.mergeLearner(body.fromLearnerKey, body.toLearnerKey),
      });
    } catch (error) {
      await rethrowClassifiedMergeFailure(store, body.fromLearnerKey, error);
    }
    return;
  }

  if (
    method === 'DELETE' &&
    parts.length === 5 &&
    parts[1] === 'stages' &&
    parts[3] === 'learners'
  ) {
    const stageId = parts[2]!;
    const learnerKey = parts[4]!;
    assertAddressableSegment(stageId);
    assertAddressableSegment(learnerKey);
    requireLearner(principal, learnerKey);
    await store.deleteLearnerRuntime(stageId, learnerKey);
    sendNoContent(res);
    return;
  }

  if (method === 'DELETE' && parts.length === 1) {
    if (!(await options.authorizeAdmin?.(principal))) throw forbiddenAdmin();
    await store.deleteAllRuntime();
    sendNoContent(res);
    return;
  }

  if (method === 'DELETE' && parts.length === 3 && parts[1] === 'stages') {
    const stageId = parts[2]!;
    assertAddressableSegment(stageId);
    if (!(await options.authorizeAdmin?.(principal))) throw forbiddenAdmin();
    await store.deleteStageRuntime(stageId);
    sendNoContent(res);
    return;
  }

  throw new RuntimeHttpError(404, 'ROUTE_NOT_FOUND', 'route not found');
}

/** Create a Node HTTP request handler for the complete RuntimeStore contract. */
export function createRuntimeHttpHandler(
  store: RuntimeStore,
  options: RuntimeHttpHandlerOptions,
): RequestListener {
  if (typeof options?.authenticate !== 'function') {
    throw new Error('@openmaic/storage: createRuntimeHttpHandler requires authenticate');
  }
  return (req, res) => {
    void route(req, res, store, options).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (!(error instanceof RuntimeHttpError) || error.status >= 500) {
        console.error('@openmaic/storage: Runtime HTTP handler internal error', error);
      }
      const mapped = mappedError(error);
      sendJson(res, mapped.status, mapped.body);
    });
  };
}
