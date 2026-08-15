/**
 * The server-side asset store interface.
 *
 * The backend shape only: the handler's options live in `../server/asset.js`,
 * which can name a Node request type that this browser-reachable module cannot
 * import. The backends themselves, the HTTP handler, and the HTTP client are
 * separate units.
 *
 * The difference from the browser backend is the principal. In a browser the
 * store *is* the boundary — one origin, one database, one user — so ownership
 * needs no representation. On a server one registry holds every principal's
 * entries, so every operation takes the principal it acts on behalf of, and
 * that principal is the enforcing boundary. See `docs/asset-http-contract.md`,
 * which is normative for everything below.
 */
import type { AssetMeta, AssetRef, BinaryBlob } from '@openmaic/dsl';

import type { AssetSignedReadHeaders } from './byte-store.js';
import type { AssetId } from './id.js';

/**
 * The identity an operation acts on behalf of.
 *
 * Derived server-side from an authenticated session. It is never accepted from
 * a request path, query parameter, or body: a client-submitted principal is not
 * proof of identity, and trusting one makes every operation a
 * lateral-authorization vulnerability.
 *
 * `key` is required, and deliberately so. Assets are partitioned per principal,
 * and every registry entry is partitioned on this value; an optional field
 * would make `{}` a conforming principal and collapse every principal lacking
 * one into a single shared partition they could all read, replace, and delete.
 * That is why this does not copy the document layer's all-optional principal —
 * documents are author assets with no per-row ownership model, assets are not.
 * A deployment whose authenticator cannot produce a key has no asset capability
 * and must be refused, not given a partition keyed on nothing.
 */
export interface AssetPrincipal {
  /** Opaque, deployment-defined partition key. Compared, never parsed. */
  readonly key: string;
  /** Carried so one principal object can serve several layers. Not the partition key. */
  readonly learnerKey?: string;
}

/**
 * Raised when an id names no entry this principal holds.
 *
 * A class rather than an interface because a handler has to tell "no such
 * entry" (a `404`) from an internal failure (a `500`), and the alternatives are
 * both antipatterns: classifying from an error string, or duck-typing a `code`
 * member with no shared constructor two backends could agree on.
 *
 * An unknown id and another principal's id raise this identically — a
 * difference between them is an existence oracle.
 */
export class AssetNotFoundError extends Error {
  readonly code = 'ASSET_NOT_FOUND' as const;

  constructor(message = '@openmaic/storage: no asset is stored under that id') {
    super(message);
    this.name = 'AssetNotFoundError';
  }
}

/**
 * Raised when a write would take the principal past its logical byte quota.
 *
 * Declared for the same reason as {@link AssetNotFoundError}: a handler must
 * map this to its own status rather than collapsing it into an internal error,
 * and a caller must be able to tell "you are over quota" from "the server
 * broke" and from "this one request was too large".
 */
export class AssetQuotaExceededError extends Error {
  readonly code = 'ASSET_QUOTA_EXCEEDED' as const;

  constructor(message = '@openmaic/storage: asset quota exceeded for this principal') {
    super(message);
    this.name = 'AssetQuotaExceededError';
  }
}

/**
 * Media types served inline by default.
 *
 * A deployment may narrow this. Widening it is a decision about executable
 * content, which is what {@link EXCLUDED_RENDERABLE_TYPES} exists to bound.
 */
export const DEFAULT_RENDERABLE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/ogg',
];

/**
 * Media types that MUST never be served inline, whatever a deployment
 * configures.
 *
 * Each executes script in a browsing context, so serving one same-origin turns
 * stored bytes into stored script. A handler rejects a configured allowlist
 * containing any of these at construction rather than trusting the prose: this
 * is the one setting that converts a storage bug into cross-site scripting, and
 * a rule enforced only by documentation is not enforced.
 */
export const EXCLUDED_RENDERABLE_TYPES: readonly string[] = [
  'image/svg+xml',
  'image/svg',
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'application/pdf',
];

/**
 * A store of allocated assets, partitioned by principal.
 *
 * Server implementations write bytes before the registry transaction and
 * reclaim them only through an offline collector. The registry transaction
 * owns ids, principals, metadata, revisions, and the reference-count decision;
 * the byte layer may live in PostgreSQL or an object store. A crash between the
 * byte write and the registry transaction may therefore leave harmless orphan
 * bytes, but it must never leave a registry entry that points at bytes which
 * were not stored.
 *
 * Request paths never delete bytes. Reads hold a shared blob-row lock while
 * accessing the byte layer, and collection takes an exclusive lock before
 * deletion. This separation is what makes the byte layer replaceable without
 * changing the observable store semantics.
 */
export interface AssetStore {
  /**
   * Store bytes and return a newly allocated id.
   *
   * Every successful call allocates a **new** id, including for bytes the
   * registry already holds. Returning an existing id would let any caller test
   * whether arbitrary bytes are already stored, which is an existence oracle
   * over data the caller never stored.
   *
   * The requirement covers more than the return value: every branch taken and
   * every value returned on the success path must be independent of whether
   * the bytes were already present. An implementation writes the bytes
   * unconditionally rather than reading first, so both cases execute the same
   * statements in the same order.
   *
   * Quota, metering, and cost stay outside that guarantee. Quota MUST be
   * accounted on the principal's logical bytes — the sum of bytes referenced by
   * that principal's entries — never on bytes physically newly written, and the
   * check MUST precede any physical write, raising
   * {@link AssetQuotaExceededError}, so that a capacity failure is never what a
   * caller observes first.
   */
  put(principal: AssetPrincipal, data: BinaryBlob, meta?: AssetMeta): Promise<AssetId>;

  /**
   * Read the response identity stored under an id without reading its bytes.
   *
   * Ownership and miss behavior are identical to {@link resolve}. The byte
   * length is registry data used only to reproduce the `GET` response headers
   * on a bytes-free HTTP `HEAD` request.
   */
  identify(principal: AssetPrincipal, ref: AssetRef): Promise<AssetIdentity | null>;

  /**
   * Read the bytes stored under an id, or `null` if there are none.
   *
   * An id this registry never allocated, an id belonging to another principal,
   * an id from another id space, an empty string, a string containing NUL — all
   * are misses, and none is an error. There is no id validator to disagree
   * with, and an implementation that rejected an id for its shape would answer
   * a question the caller is not entitled to ask.
   *
   * An entry whose bytes are gone is also a miss; inventing an error there
   * would make reclamation observable. That state must be reachable only
   * through host-level collection or tampering, never through concurrent
   * operations on this interface.
   *
   * The returned media type and revision MUST come from the same transactional
   * snapshot as the bytes, or a concurrent `replace` pairs one revision's
   * headers with another revision's bytes.
   */
  resolve(principal: AssetPrincipal, ref: AssetRef): Promise<AssetBytes | null>;

  /**
   * Remove the entry stored under an id.
   *
   * A no-op for an unknown id, another principal's id, and an already-removed
   * id — all three succeed, indistinguishably. Any difference between them is
   * an existence oracle.
   *
   * When the removed entry was the last one naming its bytes, those bytes
   * become reclaimable. The count that decides this spans all principals, which
   * is what makes global deduplication reclaimable, and its value must not
   * appear in any response.
   */
  remove(principal: AssetPrincipal, ref: AssetRef): Promise<void>;

  /**
   * Replace the bytes behind an allocated id without changing the id.
   *
   * This is what makes an allocated id a stable reference: bytes can be
   * regenerated in place without rewriting every document that points at them.
   * It has no counterpart on the DSL storage interface, which is why a server
   * backend must implement it explicitly — a backend without it silently loses
   * in-place regeneration.
   *
   * `meta` is optional, and the two branches differ in a way callers depend on.
   * Supplied, it replaces the entry's metadata and the media type comes from its
   * `contentType` when that member is present — including when it is the empty
   * string — falling back to the blob's own type only when it is absent.
   * **Omitted, the entry's metadata is retained** and its media type is
   * retained unless the blob carries one. Regenerating bytes while keeping
   * recorded provenance is the reason this method exists, so an implementation
   * that folded omission into an empty object would erase that provenance on
   * every regeneration.
   *
   * Advances and returns the entry's revision. The exact value lets an HTTP
   * handler report the revision produced by this write without a racy follow-up
   * read. Rejects an unknown id and another principal's id identically, with
   * {@link AssetNotFoundError}.
   */
  replace(
    principal: AssetPrincipal,
    ref: AssetId,
    data: BinaryBlob,
    meta?: AssetMeta,
  ): Promise<number>;

  /**
   * Resolve an id to a short-lived signed byte URL instead of to the bytes.
   *
   * Optional, and only ever called by a server whose deployment opted into
   * indirect byte egress; see the asset HTTP contract. Ownership and miss
   * behavior are identical to {@link resolve}: the same ownership-checked read
   * runs first, and the signed URL is minted only for an entry this principal
   * holds, so opting in changes nothing about who may learn what a URL serves.
   *
   * Three outcomes rather than two, because the capability and the entry are
   * independent questions:
   *
   * - `undefined` -- this store's byte layer cannot sign. The caller falls
   *   back to {@link resolve} and answers with the bytes directly.
   * - `null` -- a miss, exactly as {@link resolve} reports one.
   * - an {@link AssetIndirectRead} -- the minted URL and the entry revision.
   *
   * The `request.label` callback runs **inside** the read transaction, on the
   * recorded media type of the entry just read, so the headers pinned into the
   * signature come from the same snapshot as the hash being signed. A pair of
   * calls -- one to learn the type, one to sign -- would let a concurrent
   * `replace` pin one revision's label onto another revision's bytes, which is
   * the race the byte-response rule already forbids.
   */
  resolveIndirect?(
    principal: AssetPrincipal,
    ref: AssetRef,
    request: AssetIndirectReadRequest,
  ): Promise<AssetIndirectRead | null | undefined>;
}

/**
 * The bytes stored under an id, with the identity needed to revalidate them.
 */
export interface AssetBytes {
  /** The stored bytes. */
  readonly bytes: Uint8Array;
  /**
   * The recorded media type, used to label the response.
   *
   * Labelling is subject to the renderable allowlist: a type outside it — and
   * the empty string, which is what an untyped blob with an absent
   * `contentType` records — is relabelled and served as an attachment. It is
   * still served: relabelling is not refusal.
   */
  readonly mime: string;
  /**
   * A monotonically increasing counter on the registry entry, starting at 1 and
   * advanced by each `replace`.
   *
   * Opaque except for equality comparison, and **never derived from the
   * content**. A content-derived validator is the content hash under another
   * name: it would disclose byte equality across ids to anyone holding two of
   * them, which is precisely what the registry layer exists to prevent.
   */
  readonly revision: number;
}

/** Registry identity and representation length for a bytes-free read. */
export interface AssetIdentity {
  /** The recorded media type, subject to the HTTP renderable allowlist. */
  readonly mime: string;
  /** The registry entry revision. */
  readonly revision: number;
  /** The stored representation length, in bytes. */
  readonly byteLength: number;
}

/**
 * What an indirect read asks the store to mint.
 *
 * The `label` callback is how the serving layer's renderable allowlist reaches
 * the signature without the byte layer learning the allowlist: the store reads
 * the entry, hands its recorded media type to `label`, and pins the returned
 * overrides into the signed URL.
 */
export interface AssetIndirectReadRequest {
  /** Compute the served response headers from the recorded media type. */
  label(mime: string): Pick<AssetSignedReadHeaders, 'contentType' | 'contentDisposition'>;
  /** The read route's cache posture, pinned into the signed response. */
  cacheControl: string;
  /** Signed URL lifetime in seconds. Short: the URL is a bearer credential. */
  expiresInSeconds: number;
}

/**
 * A signed byte URL minted for an authorized read.
 *
 * Carries the revision so the redirect response can report it exactly as the
 * direct byte response would have. The byte length is not carried: a redirect
 * has no body, so there is no `Content-Length` to reproduce, and the signed
 * response reports its own.
 */
export interface AssetIndirectRead {
  /** The short-lived signed URL the caller is redirected to. */
  readonly url: string;
  /** The registry entry revision, from the same read that minted the URL. */
  readonly revision: number;
}

/**
 * The vendor media type of an indirect-egress descriptor answer. A client
 * asks for it through `Accept` -- a CORS-safelisted header, so the
 * negotiation never adds a preflight -- and the server marks the descriptor
 * response with it as `Content-Type`, so a stored asset can never parse as a
 * descriptor.
 */
export const ASSET_DESCRIPTOR_MEDIA_TYPE = 'application/vnd.openmaic.asset-descriptor+json';
