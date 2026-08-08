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
  /** Raw header limit for each multipart part. Defaults to 8 KiB. */
  maxPartHeaderBytes?: number;
}

export const DEFAULT_MAX_ASSET_REQUEST_BYTES = 33 * 1024 * 1024;
export const DEFAULT_MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_ASSET_META_BYTES = 64 * 1024;
export const DEFAULT_MAX_ASSET_PARTS = 8;
export const DEFAULT_MAX_ASSET_PART_HEADER_BYTES = 8 * 1024;

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

interface MultipartPart {
  name: 'meta' | 'bytes';
  contentType: string;
  bytes: Buffer;
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
  const errorCode =
    status >= 300 && typeof body === 'object' && body !== null
      ? (body as ErrorBody).error.code
      : undefined;
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(errorCode !== undefined && (req.method === 'GET' || req.method === 'HEAD')
      ? {
          'x-error-code': errorCode,
          'access-control-expose-headers': 'X-Asset-Revision, X-Error-Code',
        }
      : {}),
    ...headers,
  });
  res.end(JSON.stringify(body));
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

function parseBoundary(contentType: string | undefined): string {
  if (contentType === undefined) {
    throw new AssetHttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      '@openmaic/storage: asset writes require multipart/form-data',
    );
  }
  const pieces = contentType.split(';');
  if (pieces.shift()?.trim().toLowerCase() !== 'multipart/form-data') {
    throw new AssetHttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      '@openmaic/storage: asset writes require multipart/form-data',
    );
  }
  let boundary: string | undefined;
  for (const piece of pieces) {
    const match = /^\s*boundary\s*=\s*(?:"([^"]*)"|([^\s;]+))\s*$/i.exec(piece);
    if (match) {
      if (boundary !== undefined) {
        throw new AssetHttpError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          '@openmaic/storage: multipart/form-data must carry one boundary',
        );
      }
      boundary = match[1] ?? match[2];
    }
  }
  if (
    boundary === undefined ||
    boundary.length < 1 ||
    boundary.length > 70 ||
    !/^[0-9A-Za-z'()+_,\-.\/:=? ]*[0-9A-Za-z'()+_,\-.\/:=?]$/.test(boundary)
  ) {
    throw new AssetHttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      '@openmaic/storage: multipart/form-data requires a valid boundary',
    );
  }
  return boundary;
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

function parsePartHeaders(raw: Buffer): Map<string, string> {
  const headers = new Map<string, string>();
  const text = raw.toString('latin1');
  for (const line of text.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0 || /^[ \t]/.test(line)) {
      throw validationFailure('@openmaic/storage: malformed multipart part headers');
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name)) {
      throw validationFailure('@openmaic/storage: duplicate multipart part header');
    }
    headers.set(name, value);
  }
  return headers;
}

/**
 * Split a `Content-Disposition` value into its parameters, honouring quoted
 * strings and backslash escapes.
 *
 * A regex scan of the raw header cannot do this, and the gap is exploitable
 * rather than cosmetic: a `;` inside a quoted `filename` looks exactly like a
 * parameter separator, so `filename="x; name=meta; y"` reads as a `name`
 * parameter to a naive scanner while an RFC-aware intermediary sees an unnamed
 * part. Two parsers disagreeing about which part is which is precisely the
 * parser differential this contract requires be rejected.
 *
 * Returns pairs rather than a map so a repeated parameter stays visible;
 * collapsing duplicates would hide a second `name`.
 */
function dispositionParameters(disposition: string): Array<[string, string]> {
  const parameters: Array<[string, string]> = [];
  let index = disposition.indexOf(';');
  if (index < 0) return parameters;
  index += 1;
  while (index < disposition.length) {
    while (index < disposition.length && /\s/.test(disposition[index]!)) index += 1;
    if (index >= disposition.length) break;
    if (disposition[index] === ';') {
      index += 1;
      continue;
    }
    let name = '';
    while (index < disposition.length && disposition[index] !== '=' && disposition[index] !== ';') {
      name += disposition[index]!;
      index += 1;
    }
    name = name.trim().toLowerCase();
    if (disposition[index] !== '=') {
      if (name !== '') parameters.push([name, '']);
      continue;
    }
    index += 1;
    let value = '';
    if (disposition[index] === '"') {
      index += 1;
      let closed = false;
      while (index < disposition.length) {
        const character = disposition[index]!;
        if (character === '\\') {
          if (index + 1 >= disposition.length) {
            throw validationFailure(
              '@openmaic/storage: multipart part disposition ends in a dangling escape',
            );
          }
          value += disposition[index + 1]!;
          index += 2;
          continue;
        }
        if (character === '"') {
          closed = true;
          index += 1;
          break;
        }
        value += character;
        index += 1;
      }
      // A quoted value that simply runs to the end of the header is malformed,
      // and accepting it is how `name="meta` was read as a real name. Anything
      // other than whitespace and a separator after the closing quote is
      // malformed too: `name="meta"junk` must not be read as `meta`.
      if (!closed) {
        throw validationFailure(
          '@openmaic/storage: multipart part disposition has an unterminated quoted value',
        );
      }
      while (index < disposition.length && /\s/.test(disposition[index]!)) index += 1;
      if (index < disposition.length && disposition[index] !== ';') {
        throw validationFailure(
          '@openmaic/storage: multipart part disposition has trailing text after a quoted value',
        );
      }
    } else {
      while (index < disposition.length && disposition[index] !== ';') {
        value += disposition[index]!;
        index += 1;
      }
      value = value.trim();
    }
    if (name !== '') parameters.push([name, value]);
  }
  return parameters;
}

function partName(disposition: string | undefined): 'meta' | 'bytes' {
  if (disposition === undefined || !/^\s*form-data\s*(?:;|$)/i.test(disposition)) {
    throw validationFailure('@openmaic/storage: multipart parts require form-data disposition');
  }
  const parameters = dispositionParameters(disposition);
  // An extended form competing with a plain one is another way for two parsers
  // to disagree about which part this is, so refuse rather than pick a winner.
  if (parameters.some(([key]) => key === 'name*')) {
    throw validationFailure(
      '@openmaic/storage: multipart part names must not use an extended parameter form',
    );
  }
  const named = parameters.filter(([key]) => key === 'name');
  if (named.length !== 1) {
    throw validationFailure('@openmaic/storage: multipart parts require exactly one name');
  }
  const name = named[0]![1];
  if (name !== 'meta' && name !== 'bytes') {
    throw validationFailure('@openmaic/storage: asset write body contains an unrecognized part');
  }
  return name;
}

function parseMultipart(
  body: Buffer,
  boundary: string,
  limits: {
    maxParts: number;
    maxPartHeaderBytes: number;
    maxMetaBytes: number;
    maxAssetBytes: number;
  },
): MultipartPart[] {
  const opening = Buffer.from(`--${boundary}\r\n`, 'latin1');
  const delimiter = Buffer.from(`\r\n--${boundary}`, 'latin1');
  if (!body.subarray(0, opening.length).equals(opening)) {
    throw validationFailure('@openmaic/storage: malformed multipart body');
  }
  const parts: MultipartPart[] = [];
  let offset = opening.length;
  while (true) {
    if (parts.length >= limits.maxParts) {
      // A declared resource limit, so it answers like the other three rather
      // than as a validation failure.
      throw payloadTooLarge(
        `@openmaic/storage: asset write body exceeds maxParts (${limits.maxParts})`,
      );
    }
    const headerEnd = body.indexOf('\r\n\r\n', offset, 'latin1');
    if (headerEnd < 0) throw validationFailure('@openmaic/storage: malformed multipart body');
    if (headerEnd - offset > limits.maxPartHeaderBytes) {
      throw payloadTooLarge(
        `@openmaic/storage: multipart part headers exceed maxPartHeaderBytes (${limits.maxPartHeaderBytes})`,
      );
    }
    const headers = parsePartHeaders(body.subarray(offset, headerEnd));
    const name = partName(headers.get('content-disposition'));
    if (parts.some((part) => part.name === name)) {
      throw validationFailure('@openmaic/storage: asset write body contains a duplicate part');
    }
    const transferEncoding = headers.get('content-transfer-encoding')?.toLowerCase();
    if (
      transferEncoding !== undefined &&
      transferEncoding !== 'binary' &&
      transferEncoding !== '8bit' &&
      transferEncoding !== '7bit'
    ) {
      throw validationFailure('@openmaic/storage: unsupported Content-Transfer-Encoding');
    }
    const contentType = headers.get('content-type') ?? '';
    if (contentType.toLowerCase().startsWith('multipart/')) {
      throw validationFailure('@openmaic/storage: nested multipart parts are not accepted');
    }
    const contentStart = headerEnd + 4;
    const next = body.indexOf(delimiter, contentStart);
    if (next < 0) throw validationFailure('@openmaic/storage: malformed multipart body');
    const bytes = body.subarray(contentStart, next);
    const limit = name === 'meta' ? limits.maxMetaBytes : limits.maxAssetBytes;
    if (bytes.byteLength > limit) {
      const label = name === 'meta' ? 'maxMetaBytes' : 'maxAssetBytes';
      throw payloadTooLarge(`@openmaic/storage: ${name} part exceeds ${label} (${limit})`);
    }
    parts.push({ name, contentType, bytes });

    offset = next + delimiter.length;
    if (body.subarray(offset, offset + 2).equals(Buffer.from('--'))) {
      offset += 2;
      if (body.subarray(offset, offset + 2).equals(Buffer.from('\r\n'))) offset += 2;
      if (offset !== body.length) {
        throw validationFailure('@openmaic/storage: malformed multipart epilogue');
      }
      return parts;
    }
    if (!body.subarray(offset, offset + 2).equals(Buffer.from('\r\n'))) {
      throw validationFailure('@openmaic/storage: malformed multipart boundary');
    }
    offset += 2;
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

function parseMeta(part: MultipartPart): AssetMeta {
  if (part.contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw validationFailure('@openmaic/storage: the meta part must be application/json');
  }
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(part.bytes);
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
    maxPartHeaderBytes: number;
    maxMetaBytes: number;
    maxAssetBytes: number;
  },
): Promise<ParsedWrite> {
  if (req.headers['content-encoding'] !== undefined) {
    throw validationFailure('@openmaic/storage: Content-Encoding is not accepted on asset writes');
  }
  const boundary = parseBoundary(req.headers['content-type']);
  const body = await readBoundedBody(req, limits.maxRequestBytes);
  const parts = parseMultipart(body, boundary, limits);
  const expectedLengths = requiredMeta ? [2] : [1, 2];
  if (!expectedLengths.includes(parts.length)) {
    throw validationFailure('@openmaic/storage: asset write body has the wrong number of parts');
  }
  const metaPart = parts.find((part) => part.name === 'meta');
  const bytesPart = parts.find((part) => part.name === 'bytes');
  if (bytesPart === undefined) {
    throw validationFailure('@openmaic/storage: asset write body must carry a "bytes" part');
  }
  if (requiredMeta && metaPart === undefined) {
    throw validationFailure('@openmaic/storage: asset write body must carry a "meta" part');
  }
  if (metaPart !== undefined && parts[0] !== metaPart) {
    throw validationFailure('@openmaic/storage: the meta part must precede the bytes part');
  }
  if (parts.at(-1) !== bytesPart) {
    throw validationFailure('@openmaic/storage: the bytes part must be last');
  }
  const meta = metaPart === undefined ? undefined : parseMeta(metaPart);
  const bytes = bytesPart.bytes.buffer.slice(
    bytesPart.bytes.byteOffset,
    bytesPart.bytes.byteOffset + bytesPart.bytes.byteLength,
  ) as ArrayBuffer;
  return {
    data: new Blob([bytes], { type: bytesPart.contentType }),
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
    maxPartHeaderBytes: number;
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
    sendJson(req, res, 201, { id }, { 'x-asset-revision': '1' });
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
    sendNoContent(res, { 'x-asset-revision': String(revision) });
    return;
  }

  let asset;
  try {
    asset = await store.resolve(principal, id);
  } catch (error) {
    classifyStoreError(error);
  }
  if (asset === null) throw missingAsset();
  if (!Number.isSafeInteger(asset.revision) || asset.revision < 1) {
    throw new Error('@openmaic/storage: asset store returned a malformed revision');
  }
  const recordedType = typeof asset.mime === 'string' ? asset.mime.toLowerCase() : '';
  const inline = config.renderableTypes.has(recordedType);
  const servedType = inline ? recordedType : 'application/octet-stream';
  const headers: Record<string, string> = {
    'content-type': servedType,
    'content-length': String(asset.bytes.byteLength),
    'x-asset-revision': String(asset.revision),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
    vary: 'Cookie, Authorization',
    'access-control-expose-headers': 'X-Asset-Revision, X-Error-Code',
    ...(inline ? {} : { 'content-disposition': 'attachment' }),
  };
  res.sendDate = false;
  res.writeHead(200, headers);
  res.end(method === 'HEAD' ? undefined : asset.bytes);
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
  const maxPartHeaderBytes = options.maxPartHeaderBytes ?? DEFAULT_MAX_ASSET_PART_HEADER_BYTES;
  for (const [label, value] of [
    ['maxRequestBytes', maxRequestBytes],
    ['maxAssetBytes', maxAssetBytes],
    ['maxMetaBytes', maxMetaBytes],
    ['maxParts', maxParts],
    ['maxPartHeaderBytes', maxPartHeaderBytes],
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
    maxPartHeaderBytes,
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
