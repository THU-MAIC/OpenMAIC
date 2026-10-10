import { migrate, validateScene, validateStage } from '@openmaic/dsl';
import type { Scene, Stage } from '@openmaic/dsl';
import { assertJsonValue } from '../runtime/json-value.js';
import type {
  DocumentStore,
  DocumentSummary,
  MaicDocument,
  SceneLike,
  SceneValidator,
  StageValidator,
} from './types.js';
import { DocumentVersionError } from './types.js';

export interface HttpDocumentHeadersContext {
  method: string;
  path: string;
}

export type HttpDocumentHeadersHook = (
  context: HttpDocumentHeadersContext,
) => HeadersInit | Promise<HeadersInit>;

export interface HttpDocumentStoreOptions {
  /** Root URL before the contract's `/documents/...` paths. */
  baseUrl: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * The floor of a request's deadline, in milliseconds: what a request with
   * no body gets, and the size-independent part of any other request's
   * budget. A request that carries a body is given additional time
   * proportional to that body, at a conservative upload throughput and up to
   * a ceiling — both fixed in this module — so a large document on a slow
   * link is not mistaken for a stall.
   *
   * The deadline covers the request round trip — sending the body and
   * receiving the response headers — so an endpoint that stops answering
   * fails like any other transport error instead of holding its caller
   * forever. Reading the response body is deliberately outside the bound.
   * `<= 0` disables the deadline entirely. Defaults to
   * `DEFAULT_REQUEST_TIMEOUT_MS`.
   */
  requestTimeoutMs?: number;
  /** Called for every request so deployments can attach authentication headers. */
  headers?: HttpDocumentHeadersHook;
  /** Client-side scene validator. Defaults to the DSL validator. */
  validateScene?: SceneValidator;
  /** Client-side stage validator. Defaults to the DSL validator. */
  validateStage?: StageValidator;
}

interface ErrorResponseBody {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

interface DocumentVersionErrorDetails {
  storedVersion?: unknown;
}

/** A server-side DocumentStore failure, retaining its machine-readable HTTP identity. */
export class HttpDocumentStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpDocumentStoreError';
  }
}

/**
 * The floor of a request's budget: how long a request that carries no body
 * may go without settling before it is aborted.
 *
 * What this bound exists to stop is not slowness but a request that never
 * settles at all — the autosave holds at most one save in flight and starts
 * the next one only once that promise settles, so a request that hangs
 * forever strands every later save for the life of the page, silently.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The upload throughput a request's budget is sized against, in bytes per
 * second. Deliberately pessimistic — below a 1 Mbps link — so the budget errs
 * towards waiting: waiting too long costs one late retry, while giving up too
 * early costs the save entirely, because every retry meets the same budget.
 */
const ASSUMED_UPLOAD_BYTES_PER_SECOND = 100 * 1024;

/**
 * The ceiling on any one request's budget, in milliseconds. Comfortably above
 * what the largest body the server accepts (32 MiB) needs at
 * `ASSUMED_UPLOAD_BYTES_PER_SECOND`, so the ceiling catches a pathological
 * body rather than a legitimately large one.
 */
const MAX_REQUEST_TIMEOUT_MS = 10 * 60_000;

/**
 * The deadline for one request: `floorMs` plus the time a body of
 * `bodyBytes` needs at `ASSUMED_UPLOAD_BYTES_PER_SECOND`, capped at
 * `MAX_REQUEST_TIMEOUT_MS`.
 *
 * The deadline spans sending the body as well as waiting for the response
 * headers, so a single absolute budget would abort a large save on a slow
 * link on every attempt — and, because each retry meets the same budget, such
 * a save could never complete at all, which is worse than the unbounded wait
 * this bound replaces. Sizing the budget from the body keeps the bound
 * meaningful without putting the documents the server accepts out of reach.
 */
function requestBudgetMs(floorMs: number, bodyBytes: number): number {
  const uploadMs = Math.ceil((bodyBytes / ASSUMED_UPLOAD_BYTES_PER_SECOND) * 1000);
  return Math.min(MAX_REQUEST_TIMEOUT_MS, floorMs + uploadMs);
}

/**
 * The UTF-8 length of `value`, without materialising the encoded bytes —
 * `String#length` counts UTF-16 code units, which undercounts every non-ASCII
 * character, and the body of a save is full of them.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair: two code units encoding one four-byte character.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** One absolute deadline for one request; `settle()` clears the timer. */
interface RequestDeadline {
  readonly signal: AbortSignal;
  settle(): void;
}

/**
 * Start a request's deadline, mirroring the asset store's bounded-operation
 * budget (`asset/http.ts`) so both HTTP stores treat a stalled persistence
 * endpoint the same way. A non-positive budget returns null: no deadline.
 */
function startRequestDeadline(timeoutMs: number): RequestDeadline | null {
  if (timeoutMs <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, settle: () => clearTimeout(timer) };
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

function assertValid(result: ReturnType<StageValidator>, label: string): void {
  if (result.valid) return;
  const detail = result.errors.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  throw new Error(`@openmaic/storage: invalid ${label}: ${detail}`);
}

function assertStorableScene(scene: SceneLike, stageId: string): void {
  const value = scene as { id: unknown; stageId: unknown; order: unknown };
  if (typeof value.id !== 'string') {
    throw new Error(
      `@openmaic/storage: scene id must be a string, got ${JSON.stringify(value.id)}`,
    );
  }
  if (value.stageId !== stageId) {
    throw new Error(
      `@openmaic/storage: scene ${JSON.stringify(value.id)} has stageId ` +
        `${JSON.stringify(value.stageId)} but belongs to document ${JSON.stringify(stageId)}`,
    );
  }
  if (typeof value.order !== 'number' || !Number.isFinite(value.order)) {
    throw new Error(
      `@openmaic/storage: scene ${JSON.stringify(value.id)} order must be a finite number, got ` +
        `${JSON.stringify(value.order)}`,
    );
  }
}

function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  const set = (name: string, value: string): void => {
    normalized[name.toLowerCase()] = value;
  };
  if (init === undefined) return normalized;
  if (Array.isArray(init)) {
    for (const [name, value] of init) set(name, value);
  } else if (typeof (init as Headers).forEach === 'function') {
    (init as Headers).forEach((value, name) => set(name, value));
  } else {
    for (const [name, value] of Object.entries(init)) set(name, value);
  }
  return normalized;
}

function migrateDocument<TScene extends SceneLike, TStage extends Stage>(
  document: MaicDocument<TScene, TStage>,
): MaicDocument<TScene, TStage> {
  const { outline, ...core } = document;
  const migrated = migrate(core) as MaicDocument<TScene, TStage>;
  return outline === undefined ? migrated : { ...migrated, outline };
}

export class HttpDocumentStore<
  TScene extends SceneLike = Scene,
  TStage extends Stage = Stage,
> implements DocumentStore<TScene, TStage> {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly headersHook: HttpDocumentHeadersHook | undefined;
  private readonly validateSceneFn: SceneValidator;
  private readonly validateStageFn: StageValidator;

  constructor(options: HttpDocumentStoreOptions) {
    if (options.baseUrl === '') {
      throw new Error('@openmaic/storage: HttpDocumentStore baseUrl must be non-empty');
    }
    // Bind explicitly: browsers require fetch to be invoked with `this === globalThis`
    // (calling a stored reference as `this.fetchImpl(...)` throws "Illegal
    // invocation"), while node's undici does not care — which is exactly why
    // node-only test suites cannot catch the unbound form.
    // Validate BEFORE binding: .bind on a non-function throws a native
    // TypeError that would preempt the documented error below.
    const selectedFetch = options.fetch ?? globalThis.fetch;
    if (typeof selectedFetch !== 'function') {
      throw new Error('@openmaic/storage: HttpDocumentStore requires a fetch implementation');
    }
    const fetchImpl = selectedFetch.bind(globalThis);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.headersHook = options.headers;
    this.validateSceneFn = options.validateScene ?? validateScene;
    this.validateStageFn = options.validateStage ?? validateStage;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    versionErrorStageId?: string,
  ): Promise<T> {
    const headers = normalizeHeaders(await this.headersHook?.({ method, path }));
    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers['content-type'] ??= 'application/json';
      serializedBody = JSON.stringify(body);
    }
    // A non-positive floor means "no deadline at all"; anything else is a
    // floor the body may extend.
    const budgetMs =
      this.requestTimeoutMs <= 0
        ? 0
        : requestBudgetMs(this.requestTimeoutMs, utf8ByteLength(serializedBody ?? ''));
    const deadline = startRequestDeadline(budgetMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(deadline === null ? {} : { signal: deadline.signal }),
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
      });
    } catch (error) {
      // The deadline ended this wait, not the peer. Rejecting is the whole
      // point: the autosave's single-flight guard releases on rejection and its
      // backoff retries, so a stalled save costs one retry — but a promise that
      // never settles is never released, and every later save queues behind it.
      if (deadline !== null && deadline.signal.aborted) {
        throw new HttpDocumentStoreError(
          0,
          'HTTP_REQUEST_TIMEOUT',
          `@openmaic/storage: DocumentStore HTTP request did not settle within ${budgetMs}ms`,
        );
      }
      throw error;
    } finally {
      deadline?.settle();
    }
    if (!response.ok) {
      let errorBody: ErrorResponseBody | undefined;
      try {
        errorBody = (await response.json()) as ErrorResponseBody;
      } catch {
        // Preserve a useful typed error even for a non-conforming server.
      }
      const code = typeof errorBody?.error?.code === 'string' ? errorBody.error.code : 'HTTP_ERROR';
      const message =
        typeof errorBody?.error?.message === 'string'
          ? errorBody.error.message
          : `@openmaic/storage: DocumentStore HTTP request failed with status ${response.status}`;
      if (
        response.status === 409 &&
        code === 'FUTURE_VERSION' &&
        versionErrorStageId !== undefined
      ) {
        const details = errorBody?.error?.details as DocumentVersionErrorDetails | undefined;
        const storedVersion =
          typeof details?.storedVersion === 'string' ? details.storedVersion : undefined;
        throw new DocumentVersionError(versionErrorStageId, 'future', storedVersion, message);
      }
      throw new HttpDocumentStoreError(response.status, code, message, errorBody?.error?.details);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private validateSceneForWrite(stageId: string, scene: TScene): void {
    assertValid(this.validateSceneFn(scene), `scene ${scene.id}`);
    assertStorableScene(scene, stageId);
  }

  async saveDocument(document: MaicDocument<TScene, TStage>): Promise<void> {
    // The server repeats these checks. Running the injected gates here matches
    // BrowserDocumentStore's fail-fast boundary and avoids avoidable wire calls.
    const normalized = migrateDocument(document);
    assertValid(this.validateStageFn(normalized.stage), `stage ${normalized.stage.id}`);
    const seen = new Set<string>();
    for (const scene of normalized.scenes) {
      this.validateSceneForWrite(normalized.stage.id, scene);
      if (seen.has(scene.id)) {
        throw new Error(
          `@openmaic/storage: duplicate scene id ${JSON.stringify(scene.id)} in document ` +
            JSON.stringify(normalized.stage.id),
        );
      }
      seen.add(scene.id);
    }
    assertJsonValue(document, `document ${JSON.stringify(document.stage.id)}`);
    await this.request<void>(
      'PUT',
      `/documents/${segment(document.stage.id)}`,
      document,
      document.stage.id,
    );
  }

  async loadDocument(stageId: string): Promise<MaicDocument<TScene, TStage> | null> {
    try {
      const document = await this.request<MaicDocument<TScene, TStage>>(
        'GET',
        `/documents/${segment(stageId)}`,
      );
      return migrateDocument(document);
    } catch (error) {
      if (error instanceof HttpDocumentStoreError && error.code === 'DOCUMENT_NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    const summaries = await this.request<unknown>('GET', '/documents');
    if (!Array.isArray(summaries)) {
      throw new HttpDocumentStoreError(
        200,
        'MALFORMED_RESPONSE',
        '@openmaic/storage: DocumentStore HTTP listDocuments response must be an array',
      );
    }
    return summaries as DocumentSummary[];
  }

  async deleteDocument(stageId: string): Promise<void> {
    await this.request<void>('DELETE', `/documents/${segment(stageId)}`);
  }

  async putStage(stageId: string, stage: TStage): Promise<void> {
    assertValid(this.validateStageFn(stage), `stage ${stage.id}`);
    assertJsonValue(stage, `stage ${JSON.stringify(stage.id)}`);
    await this.request<void>('PUT', `/documents/${segment(stageId)}/stage`, stage, stageId);
  }

  async putScene(stageId: string, scene: TScene): Promise<void> {
    this.validateSceneForWrite(stageId, scene);
    assertJsonValue(scene, `scene ${JSON.stringify(scene.id)}`);
    await this.request<void>(
      'PUT',
      `/documents/${segment(stageId)}/scenes/${segment(scene.id)}`,
      scene,
      stageId,
    );
  }

  async getScene(stageId: string, sceneId: string): Promise<TScene | null> {
    try {
      return await this.request<TScene>(
        'GET',
        `/documents/${segment(stageId)}/scenes/${segment(sceneId)}`,
      );
    } catch (error) {
      if (
        error instanceof HttpDocumentStoreError &&
        (error.code === 'DOCUMENT_NOT_FOUND' || error.code === 'SCENE_NOT_FOUND')
      ) {
        return null;
      }
      throw error;
    }
  }

  async deleteScene(stageId: string, sceneId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/documents/${segment(stageId)}/scenes/${segment(sceneId)}`,
      undefined,
      stageId,
    );
  }
}
