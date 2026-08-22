import type { AssetMeta, AssetRef, BinaryBlob, StorageProvider } from '@openmaic/dsl';
import { assertHttpBaseUrl } from '../http/base-url.js';
import { assertJsonValue } from '../runtime/json-value.js';
import { ObjectUrlCache } from './blob.js';
import type { AssetId } from './id.js';
import { ASSET_DESCRIPTOR_MEDIA_TYPE } from './types.js';
export { ASSET_DESCRIPTOR_MEDIA_TYPE };

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
  /**
   * Timeout (ms) for metadata-only existence probes (`exists`) and their
   * fallback resolution. Migration-time checks must never wait on a stalled
   * persistence endpoint indefinitely; playback resolution is unaffected.
   */
  probeTimeoutMs?: number;
}

interface ErrorResponseBody {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

interface ObjectUrlIdentity {
  revision: string;
  mediaType: string;
}

/**
 * Outcome of a byte fetch that has not minted an object URL. `missing` is a
 * confirmed miss (the byte layer declared the object absent); `retry` means
 * the store's snapshot generation moved while the bytes were in flight, and
 * the caller should re-read.
 */
type ByteFetchResult =
  | {
      readonly kind: 'bytes';
      readonly status: number;
      readonly identity: ObjectUrlIdentity;
      readonly bytes: ArrayBuffer;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'retry' };

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

/** Whether a value is an absolute http(s) URL a client may fetch. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * One absolute-deadline budget for a bounded operation. Every request the
 * operation issues -- descriptor GET, signed-object fetch, and the body reads
 * attached to either -- carries the same signal, so a stalled persistence
 * endpoint cannot hold the operation past the deadline no matter which step it
 * stalls at. The timer is cleared with `settle()` once the operation ends.
 */
interface BoundedOperation {
  readonly signal: AbortSignal;
  settle(): void;
}

function startBoundedOperation(timeoutMs: number): BoundedOperation | null {
  if (timeoutMs <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    settle: () => clearTimeout(timer),
  };
}

/**
 * The failure a bounded operation reports when its deadline fires mid-step.
 * Stalled requests already surface as `HTTP_REQUEST_FAILED` through the fetch
 * catch; a stalled body read must map the same way instead of masquerading as
 * a malformed response.
 */
function deadlineFailure(): HttpAssetStoreError {
  return new HttpAssetStoreError(
    0,
    'HTTP_REQUEST_FAILED',
    '@openmaic/storage: asset HTTP request failed',
  );
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

/**
 * The error code of a failed signed-object-store response, or `null` when the
 * body declares none.
 *
 * S3 and MinIO answer object errors with an XML document whose `<Code>` element
 * names the condition (`<Error><Code>NoSuchKey</Code>...`). Only a declared
 * code can confirm an absent object; a body that carries no code -- or that
 * cannot be read at all -- leaves a `404` unclassifiable, and an
 * unclassifiable byte-layer failure is never a miss.
 */
async function signedErrorCode(response: Response): Promise<string | null> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    return null;
  }
  const code = /<Code[^>]*>([^<]*)<\/Code>/.exec(body)?.[1]?.trim();
  return code === undefined || code === '' ? null : code;
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
  private readonly probeTimeoutMs: number;
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
    this.probeTimeoutMs = options.probeTimeoutMs ?? 15_000;
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

  private async fetchResponse(
    method: string,
    path: string,
    body?: Blob,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (this.closed) {
      throw new HttpAssetStoreError(
        0,
        'STORE_CLOSED',
        '@openmaic/storage: HttpAssetStore is closed',
      );
    }
    const headers = await this.headers(method, path, body !== undefined);
    if (body !== undefined) headers['content-type'] = body.type;
    if (method === 'GET') {
      // Ask for a descriptor answer on the byte read, while still accepting
      // ordinary bytes: a redirect-egress server returns the signed URL in a
      // JSON body, and a direct or non-signing one serves the bytes as
      // before. Advertising only the descriptor would let a strict
      // negotiating layer answer 406; the wildcard keeps bytes acceptable.
      // Accept is CORS-safelisted, so the negotiation adds no preflight.
      headers['accept'] = `${ASSET_DESCRIPTOR_MEDIA_TYPE}, */*;q=0.9`;
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(this.credentials === undefined ? {} : { credentials: this.credentials }),
        ...(method === 'GET' || method === 'HEAD' ? { cache: 'no-store' as RequestCache } : {}),
        // The byte GET carries this request's deployment headers; if the server
        // answers it with a redirect, following would forward those headers to
        // the destination (only Authorization is stripped across origins). The
        // GET is therefore never followed: a redirect answer is surfaced to the
        // caller as the 3xx it is, and `get` treats any redirect as an error.
        ...(method === 'GET' ? { redirect: 'manual' as RequestRedirect } : {}),
        ...(body === undefined ? {} : { body }),
        ...(signal === undefined ? {} : { signal }),
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

  /**
   * Read an asset's bytes within an optional bounded operation, without
   * minting an object URL. `get` mints from the returned bytes for playback;
   * the existence probe reads and discards them, so a probe never pins a
   * fetched blob in the URL cache.
   */
  private async fetchBytes(
    id: AssetRef,
    encoded: string,
    bound?: BoundedOperation,
  ): Promise<ByteFetchResult> {
    const generation = this.generation(id);
    const response = await this.fetchResponse(
      'GET',
      `/assets/${encoded}/content`,
      undefined,
      bound?.signal,
    );
    // A redirect answer to the descriptor byte GET means the server ignored the
    // descriptor negotiation (or is misconfigured). The GET is sent with
    // `redirect: 'manual'` above, so a 3xx surfaces here as itself rather than
    // being followed -- following would forward this request's deployment
    // headers to the redirect target. Browsers answer a manual redirect as an
    // opaque-redirect response whose status is 0, so the type is part of the
    // test; Node's fetch reports the real status. Either way the read fails
    // closed, and the redirect target is never touched.
    const redirectAnswer =
      response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
    if (redirectAnswer) {
      throw malformed(
        response.status,
        '@openmaic/storage: asset byte GET answered with a redirect, which is never followed',
      );
    }
    if (!response.ok) {
      const error = await this.httpError(response);
      if (error.status === 404 && error.code === 'ASSET_NOT_FOUND') {
        this.identities.delete(id);
        await this.urls.invalidate(id);
        return { kind: 'missing' };
      }
      throw error;
    }
    let identity: ObjectUrlIdentity | null = null;
    let bytes: ArrayBuffer;
    // Exact essence match, case-insensitive as media types are: a longer
    // media type that merely begins with the reserved value is a legitimate
    // payload type, not a descriptor.
    const servedEssence = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
    if (servedEssence?.toLowerCase() === ASSET_DESCRIPTOR_MEDIA_TYPE) {
      // Indirect egress, answered as a descriptor rather than a redirect.
      // Following a 302 would forward this request's headers -- the
      // deployment's custom credential headers included; only Authorization
      // is stripped across origins -- to the object store. The descriptor
      // carries the revision, and the bytes are fetched with no deployment
      // headers at all.
      let descriptor: unknown;
      try {
        descriptor = await response.json();
      } catch {
        if (bound?.signal.aborted) throw deadlineFailure();
        throw malformed(
          response.status,
          '@openmaic/storage: asset egress descriptor could not be read',
        );
      }
      const signedUrl =
        typeof descriptor === 'object' && descriptor !== null && 'url' in descriptor
          ? (descriptor as { url?: unknown }).url
          : undefined;
      const revision =
        typeof descriptor === 'object' && descriptor !== null && 'revision' in descriptor
          ? (descriptor as { revision?: unknown }).revision
          : undefined;
      if (
        typeof signedUrl !== 'string' ||
        signedUrl === '' ||
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      ) {
        throw malformed(
          response.status,
          '@openmaic/storage: asset egress descriptor must carry a url and revision',
        );
      }
      if (!isAbsoluteHttpUrl(signedUrl)) {
        // Only an absolute http(s) URL may be fetched for the bytes; anything
        // else is a malformed descriptor, and the follow-up request must never
        // be issued against it.
        throw malformed(
          response.status,
          '@openmaic/storage: asset egress descriptor must carry an absolute http(s) url',
        );
      }
      let byteResponse: Response;
      try {
        byteResponse = await this.fetchImpl(signedUrl, {
          cache: 'no-store',
          credentials: 'omit',
          ...(bound === undefined ? {} : { signal: bound.signal }),
        });
      } catch {
        throw new HttpAssetStoreError(
          0,
          'HTTP_REQUEST_FAILED',
          '@openmaic/storage: asset HTTP request failed',
        );
      }
      if (byteResponse.status === 404) {
        // A miss reported by the byte layer instead of by the registry is only
        // a miss when the object store confirms it. The entry was owned and
        // readable when the URL was minted, so the only way its bytes are gone
        // is reclamation landing between the mint and this fetch -- the same
        // physical state the direct path reports as a miss. But a bare 404 is
        // equally what a wrong bucket, access point, or endpoint answers, under
        // which the bytes still exist; only the store's declared error code can
        // tell the two apart. Anything short of a confirmed missing object
        // fails loud, so a service-level 404 never reads as a deleted asset.
        const code = await signedErrorCode(byteResponse);
        if (code === 'NoSuchKey') {
          this.identities.delete(id);
          await this.urls.invalidate(id);
          return { kind: 'missing' };
        }
        throw malformed(
          byteResponse.status,
          '@openmaic/storage: asset signed URL answered 404 without confirming a missing object',
        );
      }
      if (!byteResponse.ok) {
        throw malformed(
          byteResponse.status,
          '@openmaic/storage: asset signed URL did not serve bytes',
        );
      }
      const mediaType = byteResponse.headers.get('content-type');
      if (mediaType === null || mediaType === '') {
        throw malformed(
          byteResponse.status,
          '@openmaic/storage: asset byte response must carry content type and revision',
        );
      }
      identity = { revision: String(revision), mediaType };
      try {
        bytes = await byteResponse.arrayBuffer();
      } catch {
        if (bound?.signal.aborted) throw deadlineFailure();
        throw malformed(
          byteResponse.status,
          '@openmaic/storage: asset byte response could not be read',
        );
      }
    } else {
      identity = responseIdentity(response);
      if (response.status !== 200 || identity === null) {
        throw malformed(
          response.status,
          '@openmaic/storage: asset byte response must carry content type and revision',
        );
      }
      try {
        bytes = await response.arrayBuffer();
      } catch {
        if (bound?.signal.aborted) throw deadlineFailure();
        throw malformed(
          response.status,
          '@openmaic/storage: asset byte response could not be read',
        );
      }
    }
    if (this.generation(id) !== generation) return { kind: 'retry' };
    return { kind: 'bytes', status: response.status, identity, bytes };
  }

  private async get(
    id: AssetRef,
    encoded: string,
    bound?: BoundedOperation,
  ): Promise<{ url: string | null; retry: boolean }> {
    const generation = this.generation(id);
    const fetched = await this.fetchBytes(id, encoded, bound);
    if (fetched.kind === 'missing') return { url: null, retry: false };
    if (fetched.kind === 'retry') return { url: null, retry: true };
    const { identity, bytes, status } = fetched;
    const url = await this.urls.resolve(id, identity, async () => {
      let minted: string;
      try {
        minted = URL.createObjectURL(new Blob([bytes], { type: identity.mediaType }));
      } catch {
        throw malformed(status, '@openmaic/storage: asset object URL could not be created');
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

  /**
   * Byte-level existence check: the GET a probe issues when the HEAD cannot
   * classify the answer. Reads the bytes only to confirm they exist, then
   * discards them -- a migration probe that cached an object URL per endpoint
   * would pin every fetched blob until store close. A snapshot-generation
   * change mid-fetch re-reads, like the resolve loop.
   */
  private async probeBytes(
    id: AssetRef,
    encoded: string,
    bound: BoundedOperation,
  ): Promise<boolean> {
    while (true) {
      const fetched = await this.fetchBytes(id, encoded, bound);
      if (fetched.kind === 'bytes') return true;
      if (fetched.kind === 'missing') return false;
      // The store's snapshot generation moved while the bytes were in flight;
      // re-read under the same absolute deadline.
    }
  }

  private async resolveFresh(
    id: AssetRef,
    encoded: string,
    bound?: BoundedOperation,
  ): Promise<string | null> {
    while (true) {
      const known = this.identities.get(id);
      if (known !== undefined) {
        const response = await this.fetchResponse(
          'HEAD',
          `/assets/${encoded}/content`,
          undefined,
          bound?.signal,
        );
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
      const result = await this.get(id, encoded, bound);
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

  /** Retire this client's cached snapshot without revoking any issued URL. */
  async invalidate(id: AssetRef): Promise<void> {
    this.generations.set(id, this.generation(id) + 1);
    this.inFlight.delete(id);
    this.identities.delete(id);
    await this.urls.invalidate(id);
  }

  /**
   * Metadata-only existence probe: a HEAD against the byte route first, then
   * -- only when the HEAD cannot classify the answer -- a bounded byte read
   * that is discarded, never a minted or retained object URL. Bounded by ONE
   * absolute deadline that also covers the fallback read, including the
   * descriptor read, the signed fetch, and the body parsing, so a stalled
   * persistence endpoint cannot hold a migration-time check on any of its
   * steps.
   */
  async exists(id: AssetRef): Promise<boolean> {
    const encoded = addressableSegment(id);
    if (encoded === null) return false;
    const bound = startBoundedOperation(this.probeTimeoutMs);
    if (!bound) throw deadlineFailure();
    try {
      const response = await this.fetchResponse(
        'HEAD',
        `/assets/${encoded}/content`,
        undefined,
        bound.signal,
      );
      if (response.ok) {
        // A 200 is proof of existence only when it carries the response
        // identity the byte route requires (revision plus content type): an
        // auth wall or a redirect landing page can answer 200 without either,
        // and trusting it would make a probe report an unresolvable id as
        // present, dropping a co-present legacy handle for bytes that do not
        // exist. An identity-less success is unclassifiable -- exactly like a
        // status without a code -- and the bounded byte read decides, the way
        // the warm path in `resolveFresh` refuses a HEAD that does not match a
        // known identity.
        if (response.status === 200 && responseIdentity(response) !== null) return true;
      } else {
        const code = response.headers.get('x-error-code');
        if (response.status === 404 && code === 'ASSET_NOT_FOUND') return false;
        if (code !== null) throw await this.httpError(response);
      }
      // An unclassifiable HEAD is not a definitive miss; the byte read
      // decides. The fallback shares the probe's absolute deadline and never
      // mints or retains an object URL.
      return await this.probeBytes(id, encoded, bound);
    } finally {
      bound.settle();
    }
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
