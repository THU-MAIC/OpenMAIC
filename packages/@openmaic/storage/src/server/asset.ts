/**
 * Options a server handler for the asset registry HTTP contract takes.
 *
 * Types only for now; the handler itself is a later unit. These live here
 * rather than beside {@link AssetStore} because they name `IncomingMessage`,
 * which the browser-reachable `../asset/` modules cannot import — the same
 * split the document and runtime layers already make.
 *
 * `docs/asset-http-contract.md` is normative for everything below.
 */
import type { IncomingMessage } from 'node:http';

import type { AssetPrincipal } from '../asset/types.js';

/**
 * Derives the principal for a request from its authenticated session.
 *
 * `undefined` is `401 UNAUTHENTICATED`. A principal this hook returns in a
 * malformed shape is `500 INTERNAL_ERROR`, not `400`: it is the deployment's
 * bug rather than the caller's.
 *
 * This is the **only** place a request header may contribute to identity. The
 * contract assigns no meaning to any other header and a handler MUST NOT derive
 * a principal, an owner, or a content hash from one. A deployment that
 * authenticates from front-door headers owns the matching obligation the
 * handler cannot enforce: that proxy must strip and reset those headers on
 * every inbound request so a client cannot supply its own.
 */
export type AssetHttpAuthenticate = (req: IncomingMessage) => Promise<AssetPrincipal | undefined>;

/** An additional deployment policy layer, evaluated before any entry is read. */
export type AssetHttpAuthorize = (
  principal: AssetPrincipal,
  req: IncomingMessage,
) => boolean | Promise<boolean>;

/** Options a server handler for this contract takes. */
export interface AssetHttpHandlerOptions {
  authenticate: AssetHttpAuthenticate;
  /**
   * Defaults to allowing any authenticated principal, matching document
   * authorization rather than the deny-by-default of the administrative hooks.
   * The enforcing boundary is the principal on every registry entry, checked on
   * every route; this hook is an extra policy layer.
   *
   * It receives the request, never the entry: a policy decision that could vary
   * with the entry would defeat the requirement that a foreign id and an unknown
   * id be indistinguishable. A denial is `403` uniformly, on `DELETE` as
   * elsewhere — answering `204` to a caller forbidden to delete would have them
   * clear their reference and orphan the entry.
   */
  authorizeAssets?: AssetHttpAuthorize;
  /**
   * Media types served inline. Anything outside this list — including a
   * non-string or empty recorded type — is relabelled `application/octet-stream`
   * and served as an attachment. It is still served; relabelling is not refusal.
   *
   * Defaults to `DEFAULT_RENDERABLE_TYPES`. A handler MUST reject a list
   * containing any member of `EXCLUDED_RENDERABLE_TYPES` at construction: those
   * execute script in a browsing context, and a rule enforced only by prose on
   * the one setting that turns stored bytes into stored script is not enforced.
   */
  renderableTypes?: readonly string[];
  /**
   * The whole request, in raw octets off the wire, before parsing. Defaults to
   * 33 MiB.
   *
   * Measured differently from the two part limits on purpose: it exists to stop
   * reading, so it cannot wait for a decode. A handler MUST assert at
   * construction that this exceeds `maxAssetBytes + maxMetaBytes` with room for
   * multipart framing — set equal to `maxAssetBytes`, it would silently reject
   * every asset at the inner limit while reporting the outer one.
   */
  maxRequestBytes?: number;
  /**
   * The decoded `bytes` part. Defaults to 32 MiB.
   *
   * Never inferred from `Content-Length`, which is a claim by the sender, and
   * never satisfied by counting bytes read alone: a `Content-Encoding` expands
   * after the count, inside the transaction that holds the write, which is why
   * the contract requires rejecting one outright.
   *
   * Asset routes are governed by this and {@link maxMetaBytes} rather than by
   * the `maxBodyBytes` that bounds the JSON routes of the other layers.
   */
  maxAssetBytes?: number;
  /**
   * The decoded `meta` part. Defaults to 64 KiB.
   *
   * Separate from {@link maxAssetBytes} because the two measure different
   * things — a parsing budget and a storage budget. One shared limit either
   * caps assets at metadata scale or admits metadata at asset scale. Enforced
   * before the JSON is parsed, which is why the contract fixes `meta` ahead of
   * `bytes` in the part order.
   */
  maxMetaBytes?: number;
  /**
   * Number of multipart parts accepted. Defaults to 8.
   *
   * A byte ceiling alone does not bound this usefully: a request within every
   * size limit can still carry a very large number of tiny parts.
   */
  maxParts?: number;
  /** One part's header block, in raw octets. Defaults to 8 KiB. */
  maxPartHeaderBytes?: number;
}
