import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { AssetMeta } from '@openmaic/dsl';
import type { AssetId } from '../asset/id.js';
import {
  AssetNotFoundError,
  AssetQuotaExceededError,
  DEFAULT_RENDERABLE_TYPES,
  EXCLUDED_RENDERABLE_TYPES,
  type AssetPrincipal,
  type AssetStore,
} from '../asset/types.js';

/** Derive the asset principal from the authenticated request session. */
export type AssetHttpAuthenticate = (req: IncomingMessage) => Promise<AssetPrincipal | undefined>;

/** Additional deployment policy, evaluated before the handler reads an entry. */
export type AssetHttpAuthorize = (
  principal: AssetPrincipal,
  req: IncomingMessage,
) => boolean | Promise<boolean>;

/** Options for the asset registry HTTP contract handler. */
export interface AssetHttpHandlerOptions {
  authenticate: AssetHttpAuthenticate;
  /** Defaults to allowing every authenticated principal carrying an asset key. */
  authorizeAssets?: AssetHttpAuthorize;
  /** Exact media types served inline; executable document types are always refused. */
  renderableTypes?: readonly string[];
  /** Raw whole-request limit. Defaults to 33 MiB. */
  maxRequestBytes?: number;
  /** Decoded bytes-part limit. Defaults to 32 MiB. */
  maxAssetBytes?: number;
  /** Decoded metadata-part limit. Defaults to 64 KiB. */
  maxMetaBytes?: number;
  /** Multipart frame-count limit. Defaults to 8. */
  maxParts?: number;
}

export const DEFAULT_MAX_ASSET_REQUEST_BYTES = 33 * 1024 * 1024;
export const DEFAULT_MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_ASSET_META_BYTES = 64 * 1024;
export const DEFAULT_MAX_ASSET_PARTS = 8;

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface ParsedWrite {
  data: Blob;
  meta?: AssetMeta;
}

class AssetHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function validationFailure(message: string): AssetHttpError {
  return new AssetHttpError(400, 'VALIDATION_FAILED', message);
}

function payloadTooLarge(message: string): AssetHttpError {
  return new AssetHttpError(413, 'PAYLOAD_TOO_LARGE', message);
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.sendDate = false;
  const encoded = JSON.stringify(body);
  const errorCode =
    status >= 300 && typeof body === 'object' && body !== null
      ? (body as ErrorBody).error.code
      : undefined;
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(req.method === 'GET' || req.method === 'HEAD'
      ? { 'content-length': String(Buffer.byteLength(encoded)) }
      : {}),
    ...(errorCode !== undefined && (req.method === 'GET' || req.method === 'HEAD')
      ? {
          'x-error-code': errorCode,
          'access-control-expose-headers': 'X-Asset-Revision, X-Error-Code',
        }
      : {}),
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : encoded);
}

function sendNoContent(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.sendDate = false;
  res.writeHead(204, headers);
  res.end();
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`@openmaic/storage: ${label} must be a positive safe integer`);
  }
}

function assertMultipartContentType(contentType: string | undefined): string {
  if (
    contentType === undefined ||
    contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'multipart/form-data'
  ) {
    throw new AssetHttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      '@openmaic/storage: asset writes require multipart/form-data',
    );
  }
  return contentType;
}

async function readBoundedBody(req: IncomingMessage, maxRequestBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.byteLength;
    if (total > maxRequestBytes) {
      throw payloadTooLarge(
        `@openmaic/storage: request body exceeds maxRequestBytes (${maxRequestBytes})`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function assertBodyless(req: IncomingMessage): Promise<void> {
  for await (const chunk of req) {
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (size > 0) {
      throw validationFailure('@openmaic/storage: this asset route does not accept a body');
    }
  }
}

function assertServerMetadataValue(value: unknown): void {
  const visit = (member: unknown): void => {
    if (typeof member === 'string' && member.includes('\u0000')) {
      throw validationFailure('@openmaic/storage: asset metadata contains U+0000');
    }
    if (typeof member === 'number' && Object.is(member, -0)) {
      throw validationFailure('@openmaic/storage: asset metadata contains negative zero');
    }
    if (Array.isArray(member)) {
      for (const nested of member) visit(nested);
    } else if (typeof member === 'object' && member !== null) {
      for (const [key, nested] of Object.entries(member)) {
        visit(key);
        visit(nested);
      }
    }
  };
  visit(value);
}

async function parseMeta(part: Blob): Promise<AssetMeta> {
  if (part.type.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw validationFailure('@openmaic/storage: the meta part must be application/json');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await part.arrayBuffer());
  } catch {
    throw validationFailure('@openmaic/storage: the meta part must contain valid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw validationFailure('@openmaic/storage: the meta part must contain valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationFailure('@openmaic/storage: the meta part must contain a JSON object');
  }
  if ('principal' in value || 'contentHash' in value) {
    throw validationFailure('@openmaic/storage: asset metadata contains a prohibited member');
  }
  assertServerMetadataValue(value);
  return value as AssetMeta;
}

async function readWrite(
  req: IncomingMessage,
  requiredMeta: boolean,
  limits: {
    maxRequestBytes: number;
    maxParts: number;
    maxMetaBytes: number;
    maxAssetBytes: number;
  },
): Promise<ParsedWrite> {
  if (req.headers['content-encoding'] !== undefined) {
    throw validationFailure('@openmaic/storage: Content-Encoding is not accepted on asset writes');
  }
  const contentType = assertMultipartContentType(req.headers['content-type']);
  const body = await readBoundedBody(req, limits.maxRequestBytes);
  let form: FormData;
  try {
    const bytes = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
    form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw validationFailure('@openmaic/storage: malformed multipart body');
  }
  const parts = [...form.entries()];
  if (parts.length > limits.maxParts) {
    throw payloadTooLarge(
      `@openmaic/storage: asset write body exceeds maxParts (${limits.maxParts})`,
    );
  }
  const named = new Map<'meta' | 'bytes', string | Blob>();
  for (const [name, part] of parts) {
    if (name !== 'meta' && name !== 'bytes') {
      throw validationFailure('@openmaic/storage: asset write body contains an unrecognized part');
    }
    if (named.has(name)) {
      throw validationFailure('@openmaic/storage: asset write body contains a duplicate part');
    }
    named.set(name, part);
  }
  const expectedLengths = requiredMeta ? [2] : [1, 2];
  if (!expectedLengths.includes(parts.length)) {
    throw validationFailure('@openmaic/storage: asset write body has the wrong number of parts');
  }
  const metaPart = named.get('meta');
  const bytesPart = named.get('bytes');
  if (bytesPart === undefined) {
    throw validationFailure('@openmaic/storage: asset write body must carry a "bytes" part');
  }
  if (requiredMeta && metaPart === undefined) {
    throw validationFailure('@openmaic/storage: asset write body must carry a "meta" part');
  }
  if (metaPart !== undefined && parts[0]?.[0] !== 'meta') {
    throw validationFailure('@openmaic/storage: the meta part must precede the bytes part');
  }
  if (typeof bytesPart === 'string') {
    throw validationFailure('@openmaic/storage: the bytes part must be sent as a file');
  }
  if (typeof metaPart === 'string') {
    throw validationFailure('@openmaic/storage: the meta part must be sent as a file');
  }
  if (bytesPart.size > limits.maxAssetBytes) {
    throw payloadTooLarge(
      `@openmaic/storage: bytes part exceeds maxAssetBytes (${limits.maxAssetBytes})`,
    );
  }
  if (metaPart !== undefined) {
    if (metaPart.size > limits.maxMetaBytes) {
      throw payloadTooLarge(
        `@openmaic/storage: meta part exceeds maxMetaBytes (${limits.maxMetaBytes})`,
      );
    }
  }
  const meta = metaPart === undefined ? undefined : await parseMeta(metaPart);
  return {
    data: bytesPart,
    ...(meta === undefined ? {} : { meta }),
  };
}

function parsePath(req: IncomingMessage): string[] {
  const target = req.url ?? '/';
  if (target.includes('?')) {
    throw validationFailure('@openmaic/storage: asset routes do not accept a query string');
  }
  const raw = target.split('#', 1)[0] ?? '/';
  const rawParts = raw.split('/');
  if (rawParts[0] === '') rawParts.shift();
  try {
    return rawParts.map((part) => decodeURIComponent(part));
  } catch {
    throw validationFailure('@openmaic/storage: request path is not valid percent-encoded UTF-8');
  }
}

function routeShape(parts: string[]): { kind: 'collection' | 'content' | 'item'; allow: string } {
  if (parts.length === 1 && parts[0] === 'assets') return { kind: 'collection', allow: 'POST' };
  if (parts.length === 3 && parts[0] === 'assets' && parts[2] === 'content') {
    return { kind: 'content', allow: 'GET, HEAD, PUT' };
  }
  if (parts.length === 2 && parts[0] === 'assets') return { kind: 'item', allow: 'DELETE' };
  throw new AssetHttpError(404, 'ROUTE_NOT_FOUND', 'route not found');
}

function assertMethod(
  method: string,
  kind: 'collection' | 'content' | 'item',
  allow: string,
): void {
  const accepted =
    (kind === 'collection' && method === 'POST') ||
    (kind === 'content' && (method === 'GET' || method === 'HEAD' || method === 'PUT')) ||
    (kind === 'item' && method === 'DELETE');
  if (!accepted) {
    throw new AssetHttpError(
      405,
      'METHOD_NOT_ALLOWED',
      '@openmaic/storage: method not allowed for this asset route',
      undefined,
      { allow },
    );
  }
}

function missingAsset(): AssetHttpError {
  return new AssetHttpError(
    404,
    'ASSET_NOT_FOUND',
    '@openmaic/storage: no asset is stored under that id',
  );
}

function classifyStoreError(error: unknown): never {
  if (error instanceof AssetNotFoundError) throw missingAsset();
  if (error instanceof AssetQuotaExceededError) {
    throw new AssetHttpError(
      507,
      'ASSET_QUOTA_EXCEEDED',
      '@openmaic/storage: asset quota exceeded for this principal',
    );
  }
  throw error;
}

function mappedError(error: unknown): {
  status: number;
  body: ErrorBody;
  headers: Record<string, string>;
} {
  if (error instanceof AssetHttpError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      headers: error.headers,
    };
  }
  return {
    status: 500,
    body: {
      error: { code: 'INTERNAL_ERROR', message: '@openmaic/storage: internal server error' },
    },
    headers: {},
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  store: AssetStore,
  options: AssetHttpHandlerOptions,
  config: {
    renderableTypes: ReadonlySet<string>;
    maxRequestBytes: number;
    maxAssetBytes: number;
    maxMetaBytes: number;
    maxParts: number;
  },
): Promise<void> {
  const parts = parsePath(req);
  const shape = routeShape(parts);
  const method = req.method ?? 'GET';
  assertMethod(method, shape.kind, shape.allow);

  const candidate = (await options.authenticate(req)) as unknown;
  if (candidate === undefined) {
    throw new AssetHttpError(401, 'UNAUTHENTICATED', '@openmaic/storage: authentication required');
  }
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('@openmaic/storage: asset authenticator returned a malformed principal');
  }
  if (!('key' in candidate)) {
    throw new AssetHttpError(
      403,
      'FORBIDDEN_ASSETS',
      '@openmaic/storage: asset authorization required',
    );
  }
  if (typeof (candidate as { key?: unknown }).key !== 'string') {
    throw new Error('@openmaic/storage: asset authenticator returned a malformed principal');
  }
  const principal = candidate as AssetPrincipal;
  if (!(await (options.authorizeAssets?.(principal, req) ?? true))) {
    throw new AssetHttpError(
      403,
      'FORBIDDEN_ASSETS',
      '@openmaic/storage: asset authorization required',
    );
  }

  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') await assertBodyless(req);

  if (shape.kind === 'collection') {
    const write = await readWrite(req, true, config);
    let id: AssetId;
    try {
      id = await store.put(principal, write.data, write.meta);
    } catch (error) {
      classifyStoreError(error);
    }
    if (typeof id !== 'string') {
      throw new Error('@openmaic/storage: asset store returned a malformed id');
    }
    sendJson(
      req,
      res,
      201,
      { id },
      {
        'x-asset-revision': '1',
        'access-control-expose-headers': 'X-Asset-Revision',
      },
    );
    return;
  }

  const id = parts[1]!;
  if (shape.kind === 'item') {
    try {
      await store.remove(principal, id);
    } catch (error) {
      classifyStoreError(error);
    }
    sendNoContent(res);
    return;
  }

  if (method === 'PUT') {
    const write = await readWrite(req, false, config);
    let revision: number;
    try {
      revision = await store.replace(principal, id as AssetId, write.data, write.meta);
    } catch (error) {
      classifyStoreError(error);
    }
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error('@openmaic/storage: asset store returned a malformed revision');
    }
    sendNoContent(res, {
      'x-asset-revision': String(revision),
      'access-control-expose-headers': 'X-Asset-Revision',
    });
    return;
  }

  let asset;
  try {
    asset =
      method === 'HEAD' ? await store.identify(principal, id) : await store.resolve(principal, id);
  } catch (error) {
    classifyStoreError(error);
  }
  if (asset === null) throw missingAsset();
  if (!Number.isSafeInteger(asset.revision) || asset.revision < 1) {
    throw new Error('@openmaic/storage: asset store returned a malformed revision');
  }
  if ('byteLength' in asset && (!Number.isSafeInteger(asset.byteLength) || asset.byteLength < 0)) {
    throw new Error('@openmaic/storage: asset store returned a malformed byte length');
  }
  const recordedType = typeof asset.mime === 'string' ? asset.mime.toLowerCase() : '';
  const inline = config.renderableTypes.has(recordedType);
  const servedType = inline ? recordedType : 'application/octet-stream';
  const headers: Record<string, string> = {
    'content-type': servedType,
    'content-length': String('byteLength' in asset ? asset.byteLength : asset.bytes.byteLength),
    'x-asset-revision': String(asset.revision),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
    vary: 'Cookie, Authorization',
    'access-control-expose-headers': 'X-Asset-Revision, X-Error-Code',
    ...(inline ? {} : { 'content-disposition': 'attachment' }),
  };
  res.sendDate = false;
  res.writeHead(200, headers);
  res.end('bytes' in asset ? asset.bytes : undefined);
}

/** Create a Node HTTP request handler for the complete AssetStore HTTP contract. */
export function createAssetHttpHandler(
  store: AssetStore,
  options: AssetHttpHandlerOptions,
): RequestListener {
  if (!store) throw new Error('@openmaic/storage: createAssetHttpHandler requires an asset store');
  if (typeof options?.authenticate !== 'function') {
    throw new Error('@openmaic/storage: createAssetHttpHandler requires authenticate');
  }
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_ASSET_REQUEST_BYTES;
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
  const maxMetaBytes = options.maxMetaBytes ?? DEFAULT_MAX_ASSET_META_BYTES;
  const maxParts = options.maxParts ?? DEFAULT_MAX_ASSET_PARTS;
  for (const [label, value] of [
    ['maxRequestBytes', maxRequestBytes],
    ['maxAssetBytes', maxAssetBytes],
    ['maxMetaBytes', maxMetaBytes],
    ['maxParts', maxParts],
  ] as const) {
    assertPositiveSafeInteger(value, label);
  }
  if (maxParts < 2) {
    throw new Error('@openmaic/storage: maxParts must allow the two required POST parts');
  }
  if (maxRequestBytes <= maxAssetBytes + maxMetaBytes) {
    throw new Error(
      '@openmaic/storage: maxRequestBytes must exceed maxAssetBytes + maxMetaBytes for multipart framing',
    );
  }

  const configuredTypes = options.renderableTypes ?? DEFAULT_RENDERABLE_TYPES;
  const renderableTypes = new Set(configuredTypes.map((value) => value.toLowerCase()));
  const excluded = new Set(EXCLUDED_RENDERABLE_TYPES.map((value) => value.toLowerCase()));
  if (configuredTypes.some((value) => excluded.has(value.toLowerCase()))) {
    throw new Error('@openmaic/storage: renderableTypes contains an excluded executable type');
  }
  if (configuredTypes.some((value) => value !== value.trim() || value.includes(';'))) {
    throw new Error('@openmaic/storage: renderableTypes must contain exact media types');
  }

  const config = {
    renderableTypes,
    maxRequestBytes,
    maxAssetBytes,
    maxMetaBytes,
    maxParts,
  };
  return (req, res) => {
    void route(req, res, store, options, config).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      if (!(error instanceof AssetHttpError) || error.status >= 500) {
        console.error('@openmaic/storage: Asset HTTP handler internal error');
      }
      const mapped = mappedError(error);
      sendJson(req, res, mapped.status, mapped.body, mapped.headers);
    });
  };
}
