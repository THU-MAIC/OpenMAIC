/**
 * The asset-pool identifier: an **allocated** id, not a derived one.
 *
 * An `AssetId` is minted at `put` time and never computed from the bytes it
 * ends up pointing at. That is the whole point of the registry layer: the bytes
 * behind an id may be regenerated or replaced through
 * `BrowserAssetStore.replace` without invalidating a single reference, and one
 * set of bytes may back several ids carrying different metadata. A derived id
 * collapses both.
 *
 * Shape: the literal prefix `ast_` followed by 128 bits of randomness encoded
 * in a 32-character lowercase alphabet. The prefix is a documented,
 * human-visible part of the rendering: it makes an id slotted into the wrong
 * field obvious in a log or a diff. The prefix constant is deliberately not
 * exported from the package API, so downstream code cannot grow a validator
 * from it. The body encoding remains an implementation detail.
 *
 * Random, not time-ordered: nothing sorts or ranges over asset ids (the
 * registry is a point-lookup table and a manifest is a set), so ordering buys
 * nothing, while a time-ordered id would leak creation time to every holder of
 * a reference.
 */
import type { AssetRef } from '@openmaic/dsl';

declare const assetIdBrand: unique symbol;

/**
 * A branded `AssetRef` denoting an id this package allocated.
 *
 * The brand is a *compile-time* discriminator only: it separates ids allocated
 * by this package from arbitrary strings. It does not distinguish media types;
 * typed DSL fields own that distinction. It carries no runtime representation:
 * an `AssetId` is a string and nothing more.
 */
export type AssetId = AssetRef & { readonly [assetIdBrand]: true };

/** The type prefix every allocated asset id carries. */
export const ASSET_ID_PREFIX = 'ast_';

/** Bytes of randomness in an allocated id. */
const ASSET_ID_ENTROPY_BYTES = 16;

/**
 * Lowercase base32 (Crockford ordering, minus `i` / `l` / `o` / `u`) so an id
 * survives being read aloud, retyped out of a log, or lowercased by a
 * case-folding transport without becoming a different id.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

let assetIdFactoryForTesting: (() => AssetId) | null = null;

/**
 * Override asset-id allocation for test instrumentation only.
 * Production code must never call this function. The package exports map
 * already blocks consumers from deep-importing this internal module.
 */
export function __setAssetIdFactoryForTesting(factory: (() => AssetId) | null): void {
  assetIdFactoryForTesting = factory;
}

function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
  }
  // Left-align the trailing bits into a final symbol rather than dropping them,
  // so all 128 bits of entropy reach the encoded id.
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** Allocate a fresh, unguessable asset id. */
export function newAssetId(): AssetId {
  if (assetIdFactoryForTesting !== null) return assetIdFactoryForTesting();
  const getRandomValues = globalThis.crypto?.getRandomValues;
  if (!getRandomValues) {
    throw new Error(
      'Web Crypto crypto.getRandomValues is unavailable; asset id allocation requires a secure context (HTTPS or localhost).',
    );
  }
  const bytes = new Uint8Array(ASSET_ID_ENTROPY_BYTES);
  getRandomValues.call(globalThis.crypto, bytes);
  return `${ASSET_ID_PREFIX}${encodeBase32(bytes)}` as AssetId;
}

/**
 * Brand a string read back out of a document as an {@link AssetId}.
 *
 * **This validates nothing, by design.** The asset id domain is opaque and
 * unconstrained, exactly like the KV key domain it inherits its lesson from
 * (see `docs/kv-http-contract.md`, "A key is a truly opaque, unconstrained
 * string"): the moment ids acquire a length bound or a character set, some
 * deployment's transport or presentation rules have leaked into the identity
 * domain, and a previously resolvable id becomes unreadable. So there is no
 * `isAssetId`, no `assertAssetId`, and no validator to regress.
 *
 * An id that this package never allocated is therefore not an error — it is a
 * lookup that misses. `resolve` returns `null` for it and `remove` is a no-op,
 * which is the same answer a valid-but-deleted id gets, and deliberately so.
 * On a server, untrusted input passed through `toAssetId` is still owed
 * authorization through a registry ownership check, not validation.
 */
export function toAssetId(value: string): AssetId {
  return value as AssetId;
}
