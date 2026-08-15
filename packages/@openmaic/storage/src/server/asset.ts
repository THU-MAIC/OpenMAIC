import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { AssetMeta } from '@openmaic/dsl';
import type { AssetId } from '../asset/id.js';
import { assertSignedUrlTtlWithinGrace } from '../asset/collector.js';
import {
  ASSET_DESCRIPTOR_MEDIA_TYPE,
  AssetNotFoundError,
  AssetQuotaExceededError,
  DEFAULT_RENDERABLE_TYPES,
  EXCLUDED_RENDERABLE_TYPES,
  type AssetIndirectRead,
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

/**
 * How byte `GET`s are answered.
 *
 * `direct` -- the default -- serves the bytes in the response body, exactly as
 * this contract has always done. `redirect` opts the deployment into indirect
 * byte egress: when the asset store can mint signed read URLs, a byte `GET` is
 * answered `302 Found` to a short-lived signed URL instead. A store that
 * cannot sign still answers directly, so the option is a preference, not a
 * requirement. The disclosure tradeoff this accepts -- the `Location` names
 * the object, and objects are hash-keyed -- is specified in the asset HTTP
 * contract; read it before enabling this.
 */
export type AssetByteEgress = 'direct' | AssetIndirectByteEgress;

/**
 * Indirect byte egress, together with the reclamation grace it must stay
 * below.
 *
 * `collectionGraceMs` is required, and that is the whole point of this shape.
 * A signed URL must expire far earlier than the bytes it names can be
 * collected, or a reader authorized at mint time errors at the object store:
 * the last reference goes, the grace elapses, the collector deletes the
 * object, and the still-valid URL now points at nothing. The handler and the
 * collector are configured separately, so nothing else on this side knows the
 * grace a deployment runs. Carrying it here lets the handler check the
 * invariant at construction, with both numbers in hand, which makes the
 * unsafe combination unrepresentable rather than merely detectable by a
 * consumer who remembers to look.
 */
export interface AssetIndirectByteEgress {
  readonly mode: 'redirect';
  /**
   * Lifetime of a minted signed URL, in seconds. Defaults to
   * {@link DEFAULT_SIGNED_URL_TTL_SECONDS}, and deliberately short: the signed
   * URL is a bearer credential for its whole lifetime. Must be at most a tenth
   * of `collectionGraceMs`, and at most {@link MAX_SIGNED_URL_TTL_SECONDS}.
   */
  readonly signedUrlTtlSeconds?: number;
  /**
   * The reclamation grace this deployment runs its {@link AssetCollector}
   * with, in milliseconds. Must be the same value the collector receives; a
   * number invented here would validate the invariant against a grace nothing
   * enforces.
   */
  readonly collectionGraceMs: number;
}

/** The shortest signed URL lifetime that still covers a redirect round trip. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 60;

/**
 * Fifteen minutes: the longest lifetime the handler will mint, whatever the
 * grace allows. This ceiling is about the signer rather than the collector --
 * a signed URL is a bearer credential for its whole lifetime, and the shipped
 * SigV4 signer has its own bounds -- so it stands alongside the grace ratio
 * rather than in place of it. The two bite in different deployments: the ratio
 * constrains a short grace, this ceiling constrains a long one.
 */
export const MAX_SIGNED_URL_TTL_SECONDS = 900;

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
  /**
   * Byte `GET` egress. Defaults to `direct`; see {@link AssetByteEgress}. The
   * signed URL lifetime lives inside the indirect variant rather than beside
   * it, so it cannot be set without the grace that bounds it.
   */
  byteEgress?: AssetByteEgress;
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

/** Whether a value is an absolute http(s) URL a client may fetch. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Whether the caller asked for a descriptor answer over a redirect. */
function requestsDescriptor(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== 'string') return false;
  return accept.split(',').some((range) => {
    // Media types are case-insensitive; the constant is lowercase.
    const [type, ...params] = range.split(';');
    if (type?.trim().toLowerCase() !== ASSET_DESCRIPTOR_MEDIA_TYPE) return false;
    // An explicit q=0 rejects the descriptor even though the range matches.
    const quality = params
      .map((param) => param.split('='))
      .find(([name]) => name?.trim().toLowerCase() === 'q');
    return quality === undefined || Number(quality[1]) > 0;
  });
}

/**
 * The descriptor answer to an indirect byte read: the signed URL and the
 * revision in a JSON body, under the vendor media type that both identifies
 * the shape and, being CORS-safelisted in `Accept`, costs no preflight.
 */
function sendDescriptor(
  req: IncomingMessage,
  res: ServerResponse,
  indirect: AssetIndirectRead,
): void {
  res.sendDate = false;
  const encoded = JSON.stringify({ url: indirect.url, revision: indirect.revision });
  res.writeHead(200, {
    'content-type': ASSET_DESCRIPTOR_MEDIA_TYPE,
    ...(req.method === 'GET' || req.method === 'HEAD'
      ? { 'content-length': String(Buffer.byteLength(encoded)) }
      : {}),
    'x-asset-revision': String(indirect.revision),
    'cache-control': 'private, no-store',
    vary: 'Cookie, Authorization, Accept',
    'access-control-expose-headers': 'X-Asset-Revision, X-Error-Code',
  });
  res.end(req.method === 'HEAD' ? undefined : encoded);
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

/**
 * The headers a byte response is served with, computed from the recorded type.
 *
 * Shared by the direct response and the signed-URL labeller, so a type that is
 * relabelled on the direct path is pinned into the signature relabelled on the
 * redirect path -- the allowlist outcome must not depend on the egress mode.
 */
function servedLabel(
  renderableTypes: ReadonlySet<string>,
  mime: unknown,
): { contentType: string; contentDisposition?: string } {
  const recordedType = typeof mime === 'string' ? mime.toLowerCase() : '';
  const inline = renderableTypes.has(recordedType);
  return {
    contentType: inline ? recordedType : 'application/octet-stream',
    ...(inline ? {} : { contentDisposition: 'attachment' }),
  };
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
    // Resolved: the option's grace has already been checked against the
    // lifetime, so the routing path only needs the mode.
    byteEgress: 'direct' | 'redirect';
    signedUrlTtlSeconds: number;
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

  if (method === 'GET' && config.byteEgress === 'redirect') {
    // Indirect egress. The store feature-detect is per call rather than at
    // construction: a deployment toggling the option must degrade to direct
    // bytes, never fail, when its byte layer has no signer.
    const resolveIndirect = store.resolveIndirect;
    if (typeof resolveIndirect === 'function') {
      let indirect: AssetIndirectRead | null | undefined;
      try {
        indirect = await resolveIndirect.call(store, principal, id, {
          label: (mime) => servedLabel(config.renderableTypes, mime),
          cacheControl: 'private, no-store',
          expiresInSeconds: config.signedUrlTtlSeconds,
        });
      } catch (error) {
        classifyStoreError(error);
      }
      if (indirect === null) throw missingAsset();
      if (indirect !== undefined) {
        if (typeof indirect.url !== 'string' || indirect.url === '') {
          throw new Error('@openmaic/storage: asset store returned a malformed signed URL');
        }
        if (!isAbsoluteHttpUrl(indirect.url)) {
          // Only an absolute http(s) URL may be emitted as a signed object
          // URL: anything else fails internally before a descriptor body or a
          // Location header is produced, so a client never fetches it.
          throw new Error('@openmaic/storage: asset store returned a non-http(s) signed URL');
        }
        if (!Number.isSafeInteger(indirect.revision) || indirect.revision < 1) {
          throw new Error('@openmaic/storage: asset store returned a malformed revision');
        }
        if (requestsDescriptor(req)) {
          // A descriptor answer instead of the redirect. A platform fetch
          // follows a 302 with the original request's headers -- only
          // Authorization is stripped across origins -- so following one
          // would forward this deployment's custom credential headers to the
          // object store's origin. The client asks for this shape through
          // Accept, a CORS-safelisted header that adds no preflight, fetches
          // the signed URL itself with none of those headers, and takes the
          // revision from the descriptor body.
          sendDescriptor(req, res, indirect);
          return;
        }
        // The 302 repeats the read route's posture: it is as per-principal and
        // as uncacheable as the bytes it points at. The revision travels on
        // the redirect itself; the signed URL pins the served media type,
        // disposition, and cache posture, so the follow-up response reproduces
        // the direct response's labels. Generic HTTP consumers follow the
        // redirect as-is; the packaged client never sees this branch, because
        // it asks for the descriptor above rather than risk its credential
        // headers being forwarded across origins by redirect handling.
        res.sendDate = false;
        res.writeHead(302, {
          location: indirect.url,
          'x-asset-revision': String(indirect.revision),
          'cache-control': 'private, no-store',
          vary: 'Cookie, Authorization, Accept',
          'access-control-expose-headers': 'X-Asset-Revision, X-Error-Code',
        });
        res.end();
        return;
      }
      // The byte layer cannot sign after all: fall through to direct bytes.
    }
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
  const label = servedLabel(config.renderableTypes, asset.mime);
  const headers: Record<string, string> = {
    'content-type': label.contentType,
    'content-length': String('byteLength' in asset ? asset.byteLength : asset.bytes.byteLength),
    'x-asset-revision': String(asset.revision),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
    vary: 'Cookie, Authorization',
    'access-control-expose-headers': 'X-Asset-Revision, X-Error-Code',
    ...(label.contentDisposition === undefined
      ? {}
      : { 'content-disposition': label.contentDisposition }),
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
  if (configuredTypes.some((value) => value.toLowerCase() === ASSET_DESCRIPTOR_MEDIA_TYPE)) {
    // Reserved: the client identifies a descriptor answer by this exact
    // Content-Type, so no served asset may ever carry it.
    throw new Error(
      '@openmaic/storage: renderableTypes must not contain the asset descriptor media type',
    );
  }
  if (configuredTypes.some((value) => value !== value.trim() || value.includes(';'))) {
    throw new Error('@openmaic/storage: renderableTypes must contain exact media types');
  }

  const egress = options.byteEgress ?? 'direct';
  let byteEgress: 'direct' | 'redirect' = 'direct';
  let signedUrlTtlSeconds = DEFAULT_SIGNED_URL_TTL_SECONDS;
  if (egress !== 'direct') {
    if (typeof egress !== 'object' || egress === null || egress.mode !== 'redirect') {
      throw new Error(
        '@openmaic/storage: byteEgress must be "direct" or { mode: "redirect", collectionGraceMs }',
      );
    }
    byteEgress = 'redirect';
    if (egress.signedUrlTtlSeconds !== undefined) {
      assertPositiveSafeInteger(egress.signedUrlTtlSeconds, 'signedUrlTtlSeconds');
      if (egress.signedUrlTtlSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
        throw new Error(
          `@openmaic/storage: signedUrlTtlSeconds must not exceed ${MAX_SIGNED_URL_TTL_SECONDS}`,
        );
      }
      signedUrlTtlSeconds = egress.signedUrlTtlSeconds;
    }
    // Both numbers are in hand here, which is why the grace is a required
    // field: the invariant is enforced where the feature is enabled, not
    // delegated to a helper the consumer has to remember to call.
    assertSignedUrlTtlWithinGrace(signedUrlTtlSeconds, egress.collectionGraceMs);
  }

  const config = {
    renderableTypes,
    maxRequestBytes,
    maxAssetBytes,
    maxMetaBytes,
    maxParts,
    byteEgress,
    signedUrlTtlSeconds,
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
