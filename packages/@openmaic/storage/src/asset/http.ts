import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';
import { assertHttpBaseUrl } from '../http/base-url.js';
import { assertJsonValue } from '../runtime/json-value.js';
import { ObjectUrlCache } from './blob.js';
import type { AssetId } from './id.js';

export interface HttpAssetHeadersContext {
  method: string;
  path: string;
}

export type HttpAssetHeadersHook = (
  context: HttpAssetHeadersContext,
) => HeadersInit | Promise<HeadersInit>;

export interface HttpAssetStoreOptions {
  /** Root URL before the contract's `/assets/...` paths. */
  baseUrl: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Called for every request so deployments can attach authentication headers. */
  headers?: HttpAssetHeadersHook;
  /** Passed through to fetch unchanged. */
  credentials?: RequestCredentials;
}

interface ErrorResponseBody {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

interface ObjectUrlIdentity {
  revision: string;
  mediaType: string;
}

// These fixed filenames preserve part bytes under standards-conforming parsers. Neither filename
// is read by this package or derived from caller data.
const ASSET_META_FILENAME = 'metadata.json';
const ASSET_BYTES_FILENAME = 'asset';
const DEFAULT_ASSET_CONTENT_TYPE = 'application/octet-stream';

/** An asset HTTP failure, retaining its machine-readable identity. */
export class HttpAssetStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpAssetStoreError';
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

function malformed(status: number, message: string): HttpAssetStoreError {
  return new HttpAssetStoreError(status, 'MALFORMED_RESPONSE', message);
}

function localNotFound(): HttpAssetStoreError {
  return new HttpAssetStoreError(
    404,
    'ASSET_NOT_FOUND',
    '@openmaic/storage: no asset is stored under that id',
  );
}

function addressableSegment(id: string): string | null {
  if (id === '' || id === '.' || id === '..') return null;
  try {
    return encodeURIComponent(id);
  } catch {
    return null;
  }
}

function assertMetadata(meta: AssetMeta): void {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new HttpAssetStoreError(
      0,
      'VALIDATION_FAILED',
      '@openmaic/storage: asset metadata must be a plain JSON object',
    );
  }
  if ('principal' in meta || 'contentHash' in meta) {
    throw new HttpAssetStoreError(
      0,
      'VALIDATION_FAILED',
      '@openmaic/storage: asset metadata contains a prohibited member',
    );
  }
  try {
    assertJsonValue(meta, 'asset metadata');
  } catch (error) {
    throw new HttpAssetStoreError(
      0,
      'VALIDATION_FAILED',
      error instanceof Error ? error.message : '@openmaic/storage: invalid asset metadata',
    );
  }
}

function responseIdentity(response: Response): ObjectUrlIdentity | null {
  const revision = response.headers.get('x-asset-revision');
  const mediaType = response.headers.get('content-type');
  return revision === null || revision === '' || mediaType === null || mediaType === ''
    ? null
    : { revision, mediaType };
}

function sameIdentity(left: ObjectUrlIdentity, right: ObjectUrlIdentity): boolean {
  return left.revision === right.revision && left.mediaType === right.mediaType;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0) return true;
  for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    let equal = true;
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) {
        equal = false;
        break;
      }
    }
    if (equal) return true;
  }
  return false;
}

/** AssetStore client that downloads bytes and mints authenticated object URLs locally. */
export class HttpAssetStore implements StorageProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headersHook: HttpAssetHeadersHook | undefined;
  private readonly credentials: RequestCredentials | undefined;
  private readonly urls = new ObjectUrlCache<ObjectUrlIdentity>(sameIdentity);
  private readonly identities = new Map<AssetRef, ObjectUrlIdentity>();
  private readonly inFlight = new Map<AssetRef, Promise<string | null>>();
  private readonly generations = new Map<AssetRef, number>();
  private closed = false;

  constructor(options: HttpAssetStoreOptions) {
    const selectedFetch = options.fetch ?? globalThis.fetch;
    if (typeof selectedFetch !== 'function') {
      throw new Error('@openmaic/storage: HttpAssetStore requires a fetch implementation');
    }
    this.baseUrl = assertHttpBaseUrl(options.baseUrl, 'HttpAssetStore');
    this.fetchImpl = selectedFetch.bind(globalThis);
    this.headersHook = options.headers;
    this.credentials = options.credentials;
  }

  private generation(id: AssetRef): number {
    return this.generations.get(id) ?? 0;
  }

  private async headers(
    method: string,
    path: string,
    multipart: boolean,
  ): Promise<Record<string, string>> {
    let headers: Record<string, string>;
    try {
      headers = normalizeHeaders(await this.headersHook?.({ method, path }));
    } catch {
      throw new HttpAssetStoreError(
        0,
        'HTTP_REQUEST_FAILED',
        '@openmaic/storage: asset request headers could not be constructed',
      );
    }
    if (multipart && headers['content-type'] !== undefined) {
      throw new HttpAssetStoreError(
        0,
        'CONTENT_TYPE_CONFLICT',
        '@openmaic/storage: the headers hook must not set Content-Type for multipart asset writes',
      );
    }
    return headers;
  }

  private async fetchResponse(method: string, path: string, body?: Blob): Promise<Response> {
    if (this.closed) {
      throw new HttpAssetStoreError(
        0,
        'STORE_CLOSED',
        '@openmaic/storage: HttpAssetStore is closed',
      );
    }
    const headers = await this.headers(method, path, body !== undefined);
    if (body !== undefined) headers['content-type'] = body.type;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(this.credentials === undefined ? {} : { credentials: this.credentials }),
        ...(method === 'GET' || method === 'HEAD' ? { cache: 'no-store' as RequestCache } : {}),
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      throw new HttpAssetStoreError(
        0,
        'HTTP_REQUEST_FAILED',
        '@openmaic/storage: asset HTTP request failed',
      );
    }
  }

  private async httpError(response: Response): Promise<HttpAssetStoreError> {
    let body: ErrorResponseBody | undefined;
    if (response.status !== 204) {
      try {
        body = (await response.json()) as ErrorResponseBody;
      } catch {
        // Preserve a typed HTTP error for a non-conforming response.
      }
    }
    const headerCode = response.headers.get('x-error-code');
    const bodyCode = typeof body?.error?.code === 'string' ? body.error.code : undefined;
    const code = bodyCode ?? headerCode ?? 'HTTP_ERROR';
    const message =
      typeof body?.error?.message === 'string'
        ? body.error.message
        : `@openmaic/storage: asset HTTP request failed with status ${response.status}`;
    return new HttpAssetStoreError(response.status, code, message, body?.error?.details);
  }

  private async writeForm(
    data: BinaryBlob,
    meta: AssetMeta | undefined,
    includeMeta: boolean,
  ): Promise<Blob> {
    if (includeMeta) assertMetadata(meta ?? {});
    let bytes: ArrayBuffer;
    try {
      bytes = await data.arrayBuffer();
    } catch {
      throw new HttpAssetStoreError(
        0,
        'VALIDATION_FAILED',
        '@openmaic/storage: asset bytes could not be read',
      );
    }
    if (!/^[\x20-\x7e]*$/.test(data.type)) {
      throw new HttpAssetStoreError(
        0,
        'VALIDATION_FAILED',
        '@openmaic/storage: asset media type contains characters that cannot be carried in a header',
      );
    }
    let encoded: string | undefined;
    if (includeMeta) {
      try {
        encoded = JSON.stringify(meta ?? {});
      } catch {
        throw new HttpAssetStoreError(
          0,
          'VALIDATION_FAILED',
          '@openmaic/storage: asset metadata could not be serialized',
        );
      }
    }
    let boundary: string;
    try {
      const content = new Uint8Array(bytes);
      do {
        const random = new Uint8Array(16);
        globalThis.crypto.getRandomValues(random);
        const suffix = Array.from(random, (value) => value.toString(16).padStart(2, '0')).join('');
        boundary = `openmaic-${suffix}`;
      } while (
        encoded?.includes(boundary) === true ||
        containsBytes(content, new TextEncoder().encode(boundary))
      );
    } catch {
      throw new HttpAssetStoreError(
        0,
        'HTTP_REQUEST_FAILED',
        '@openmaic/storage: a safe multipart boundary could not be generated',
      );
    }
    const parts: BlobPart[] = [];
    if (encoded !== undefined) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="meta"; filename="${ASSET_META_FILENAME}"\r\n` +
          'Content-Type: application/json\r\n\r\n' +
          `${encoded}\r\n`,
      );
    }
    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="bytes"; filename="${ASSET_BYTES_FILENAME}"\r\n` +
        `Content-Type: ${data.type === '' ? DEFAULT_ASSET_CONTENT_TYPE : data.type}\r\n` +
        '\r\n',
      bytes,
      `\r\n--${boundary}--\r\n`,
    );
    return new Blob(parts, { type: `multipart/form-data; boundary=${boundary}` });
  }

  async put(data: BinaryBlob, meta?: AssetMeta): Promise<AssetRef> {
    const path = '/assets';
    const response = await this.fetchResponse('POST', path, await this.writeForm(data, meta, true));
    if (!response.ok) throw await this.httpError(response);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw malformed(
        response.status,
        '@openmaic/storage: asset allocation response was not valid JSON',
      );
    }
    const id =
      typeof body === 'object' && body !== null && 'id' in body
        ? (body as { id?: unknown }).id
        : undefined;
    if (
      response.status !== 201 ||
      typeof id !== 'string' ||
      id === '' ||
      response.headers.get('x-asset-revision') === null ||
      response.headers.get('x-asset-revision') === ''
    ) {
      throw malformed(
        response.status,
        '@openmaic/storage: asset allocation response must carry an id and revision',
      );
    }
    return id;
  }

  private async get(
    id: AssetRef,
    encoded: string,
  ): Promise<{ url: string | null; retry: boolean }> {
    const generation = this.generation(id);
    const response = await this.fetchResponse('GET', `/assets/${encoded}/content`);
    if (!response.ok) {
      const error = await this.httpError(response);
      if (error.status === 404 && error.code === 'ASSET_NOT_FOUND') {
        this.identities.delete(id);
        await this.urls.invalidate(id);
        return { url: null, retry: false };
      }
      throw error;
    }
    const identity = responseIdentity(response);
    if (response.status !== 200 || identity === null) {
      throw malformed(
        response.status,
        '@openmaic/storage: asset byte response must carry content type and revision',
      );
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch {
      throw malformed(response.status, '@openmaic/storage: asset byte response could not be read');
    }
    if (this.generation(id) !== generation) return { url: null, retry: true };
    const url = await this.urls.resolve(id, identity, async () => {
      let minted: string;
      try {
        minted = URL.createObjectURL(new Blob([bytes], { type: identity.mediaType }));
      } catch {
        throw malformed(
          response.status,
          '@openmaic/storage: asset object URL could not be created',
        );
      }
      return { identity, url: minted };
    });
    if (this.generation(id) !== generation) {
      await this.urls.invalidate(id);
      return { url: null, retry: true };
    }
    this.identities.set(id, identity);
    return { url, retry: false };
  }

  private async resolveFresh(id: AssetRef, encoded: string): Promise<string | null> {
    while (true) {
      const known = this.identities.get(id);
      if (known !== undefined) {
        const response = await this.fetchResponse('HEAD', `/assets/${encoded}/content`);
        if (response.ok) {
          const identity = response.status === 200 ? responseIdentity(response) : null;
          if (identity !== null && sameIdentity(known, identity)) {
            return this.urls.resolve(id, known, async () => null);
          }
          // A successful but unclassifiable HEAD is not a miss; GET decides.
        } else {
          const code = response.headers.get('x-error-code');
          if (response.status === 404 && code === 'ASSET_NOT_FOUND') {
            this.identities.delete(id);
            await this.urls.invalidate(id);
            return null;
          }
          if (code !== null) throw await this.httpError(response);
          // A HEAD error without a classifiable code falls back to GET.
        }
      }
      const result = await this.get(id, encoded);
      if (!result.retry) return result.url;
    }
  }

  async resolve(id: AssetRef): Promise<string | null> {
    const encoded = addressableSegment(id);
    if (encoded === null) {
      this.identities.delete(id);
      await this.urls.invalidate(id);
      return null;
    }
    const current = this.inFlight.get(id);
    if (current !== undefined) return current;
    const resolution = this.resolveFresh(id, encoded);
    this.inFlight.set(id, resolution);
    try {
      return await resolution;
    } finally {
      if (this.inFlight.get(id) === resolution) this.inFlight.delete(id);
    }
  }

  private async invalidate(id: AssetRef): Promise<void> {
    this.generations.set(id, this.generation(id) + 1);
    this.inFlight.delete(id);
    this.identities.delete(id);
    await this.urls.invalidate(id);
  }

  async remove(id: AssetRef): Promise<void> {
    const encoded = addressableSegment(id);
    if (encoded === null) {
      await this.invalidate(id);
      return;
    }
    const response = await this.fetchResponse('DELETE', `/assets/${encoded}`);
    if (!response.ok) throw await this.httpError(response);
    if (response.status !== 204) {
      throw malformed(response.status, '@openmaic/storage: asset removal response must be 204');
    }
    await this.invalidate(id);
  }

  async replace(id: AssetId, data: BinaryBlob, meta?: AssetMeta): Promise<void> {
    const encoded = addressableSegment(id);
    if (encoded === null) throw localNotFound();
    const includeMeta = meta !== undefined;
    const response = await this.fetchResponse(
      'PUT',
      `/assets/${encoded}/content`,
      await this.writeForm(data, meta, includeMeta),
    );
    if (!response.ok) throw await this.httpError(response);
    const revision = response.headers.get('x-asset-revision');
    if (response.status !== 204 || revision === null || revision === '') {
      throw malformed(
        response.status,
        '@openmaic/storage: asset replacement response must be 204 with a revision',
      );
    }
    await this.invalidate(id);
  }

  async release(id: AssetRef): Promise<void> {
    this.generations.set(id, this.generation(id) + 1);
    this.inFlight.delete(id);
    this.identities.delete(id);
    await this.urls.release(id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.inFlight.clear();
    this.identities.clear();
    await this.urls.close();
  }
}
