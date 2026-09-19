import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import {
  DSL_VERSION,
  dslVersionOf,
  migrate,
  needsMigration,
  validateScene,
  validateStage,
} from '@openmaic/dsl';
import type { Scene, Stage, ValidationResult } from '@openmaic/dsl';
import { assertJsonValue } from '../runtime/json-value.js';
import type {
  DocumentStore,
  MaicDocument,
  SceneLike,
  SceneValidator,
  StageValidator,
} from '../document/types.js';
import { DocumentNotFoundError, DocumentVersionError } from '../document/types.js';
import { assertMaxBodyBytes, DEFAULT_MAX_BODY_BYTES, readJsonObject } from './read-json.js';

export interface DocumentHttpPrincipal {
  learnerKey?: string;
}

export type DocumentHttpAuthenticate = (
  req: IncomingMessage,
) => Promise<DocumentHttpPrincipal | undefined>;

export type DocumentHttpAuthorize = (
  principal: DocumentHttpPrincipal,
  req: IncomingMessage,
) => boolean | Promise<boolean>;

export interface DocumentHttpHandlerOptions {
  authenticate: DocumentHttpAuthenticate;
  /** Defaults to allowing any authenticated principal. */
  authorizeDocuments?: DocumentHttpAuthorize;
  /** Whole-validator replacement; pass the same validator configured on the store. */
  validateScene?: SceneValidator;
  /** Whole-validator replacement; pass the same validator configured on the store. */
  validateStage?: StageValidator;
  /** Maximum JSON request-body size in bytes. Defaults to 32 MiB. */
  maxBodyBytes?: number;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

class DocumentHttpError extends Error {
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

function validationFailure(message: string, details?: unknown): DocumentHttpError {
  return new DocumentHttpError(400, 'VALIDATION_FAILED', message, details);
}

function payloadTooLarge(message: string): DocumentHttpError {
  return new DocumentHttpError(413, 'PAYLOAD_TOO_LARGE', message);
}

function readJson(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  return readJsonObject(req, maxBodyBytes, {
    invalid: validationFailure,
    payloadTooLarge,
  });
}

function validationError(result: ValidationResult, label: string): void {
  if (result.valid) return;
  const details = result.errors;
  const detail = details.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  throw validationFailure(`@openmaic/storage: invalid ${label}: ${detail}`, details);
}

function assertAddressableSegment(value: string): void {
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

function assertJsonResponseValue(value: unknown, label: string): void {
  try {
    assertJsonValue(value, label);
  } catch (error) {
    throw new DocumentHttpError(
      500,
      'NOT_JSON_SAFE',
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parsePath(req: IncomingMessage): string[] {
  try {
    return new URL(req.url ?? '/', 'http://documents.invalid').pathname
      .split('/')
      .filter((part, index) => index !== 0 || part !== '')
      .map((part) => decodeURIComponent(part));
  } catch (error) {
    throw validationFailure(error instanceof Error ? error.message : String(error));
  }
}

function missingDocument(stageId: string): DocumentHttpError {
  return new DocumentHttpError(
    404,
    'DOCUMENT_NOT_FOUND',
    `@openmaic/storage: missing document ${JSON.stringify(stageId)}`,
  );
}

function missingScene(stageId: string, sceneId: string): DocumentHttpError {
  return new DocumentHttpError(
    404,
    'SCENE_NOT_FOUND',
    `@openmaic/storage: no scene ${JSON.stringify(sceneId)} in document ${JSON.stringify(stageId)}`,
  );
}

function isFutureVersioned(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return !needsMigration(value) && dslVersionOf(value) !== DSL_VERSION;
}

function futureVersion(message: string, details?: unknown): DocumentHttpError {
  return new DocumentHttpError(409, 'FUTURE_VERSION', message, details);
}

function migrateDocument<TScene extends SceneLike, TStage extends Stage>(
  document: MaicDocument<TScene, TStage>,
): MaicDocument<TScene, TStage> {
  const { outline, ...core } = document;
  let migrated: MaicDocument<TScene, TStage>;
  try {
    migrated = migrate(core) as MaicDocument<TScene, TStage>;
  } catch (error) {
    throw validationFailure(error instanceof Error ? error.message : String(error));
  }
  return outline === undefined ? migrated : { ...migrated, outline };
}

function assertStorableScene(scene: unknown, stageId: string): asserts scene is SceneLike {
  const value =
    typeof scene === 'object' && scene !== null
      ? (scene as { id?: unknown; stageId?: unknown; order?: unknown })
      : { id: undefined, stageId: undefined, order: undefined };
  if (typeof value.id !== 'string') {
    throw validationFailure(
      `@openmaic/storage: scene id must be a string, got ${JSON.stringify(value.id)}`,
    );
  }
  if (value.stageId !== stageId) {
    throw validationFailure(
      `@openmaic/storage: scene ${JSON.stringify(value.id)} has stageId ` +
        `${JSON.stringify(value.stageId)} but belongs to document ${JSON.stringify(stageId)}`,
    );
  }
  if (typeof value.order !== 'number' || !Number.isFinite(value.order)) {
    throw validationFailure(
      `@openmaic/storage: scene ${JSON.stringify(value.id)} order must be a finite number, got ` +
        `${JSON.stringify(value.order)}`,
    );
  }
}

function validateDocument<TScene extends SceneLike, TStage extends Stage>(
  body: Record<string, unknown>,
  pathStageId: string,
  sceneValidator: SceneValidator,
  stageValidator: StageValidator,
): MaicDocument<TScene, TStage> {
  if (typeof body.stage !== 'object' || body.stage === null || !Array.isArray(body.scenes)) {
    throw validationFailure('document requires an object stage and a scenes array');
  }
  const document = body as unknown as MaicDocument<TScene, TStage>;
  if (isFutureVersioned(document)) {
    throw futureVersion(
      `@openmaic/storage: refusing to save document ${JSON.stringify(pathStageId)} — it was ` +
        `written at DSL version ${JSON.stringify(dslVersionOf(document))}, newer than this ` +
        `client's ${DSL_VERSION}`,
      { stageId: pathStageId, storedVersion: document.dslVersion },
    );
  }
  const normalized = migrateDocument(document);
  validationError(stageValidator(normalized.stage), `stage ${normalized.stage.id}`);
  if (normalized.stage.id !== pathStageId) {
    throw validationFailure(
      `@openmaic/storage: stage ${JSON.stringify(normalized.stage.id)} does not belong to ` +
        `document ${JSON.stringify(pathStageId)}`,
    );
  }
  const seen = new Set<string>();
  for (const scene of normalized.scenes) {
    const sceneId =
      typeof scene === 'object' && scene !== null ? (scene as { id?: unknown }).id : undefined;
    validationError(sceneValidator(scene), `scene ${String(sceneId)}`);
    assertStorableScene(scene, pathStageId);
    if (seen.has(scene.id)) {
      throw validationFailure(
        `@openmaic/storage: duplicate scene id ${JSON.stringify(scene.id)} in document ` +
          JSON.stringify(pathStageId),
      );
    }
    seen.add(scene.id);
  }
  assertJsonRequestValue(document, `document ${JSON.stringify(pathStageId)}`);
  return document;
}

function classifyStoreError(error: unknown): never {
  if (error instanceof DocumentNotFoundError) {
    throw new DocumentHttpError(404, 'DOCUMENT_NOT_FOUND', error.message);
  }
  if (error instanceof DocumentVersionError) {
    const details = { stageId: error.stageId, storedVersion: error.storedVersion };
    if (error.kind === 'future') throw futureVersion(error.message, details);
    throw validationFailure(error.message, details);
  }

  // Fallback for third-party DocumentStore implementations that throw plain Errors.
  const message = error instanceof Error ? error.message : String(error);
  if (/missing document/.test(message)) {
    const match = /missing document ("(?:[^"\\]|\\.)*")/.exec(message);
    let stageId = 'unknown';
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1]) as unknown;
        if (typeof parsed === 'string') stageId = parsed;
      } catch {
        // Keep the canonical store message below when parsing fails.
      }
    }
    throw new DocumentHttpError(
      404,
      'DOCUMENT_NOT_FOUND',
      message || missingDocument(stageId).message,
    );
  }
  const versionMatch = /at DSL version (undefined|"(?:[^"\\]|\\.)*")/.exec(message);
  if (/newer than this client's/.test(message)) throw futureVersion(message);
  if (versionMatch?.[1]) {
    if (versionMatch[1] === 'undefined') throw validationFailure(message);
    try {
      const version = JSON.parse(versionMatch[1]) as unknown;
      if (typeof version === 'string' && isFutureVersioned({ dslVersion: version })) {
        throw futureVersion(message);
      }
    } catch (classificationError) {
      if (classificationError instanceof DocumentHttpError) throw classificationError;
    }
    throw validationFailure(message);
  }
  throw error;
}

function mappedError(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof DocumentHttpError) {
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
      error: { code: 'INTERNAL_ERROR', message: '@openmaic/storage: internal server error' },
    },
  };
}

async function route<TScene extends SceneLike, TStage extends Stage>(
  req: IncomingMessage,
  res: ServerResponse,
  store: DocumentStore<TScene, TStage>,
  options: DocumentHttpHandlerOptions,
): Promise<void> {
  const parts = parsePath(req);
  if (parts[0] !== 'documents') {
    throw new DocumentHttpError(404, 'ROUTE_NOT_FOUND', 'route not found');
  }
  const principal = await options.authenticate(req);
  if (principal === undefined) {
    throw new DocumentHttpError(
      401,
      'UNAUTHENTICATED',
      '@openmaic/storage: authentication required',
    );
  }
  if (!(await (options.authorizeDocuments?.(principal, req) ?? true))) {
    throw new DocumentHttpError(
      403,
      'FORBIDDEN_DOCUMENTS',
      '@openmaic/storage: document authorization required',
    );
  }

  const method = req.method ?? 'GET';
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const sceneValidator = options.validateScene ?? validateScene;
  const stageValidator = options.validateStage ?? validateStage;
  if (parts.length === 1 && method === 'GET') {
    sendJson(res, 200, await store.listDocuments());
    return;
  }
  if (parts.length < 2) throw new DocumentHttpError(404, 'ROUTE_NOT_FOUND', 'route not found');
  const stageId = parts[1]!;
  assertAddressableSegment(stageId);

  if (parts.length === 2 && method === 'PUT') {
    const document = validateDocument<TScene, TStage>(
      await readJson(req, maxBodyBytes),
      stageId,
      sceneValidator,
      stageValidator,
    );
    try {
      await store.saveDocument(document);
    } catch (error) {
      classifyStoreError(error);
    }
    sendNoContent(res);
    return;
  }
  if (parts.length === 2 && method === 'GET') {
    const document = await store.loadDocument(stageId);
    if (document === null) throw missingDocument(stageId);
    assertJsonResponseValue(document, `document response ${JSON.stringify(stageId)}`);
    sendJson(res, 200, document);
    return;
  }
  if (parts.length === 2 && method === 'DELETE') {
    await store.deleteDocument(stageId);
    sendNoContent(res);
    return;
  }
  if (parts.length === 3 && parts[2] === 'stage' && method === 'PUT') {
    const stage = (await readJson(req, maxBodyBytes)) as unknown as TStage;
    validationError(stageValidator(stage), `stage ${(stage as { id?: unknown }).id}`);
    if (stage.id !== stageId) {
      throw validationFailure(
        `@openmaic/storage: stage ${JSON.stringify(stage.id)} does not belong to document ` +
          JSON.stringify(stageId),
      );
    }
    assertJsonRequestValue(stage, `stage ${JSON.stringify((stage as { id?: unknown }).id)}`);
    try {
      await store.putStage(stageId, stage);
    } catch (error) {
      classifyStoreError(error);
    }
    sendNoContent(res);
    return;
  }
  if (parts.length === 4 && parts[2] === 'scenes') {
    const sceneId = parts[3]!;
    assertAddressableSegment(sceneId);
    if (method === 'PUT') {
      const scene = (await readJson(req, maxBodyBytes)) as unknown as TScene;
      validationError(sceneValidator(scene), `scene ${(scene as { id?: unknown }).id}`);
      assertStorableScene(scene, stageId);
      if (scene.id !== sceneId) {
        throw validationFailure('scene body id does not match the request path');
      }
      assertJsonRequestValue(scene, `scene ${JSON.stringify(scene.id)}`);
      try {
        await store.putScene(stageId, scene);
      } catch (error) {
        classifyStoreError(error);
      }
      sendNoContent(res);
      return;
    }
    if (method === 'GET') {
      const scene = await store.getScene(stageId, sceneId);
      if (scene === null) throw missingScene(stageId, sceneId);
      assertJsonResponseValue(
        scene,
        `scene response ${JSON.stringify(sceneId)} in document ${JSON.stringify(stageId)}`,
      );
      sendJson(res, 200, scene);
      return;
    }
    if (method === 'DELETE') {
      try {
        await store.deleteScene(stageId, sceneId);
      } catch (error) {
        classifyStoreError(error);
      }
      sendNoContent(res);
      return;
    }
  }
  throw new DocumentHttpError(404, 'ROUTE_NOT_FOUND', 'route not found');
}

/** Create a Node HTTP request handler for the complete DocumentStore contract. */
export function createDocumentHttpHandler<
  TScene extends SceneLike = Scene,
  TStage extends Stage = Stage,
>(store: DocumentStore<TScene, TStage>, options: DocumentHttpHandlerOptions): RequestListener {
  if (typeof options?.authenticate !== 'function') {
    throw new Error('@openmaic/storage: createDocumentHttpHandler requires authenticate');
  }
  assertMaxBodyBytes(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  return (req, res) => {
    void route(req, res, store, options).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (!(error instanceof DocumentHttpError) || error.status >= 500) {
        console.error('@openmaic/storage: Document HTTP handler internal error', error);
      }
      const mapped = mappedError(error);
      sendJson(res, mapped.status, mapped.body);
    });
  };
}
