import { migrateRuntime, validateRuntimeRecord, validateRuntimeSession } from '@openmaic/dsl';
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
  RuntimeSessionStatus,
} from '@openmaic/dsl';
import type { RuntimeSessionInit, RuntimeStore } from './types.js';
import { assertJsonValue } from './json-value.js';

export interface HttpRuntimeHeadersContext {
  method: string;
  path: string;
}

export type HttpRuntimeHeadersHook = (
  context: HttpRuntimeHeadersContext,
) => HeadersInit | Promise<HeadersInit>;

export interface HttpRuntimeStoreOptions {
  /** Root URL before the contract's `/runtime/...` paths. */
  baseUrl: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Called for every request so deployments can attach authentication headers. */
  headers?: HttpRuntimeHeadersHook;
}

interface ErrorResponseBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

/** A server-side RuntimeStore failure, retaining its machine-readable HTTP identity. */
export class HttpRuntimeStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpRuntimeStoreError';
    this.status = status;
    this.code = code;
  }
}

function assertAddressableSegment(value: string): void {
  if (value === '.' || value === '..') {
    throw new Error(`@openmaic/storage: URL path segment must not be ${JSON.stringify(value)}`);
  }
}

function segment(value: string): string {
  assertAddressableSegment(value);
  return encodeURIComponent(value);
}

const OPTIONAL_RECORD_ANCHORS = ['sceneId', 'actionIndex', 'subAnchor'] as const;

/**
 * Drop the DSL-declared optional anchors when they are explicitly undefined —
 * for those keys undefined means "omitted" throughout the DSL and JSON
 * produces the identical envelope. Any other undefined member still reaches
 * the JSON gate and fails loud, so unknown fields cannot be dropped silently.
 */
function withoutUndefinedAnchors<T extends object>(value: T): T {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of OPTIONAL_RECORD_ANCHORS) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (descriptor && 'value' in descriptor && descriptor.value === undefined) {
      delete descriptors[key as keyof typeof descriptors];
    }
  }
  return Object.create(Object.getPrototypeOf(value), descriptors) as T;
}

function assertValidSession(session: RuntimeSession): RuntimeSession {
  const result = validateRuntimeSession(session);
  if (result.valid) return session;
  const detail = result.errors.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  const id = typeof session === 'object' && session !== null ? session.id : undefined;
  throw new Error(
    `@openmaic/storage: invalid stored runtime session ${JSON.stringify(id)}: ${detail}`,
  );
}

function assertValidRecord<TPayload extends RuntimePayload>(
  record: RuntimeRecord<TPayload>,
): RuntimeRecord<TPayload> {
  const result = validateRuntimeRecord(record);
  if (result.valid) return record;
  const detail = result.errors.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  const id = typeof record === 'object' && record !== null ? record.id : undefined;
  throw new Error(
    `@openmaic/storage: invalid stored runtime record ${JSON.stringify(id)}: ${detail}`,
  );
}

function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  const set = (name: string, value: string): void => {
    normalized[name.toLowerCase()] = value;
  };

  if (init === undefined) return normalized;
  if (Array.isArray(init)) {
    for (const [name, value] of init) set(name, value);
    return normalized;
  }
  if (typeof (init as Headers).forEach === 'function') {
    (init as Headers).forEach((value, name) => set(name, value));
    return normalized;
  }
  for (const [name, value] of Object.entries(init)) set(name, value);
  return normalized;
}

/**
 * RuntimeStore client for the JSON HTTP contract. Session reads migrate again
 * on the client so a server running an older schema cannot leak stale envelopes
 * into a newer application.
 */
export class HttpRuntimeStore implements RuntimeStore {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headersHook: HttpRuntimeHeadersHook | undefined;

  constructor(options: HttpRuntimeStoreOptions) {
    if (options.baseUrl === '') {
      throw new Error('@openmaic/storage: HttpRuntimeStore baseUrl must be non-empty');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('@openmaic/storage: HttpRuntimeStore requires a fetch implementation');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.headersHook = options.headers;
  }

  private async requestWithStatus<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ body: T; status: number }> {
    const headers = normalizeHeaders(await this.headersHook?.({ method, path }));
    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers['content-type'] ??= 'application/json';
      serializedBody = JSON.stringify(body);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    });
    if (!response.ok) {
      let errorBody: ErrorResponseBody | undefined;
      try {
        errorBody = (await response.json()) as ErrorResponseBody;
      } catch {
        // A non-conforming server still becomes a useful typed HTTP error.
      }
      const code = typeof errorBody?.error?.code === 'string' ? errorBody.error.code : 'HTTP_ERROR';
      const message =
        typeof errorBody?.error?.message === 'string'
          ? errorBody.error.message
          : `@openmaic/storage: RuntimeStore HTTP request failed with status ${response.status}`;
      throw new HttpRuntimeStoreError(response.status, code, message);
    }
    if (response.status === 204) return { body: undefined as T, status: response.status };
    return { body: (await response.json()) as T, status: response.status };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.requestWithStatus<T>(method, path, body)).body;
  }

  private migrateSession(session: RuntimeSession): RuntimeSession {
    return assertValidSession(migrateRuntime(session) as RuntimeSession);
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    assertJsonValue(init, `runtime session ${JSON.stringify(init.id)}`);
    assertAddressableSegment(init.id);
    assertAddressableSegment(init.stageId);
    assertAddressableSegment(init.learnerKey);
    const session = await this.request<RuntimeSession>('POST', '/runtime/sessions', init);
    return this.migrateSession(session);
  }

  async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
    try {
      const session = await this.request<RuntimeSession>(
        'GET',
        `/runtime/sessions/${segment(sessionId)}`,
      );
      return this.migrateSession(session);
    } catch (error) {
      if (error instanceof HttpRuntimeStoreError && error.code === 'SESSION_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    const response = await this.requestWithStatus<unknown>(
      'GET',
      `/runtime/stages/${segment(stageId)}/learners/${segment(learnerKey)}/sessions`,
    );
    if (!Array.isArray(response.body)) {
      throw new HttpRuntimeStoreError(
        response.status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: RuntimeStore HTTP listSessions response must be an array',
      );
    }
    const sessions = response.body as RuntimeSession[];
    const migrated: RuntimeSession[] = [];
    for (const session of sessions) {
      try {
        migrated.push(this.migrateSession(session));
      } catch {
        // Match BrowserRuntimeStore: corrupt partition rows are omitted.
      }
    }
    return migrated.sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async setSessionStatus(
    sessionId: string,
    status: RuntimeSessionStatus,
    updatedAt: string,
  ): Promise<void> {
    await this.request<void>('PATCH', `/runtime/sessions/${segment(sessionId)}/status`, {
      status,
      updatedAt,
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<void>('DELETE', `/runtime/sessions/${segment(sessionId)}`);
  }

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    assertJsonValue(init.payload, `runtime record ${JSON.stringify(init.id)} payload`);
    const normalizedInit = withoutUndefinedAnchors(init);
    assertJsonValue(normalizedInit, `runtime record ${JSON.stringify(init.id)}`);
    const record = await this.request<RuntimeRecord<TPayload>>(
      'POST',
      `/runtime/sessions/${segment(init.sessionId)}/records`,
      normalizedInit,
    );
    return assertValidRecord(record);
  }

  async listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]> {
    const query = opts?.sceneId === undefined ? '' : `?sceneId=${encodeURIComponent(opts.sceneId)}`;
    let response;
    try {
      response = await this.requestWithStatus<unknown>(
        'GET',
        `/runtime/sessions/${segment(sessionId)}/records${query}`,
      );
    } catch (error) {
      // Servers may conceal session existence by answering 404 for absent
      // sessions on this route; the store contract lists them as empty.
      if (error instanceof HttpRuntimeStoreError && error.code === 'SESSION_NOT_FOUND') {
        return [];
      }
      throw error;
    }
    if (!Array.isArray(response.body)) {
      throw new HttpRuntimeStoreError(
        response.status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: RuntimeStore HTTP listRecords response must be an array',
      );
    }
    const records = response.body as RuntimeRecord[];
    return records.map((record) => assertValidRecord(record)).sort((a, b) => a.seq - b.seq);
  }

  async mergeLearner(fromLearnerKey: string, toLearnerKey: string): Promise<number> {
    assertJsonValue(fromLearnerKey, 'runtime learner merge fromLearnerKey');
    assertJsonValue(toLearnerKey, 'runtime learner merge toLearnerKey');
    assertAddressableSegment(toLearnerKey);
    const response = await this.requestWithStatus<unknown>('POST', '/runtime/learners/merge', {
      fromLearnerKey,
      toLearnerKey,
    });
    const moved =
      typeof response.body === 'object' && response.body !== null && 'moved' in response.body
        ? response.body.moved
        : undefined;
    if (typeof moved !== 'number' || !Number.isInteger(moved) || moved < 0) {
      throw new HttpRuntimeStoreError(
        response.status,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: RuntimeStore HTTP mergeLearner response moved must be a non-negative integer',
      );
    }
    return moved;
  }

  async deleteLearnerRuntime(stageId: string, learnerKey: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/runtime/stages/${segment(stageId)}/learners/${segment(learnerKey)}`,
    );
  }

  async deleteStageRuntime(stageId: string): Promise<void> {
    await this.request<void>('DELETE', `/runtime/stages/${segment(stageId)}`);
  }

  async deleteAllRuntime(): Promise<void> {
    await this.request<void>('DELETE', '/runtime');
  }
}
