# Asset registry HTTP contract

This contract exposes the asset operations — `put` / `identify` / `resolve` / `remove` / `replace` — over HTTP. All paths below are relative to a deployment-defined base URL. Path segments are percent-encoded UTF-8 strings. Metadata travels as JSON; asset bytes travel as bytes, as a multipart part on writes and as the whole body on reads. Successful operations with no return value respond with `204 No Content`.

The server backend for this contract ships as `createAssetHttpHandler`, with asset requests dispatched by `createStorageHttpHandler`. The conformance server this package provides remains test-only: it implements no authentication or authorization model beyond what the contract's response codes require, because deriving the principal from an authenticated session is the reference server's job.

The design this contract serves has three layers — an allocated asset id names a registry entry, and a registry entry names a content hash, and a content hash names bytes. **Only the first layer is on the wire.** The content hash is an internal deduplication key: it MUST NOT appear in any URL, response header, response body, error message, error details, or log line.

That prohibition is not satisfied by omitting the hash itself. Bytes are shared across principals and their storage row has no owner, so **no response header, body value, or status may be derived from the blob row except the representation's byte length.** Every other value on a byte response comes from the registry entry — its media type, its revision, its own creation time. The byte length is allowed because it is an inherent property of the representation and is the same value a `GET` obtains from the returned bytes; retaining it in the registry lets `HEAD` reproduce `Content-Length` without fetching those bytes. `Last-Modified` is the trap worth naming: sourced from the shared row's creation time, as a static-file idiom naturally would, it reports a timestamp earlier than the caller's own write and thereby proves another principal stored those bytes first. Byte responses MUST NOT carry `Last-Modified`, `Age`, or any other value read from the shared row; note that the `no-store` requirement below already makes `Last-Modified` pointless. Frameworks that generate `ETag` and `Last-Modified` by default MUST have both disabled on these routes.

The hash MUST be a collision-resistant digest of at least SHA-256 strength, untruncated. This is a security requirement rather than an implementation preference, and it is the unstated precondition of two rules below: a server writes bytes unconditionally, so under a colliding digest one principal's write silently substitutes the bytes every other principal's entries resolve to — and an object-storage byte layer names each object by that digest, so a collision there is a cross-principal overwrite at the storage layer as well.

## An asset id is opaque and unconstrained

An asset id is a string this package allocated, but nothing in this contract may depend on its shape. Ids are compared, never parsed. There is no id validator that can *reject* an id on either side, and a server MUST NOT refuse one for its content. (The client does inspect an id for the three transport classes below, but only ever to answer "miss" locally — never to reject.)

The consequence is the one that matters: **an id this registry never allocated is a miss, not an error.** An id from another id space, an empty string, a string containing NUL, four kilobytes of padding, `../../etc/passwd` — each is an ordinary lookup that finds nothing. This is not leniency. An id whose *shape* could be rejected would answer a question the caller is not entitled to ask, and a caller who can distinguish "malformed" from "not yours" has learned something about the id space. The browser backend documents this rule for the same reason, and the shared conformance suite pins each case.

A server therefore stores and looks up the decoded id as an opaque value — a bound query parameter, or a derived constrained storage id — **never as a path component, a filename, or an unescaped fragment of a query**. An id like `a/../../b`, arriving percent-encoded as `a%2F..%2F..%2Fb`, is one opaque lookup that traverses nothing.

### Ids that cannot be a path segment

Validity is a property of the id; reachability is a property of the transport. An id sits **mid-path** here, before the trailing `content` segment, and three classes of id cannot be carried there:

1. **An unpaired UTF-16 surrogate** has no percent-encoding; `encodeURIComponent` throws.
2. **A whole-id `.` or `..`** is normalized away by URL path parsing before the request is sent, so `/assets/../content` would address `/content`.
3. **The empty id** collapses `/assets//content`, which intermediaries that merge slashes rewrite to `/assets/content`.

The third has no counterpart in the [KVStore HTTP contract](./kv-http-contract.md), whose key is a trailing segment and round-trips when empty. The danger in all three is identical and it is not that the request fails — it is that the request **succeeds against something else**.

The client MUST therefore resolve these three locally, before building any request. **It does not raise an error: it answers as a miss** — `resolve` returns `null`, `remove` succeeds as a no-op, and `replace` fails as it does for any id the registry does not hold, with a synthesized `ASSET_NOT_FOUND` since there is no response to reconstitute one from. This is where this contract deliberately diverges from KV, which refuses an unencodable key with a client-side `KEY_NOT_ENCODABLE`. Throwing would be wrong here: an unknown id is a miss by the rule above, the shared conformance suite pins the empty string as a miss on both `resolve` and `remove`, and a client that threw would both fail that suite and reintroduce the shape oracle the rule exists to prevent. The distinction to preserve is not loud-versus-quiet; it is that the id must never address something it does not name.

Note that ids which merely *look* structural need none of this. `../../etc/passwd` percent-encodes to `..%2F..%2Fetc%2Fpasswd`, one ordinary segment that reaches the server and misses there; it illustrates the id-domain rule, not the local-resolution one.

### Transport hazards a deployment owns

Beyond those three, the path carries an id through intermediaries that may refuse or rewrite it, and the shared suite pins ids in each category. A conforming deployment MUST pass the id segment through unmodified, and MUST verify that it does:

- **A percent-encoded NUL** (`%00`) is rejected outright by some servers and filters.
- **A percent-encoded slash** (`%2F`) is rejected or normalized by servers that do not allow encoded slashes by default — which the `bucket/path/to/object.png` shape produces.
- **A very long id** may exceed a request-target ceiling and be refused with `431` before routing. No length is invalid; a long id is simply not reachable past that bound.

Each of these turns a pinned miss into a thrown error, and none is predictable client-side, so none may be papered over by mapping an unclassifiable `4xx` to a miss — that would break the rule that only a specific code becomes a miss. They are deployment configuration, and the shared suite's cases stand as the acceptance test for it. Real ids, being allocated by this package, encounter none of them.

## Endpoints

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| `POST` | `/assets` | Allocate a new id and store the submitted bytes under it. | `201` with `{ "id": "ast_…" }` and `X-Asset-Revision` |
| `GET` | `/assets/{id}/content` | Read the bytes stored under an id. | `200` with the bytes |
| `HEAD` | `/assets/{id}/content` | Read identity headers without reading the byte layer. | `200`, no body |
| `PUT` | `/assets/{id}/content` | Replace the bytes stored under an existing id. | `204` with `X-Asset-Revision` |
| `DELETE` | `/assets/{id}` | Remove the registry entry. | `204` for any id the policy admits |

The route table admits exactly one segment after `assets`, and it is the id. There is no principal segment and no digest segment to supply, so any other path shape is `404 ROUTE_NOT_FOUND` — a routing outcome that requires inspecting nothing. A path that *does* match a table entry but with a method that entry does not list is `405 METHOD_NOT_ALLOWED`, carrying an `Allow` header naming that route's methods; since route matching never consults the registry, neither outcome discloses anything about an id.

**No route takes a query parameter.** A server MUST reject any request whose target contains `?` at all with `400 VALIDATION_FAILED` — stated on the raw target rather than on a parsed query, so that a bare trailing `?` cannot be read as absent by one implementation and present by another. That is total where an enumeration of forbidden parameter names would not be, and it costs nothing, because there is no parameter here to preserve.

There is deliberately **no metadata read route**. No backend offers one: the browser store's public surface is `put` / `resolve` / `invalidate` / `release` / `replace` / `remove` / `close`, and no metadata member is ever returned to a caller. (`contentType` is read back, but only by the store itself, to label the bytes it hands out.) A route no backend can satisfy is not a contract but a promise. Warm-cache revalidation is what `HEAD` is for.

`HEAD` performs an ownership-checked registry identity read and MUST NOT read or materialize the asset bytes. Its status and headers are identical to `GET` for the same registry state; only the response body is absent. The registry's recorded byte length supplies `Content-Length`, so reproducing the `GET` headers does not require a byte-layer read.

Read routes MUST be served with `Cache-Control: private, no-store` and `Vary: Cookie, Authorization`, and MUST NOT be cached by any intermediary; the client sends its reads with `cache: 'no-store'` for the same reason, since a UA cache serving a stale `200` would defeat revision revalidation invisibly. Note that this differs from a content-addressed design, where bytes named by their digest never change and are safe to cache forever: here `replace` mutates the bytes behind a **stable** id, so no HTTP cache may serve a response for an id without revalidating. The client's own snapshot cache is a different thing and is governed below.

Byte responses MUST NOT advertise `Accept-Ranges` and MUST ignore a `Range` header, always answering `200` with the complete representation. A `206` would carry a response model this contract does not define, on a route whose headers are load-bearing for revalidation.

## Transport: bytes and metadata

`POST /assets` and `PUT /assets/{id}/content` take `multipart/form-data`, with the parts in this order:

- **`meta`** — `application/json`, the metadata object. Required on `POST`. **Optional on `PUT`**, where its absence is meaningful; see below.
- **`bytes`** — the asset bytes, carrying the asset's own `Content-Type`. The package client uses `application/octet-stream` when the source blob has no type, because multipart parsers otherwise supply their own default media type.

The multipart framing MUST be parsed by a standards-conforming multipart parser; a deployment MUST NOT hand-roll one. A bespoke grammar disagrees with the parsers intermediaries use, and every such disagreement is a way for a scanner and the application to see different parts.

Both parts MUST carry a `filename`. Without one, a conforming parser returns the part as a string, discards its headers, and text-decodes its payload, silently replacing invalid UTF-8. Each filename is fixed by the package client, never read by this package, and never derived from caller data. Preserving `meta` as a file allows the server to require its `Content-Type` to be `application/json` and to decode its bytes as UTF-8 with errors reported rather than replacement characters inserted.

Multipart rather than metadata alongside a raw body, because there is nowhere safe to put the metadata. It is an open-ended object, and real callers fill it with generated-narration text and image-generation prompts — **unbounded caller-supplied content**. In a query parameter that content would sit in the request target, where it hits the request-target ceiling and is written verbatim into every intermediary's access log. A custom header has the same size problem for the same reason. Multipart is a standards-defined framing rather than a bespoke one, which is the property that matters; `maxMetaBytes` must be enforced against the parsed metadata part before the JSON is parsed rather than after.

From this, one rule the other layers have no need for:

> **Metadata is unbounded caller-supplied content. It MUST NOT appear in any URL, response header, response body, log line, error message, or error details.** The single exception is `contentType`, which determines a byte response's `Content-Type` as specified below. In particular a `Content-Disposition` filename MUST NOT be derived from metadata: it would put caller content in a header, and an unescaped one is a header-injection primitive. Use a fixed name or the id.

The client's request-header hook MUST NOT set `Content-Type`, and a client whose hook does MUST fail loud rather than choose a winner. Under multipart this is more serious than mislabelling: overwriting `Content-Type` destroys the boundary parameter, and every write from that deployment fails to parse with an error naming nothing an operator can act on.

### Sizes

Three byte limits and one part-count limit, because they bound different things:

| Limit | Default | Bounds | Measured on |
| --- | --- | --- | --- |
| `maxRequestBytes` | 33 MiB | The whole request | Raw octets off the wire, before parsing |
| `maxAssetBytes` | 32 MiB | The `bytes` part | Decoded part content |
| `maxMetaBytes` | 64 KiB | The `meta` part | Decoded part content |
| `maxParts` | 8 | Number of multipart parts | Parsed frames |

Only `maxRequestBytes` is enforced before multipart parsing. It bounds the raw body read from the wire and is therefore the only ceiling on parser work and request-derived memory. The platform's `Response.formData()` then materializes every part before `maxParts`, `maxMetaBytes`, and `maxAssetBytes` are checked on the parsed result; those three limits bound what the handler accepts, not what the multipart parser processes.

This trade is deliberate. A streaming multipart parser with its own limits would introduce a second grammar that could disagree with the standards-conforming platform parser, recreating the scanner/application parser differential this delegation exists to remove. Bounded memory is preserved by `maxRequestBytes`; `maxParts`, `maxMetaBytes`, and `maxAssetBytes` remain finer-grained admission rules for the parsed request. Separate asset and metadata limits are still necessary because one shared admission limit either caps assets at metadata scale or admits metadata at asset scale. Per-part header bounding belongs to the standards-conforming parser rather than to this contract.

The outer bound is measured differently from the inner two, and deliberately so: it exists to stop reading, so it cannot wait for a decode. A handler MUST assert at construction that `maxRequestBytes` exceeds `maxAssetBytes + maxMetaBytes` with room for multipart framing, or the outer bound silently masks the inner one — with the defaults above equal, an asset at exactly `maxAssetBytes` would always be rejected by the request bound, reporting the wrong limit.

None may be inferred from `Content-Length`, which is a claim by the sender. Counting bytes as they are read is necessary but not sufficient for the decoded limits — under a `Content-Encoding` the bytes read are a fraction of the bytes stored, and the expansion lands inside the transaction that holds the write. A server therefore MUST reject `Content-Encoding` on these requests with `400 VALIDATION_FAILED`. Exceeding any size limit is `413 PAYLOAD_TOO_LARGE`, raised **before any bytes are stored**.

### Malformed and hostile bodies

A request whose `Content-Type` is not `multipart/form-data` is `415 UNSUPPORTED_MEDIA_TYPE`. A failure by the multipart parser, including invalid boundary framing, is `400 VALIDATION_FAILED` with a fixed package message. The expected entries are exactly `meta` and `bytes` on `POST`, and `bytes` with optional `meta` on `PUT`; any other entry name or any duplicate is `400 VALIDATION_FAILED`. Duplicate entries in particular MUST be rejected rather than resolved by a first-wins or last-wins rule: a scanning intermediary and the application choosing differently is a parser differential, and the two would disagree about which metadata a request carried.

When both entries are present, `meta` MUST precede `bytes`.

### Recording the media type

On `POST`, the recorded media type is `meta.contentType` when that member is **present** — including when it is the empty string — and the `bytes` part's own `Content-Type` only when it is absent. The distinction is `??` rather than `||`, and it is observable: an explicitly empty `contentType` records the empty string and is therefore served as an attachment, where a fallback would have served the blob's type inline.

On `PUT`, when `meta` is present it replaces the entry's metadata wholesale and the media type is derived the same way. When `meta` is **absent**, the entry's existing metadata is retained and its media type is retained unless the `bytes` part carries one.

The package client always carries a media type on `bytes`: an untyped source blob is sent as `application/octet-stream`. This is necessary because a standards-conforming parser supplies a default media type for a file part whose header omits one, so omission cannot survive parsing as an empty type and cannot signal retention. Metadata omission still retains the existing metadata object; only the media type follows the replacement bytes.

The two branches are metadata present versus metadata absent, matching the browser backend's metadata replacement and retention behavior. The absent branch is the one that matters: regenerating bytes in place while keeping the recorded provenance is the use case `replace` exists for. A wire on which `meta` were mandatory would force a client to send `{}`, erasing the accumulated prompt, model, narration, and voice on every regeneration — through a call that returns `204`.

Media-type retention is a deliberate divergence. The browser backend can retain the existing media type when metadata is absent and the replacement blob is untyped. The HTTP path cannot reproduce that behavior because a conforming multipart parser supplies a default type for a file part whose header omits one. The package client therefore sends `application/octet-stream` for an untyped replacement, and that type replaces the recorded media type even while the existing metadata object is retained.

### Serving bytes

Every response carrying bytes MUST send `X-Content-Type-Options: nosniff` and MUST serve a `Content-Type` from a renderable allowlist. The default allowlist is:

```
image/png  image/jpeg  image/gif  image/webp  image/avif
audio/mpeg  audio/mp4  audio/ogg  audio/wav  audio/webm
video/mp4  video/webm  video/ogg
```

Matching is exact, case-insensitive, and whole-string, with no parameters accepted. A deployment may narrow this list; widening it is a decision about executable content. **Excluded, and MUST remain excluded:** `image/svg+xml` and `image/svg`, `text/html`, `application/xhtml+xml`, `text/xml` and `application/xml`, and `application/pdf`. These are document formats that execute script, not media, and serving one same-origin turns stored bytes into stored script.

A recorded media type that is not a string, is empty, or is outside the allowlist is served as `application/octet-stream` with `Content-Disposition: attachment`. The empty case is real when metadata explicitly carries an empty `contentType`. The client MUST label its minted object URL from the **served** `Content-Type` and from nothing else; labelling it from metadata would reintroduce inside a `blob:` URL exactly what the allowlist excludes.

**Relabelling is not refusal.** `resolve` returns a minted URL for every stored asset regardless of media type; a non-renderable asset yields a URL labelled `application/octet-stream` that a media element will not render, and that is the intended outcome rather than a miss. Returning `null` instead would fail the shared conformance suite, every blob in which is `text/plain` — outside any sensible allowlist — and would conflate "these bytes are not safe to render inline" with "there are no bytes." The disposition header governs direct navigation and does no work on this path, where bytes reach the caller through `fetch`; the protection that carries the weight is the relabelling together with `nosniff`.

The three-layer design improves on a content-addressed one here, and it is worth stating why. Where bytes are shared across principals and the recorded media type travels with the bytes, one principal's metadata can determine how another principal's response is labelled — a stored cross-principal typing attack. Here the media type lives on the **registry entry**, and every entry belongs to exactly one principal, so a principal can only mislabel their own bytes. The attack is unrepresentable rather than mitigated, given the collision-resistant digest required above and the rule that no response value derives from the shared row.

### `X-Asset-Revision`

`GET` and `HEAD` on `/assets/{id}/content`, and the success responses of `POST /assets` and `PUT /assets/{id}/content`, MUST carry an `X-Asset-Revision` header: a monotonically increasing integer on the registry entry, starting at 1 and incremented by each `replace`. It is opaque to the client except for equality comparison.

It MUST NOT be derived from the content in any way. A content-derived validator — the reflex choice, and what an `ETag` from a static file server or object store would be — is the content hash under a different header name, and would disclose byte equality across ids to anyone holding two of them. Byte responses MUST NOT carry a content-derived `ETag` for the same reason.

Carrying it on the write responses too means a client learns the revision it produced without a second request, which would otherwise race a concurrent `replace`.

The headers and the body of a `GET` byte response MUST be produced from **one transactionally coordinated read**. Reading the revision and media type, releasing the transaction, and then reading the bytes lets a concurrent `replace` pair revision *n* headers with revision *n+1* bytes, which the client then caches as authoritative. The browser backend closes the same window deliberately, reading the registry entry in the same transaction as the bytes. `HEAD` reads only the registry identity and recorded byte length in one ownership-checked query.

## Resolution yields a client-minted object URL

`resolve` returns a URL the caller can use as an `<img>` / `<audio>` / `<video>` source. Over this contract, the client fetches the bytes through its own authenticated request and mints a local object URL from them. **The server exposes bytes; it does not hand out a URL for a media element to load.**

This supersedes the earlier resolution that a server-backed deployment would resolve to a self-hosted proxy path by default. That shape does not survive contact with how a resolved URL is consumed. A media element sends only ambient credentials — it cannot carry a client's request-header hook — so a proxy path works for deployments whose sessions are cookie-based and **silently fails** for header-authenticated ones. Closing that gap requires the deployment to mint and verify short-lived URL tokens, which is a second credential form invented inside a storage library and offered as the default.

Fetching the bytes through the client's ordinary authenticated request path needs no second credential form. It also preserves the browser backend's semantics, which is what lets consumers written against that backend keep working — but only if the client observes the rules below, which are the substance of that claim rather than a consequence of it. And it removes a class of disclosure surface: the client never receives a URL into which a hash could be embedded, so content-derived validators, cache keys, and URL shapes stop being questions this contract has to get right.

The cost, stated plainly: there are no range requests and no progressive playback. The bytes are downloaded in full before a media element sees them, and a resolved asset is held in memory until released — on the server side too, since a byte read materializes the asset rather than streaming it. This is what the browser backend already does, so it is not a regression for any existing consumer, but it is a real ceiling on large media. Self-hosted proxy paths and signed object-storage URLs remain possible later shapes; they are additive, and adding one when a deployment needs it beats defaulting to a shape that works for only half of them. Signed object-storage URLs have since landed as exactly such an additive, opt-in shape; see *Indirect byte egress* below.

### Client resolution semantics

These are normative. Two of them the shared conformance suite already pins; the rest it cannot, and saying which is which matters, because an implementer will otherwise trust a green suite to have checked them.

Pinned by the shared suite:

- **Concurrent `resolve` calls for one id coalesce** onto a single request and a single minted URL. Minting twice orphans one of them — nothing can revoke it — and pins the asset in memory twice.
- **A `remove` invalidates the warm snapshot**, and a `resolve` that misses retires it.

Normative but **not** pinned by the shared suite, and therefore the HTTP backend's own tests must pin them when it lands:

- **A returned URL is an immutable snapshot.** A later mutation retires it rather than revoking it; already-issued URLs stay valid. Only `release(id)` and `close()` revoke. (The suite has no `release` coverage; the browser backend's own tests carry it.)
- **`invalidate(id)` is a local cache operation, distinct from `release(id)`.** It advances the id's resolution generation, prevents an older in-flight request from satisfying later callers, forgets the warm identity, and retires the current snapshot without revoking URLs already issued to holders. A replacement notification from another realm must invalidate before it resolves again.
- **The object-URL cache is keyed per asset id, never per content.** A client that keys it on a digest of the response bytes discloses byte equality to a holder of two ids — the disclosure the whole design exists to prevent, reintroduced client-side. The suite asserts identical bytes yield distinct *ids*, never that they yield distinct *URLs*.
- **A `replace` invalidates the warm snapshot and any in-flight resolution for that id.** (A `put` allocates a fresh id, which by construction has no cache entry to invalidate.)
- **The warm-hit identity is the revision together with the served media type** — the HTTP analogue of the browser backend's content-hash-and-media-type pair. The suite is transport-agnostic and has no vocabulary for revisions.
- **A client records the revision carried by the response that delivered the bytes, never one learned from a `HEAD`.** A `HEAD` decides only whether to re-fetch. Recording the `HEAD`'s revision against bytes fetched afterwards labels revision *n+1* bytes as revision *n*, and every later `HEAD` then confirms them as fresh.

One limit of this design is worth stating rather than leaving to be discovered: a `replace` performed elsewhere — another tab, another device — leaves a warm snapshot stale until the next revalidation, where the browser backend re-reads the registry inside every `resolve`. That is inherent to a network backend, and it is the one place these rules do not reproduce the browser's semantics.

### Cross-origin deployments

The client reads non-safelisted response headers on both reads and writes. A cross-origin server MUST send `Access-Control-Expose-Headers: X-Asset-Revision, X-Error-Code` on `GET` and `HEAD`, error responses included, and MUST expose `X-Asset-Revision` on the `201` success response from `POST` and the `204` success response from `PUT`. Without the read revision, the client's cache either never validates or validates as always-fresh. Without the error code, a client cannot classify any `HEAD` error and falls back to a full byte `GET` on every miss — so the mechanism `HEAD` exists to provide stops working, silently, in exactly the deployment shape this section addresses. Without the write revision, the client reports a committed allocation or replacement as a malformed response; retrying the non-idempotent `POST` then allocates a second entry for the same bytes.

A client accepts a `credentials` option and passes it through untouched. A credentialed cross-origin deployment answers with a concrete origin and `Access-Control-Allow-Credentials: true`, never `*`.

### Indirect byte egress (deployment opt-in)

Everything so far describes **direct** egress: a byte `GET` is answered `200` with the bytes materialized in the response body. A deployment MAY instead opt into **indirect** egress, under which a byte `GET` is answered with a short-lived signed URL for the object rather than the bytes — as a `302 Found` with a `Location` for a generic consumer, or as a JSON descriptor for a client that asks for one, as specified below — when, and only when, the byte layer can sign. This is the signed object-storage shape anticipated above, and it is additive in the precise sense that a deployment which never opts in cannot tell it exists: off by default, and byte-for-byte unchanged when off. Only the byte `GET` changes shape; `HEAD`, writes, and `remove` are always answered directly, so `X-Asset-Revision` revalidation through `HEAD` works exactly as under direct egress.

Indirect egress is a preference, not a guarantee. A byte layer that cannot sign — the byte column in the transactional store cannot — answers `200` with the bytes even when the deployment opted in, and a client MUST therefore handle both shapes on the same route.

The rules that make the redirect shape safe are these, and an implementation MUST honor every one:

- **Authorization is unchanged and still per-read.** The `302` is minted only after the same checks the direct read performs — the deployment policy hook and the per-principal ownership check, in the same coordinated read — and a miss is still `404 ASSET_NOT_FOUND`, indistinguishable from the direct path. The redirect changes who serves the bytes, never who may ask.
- **A miss stays a miss wherever it surfaces.** A registry miss is answered `404 ASSET_NOT_FOUND` as it always was. Indirect egress adds one miss that arrives later: an entry owned and readable when the URL was minted, whose bytes are reclaimed before the client fetches it, which the object store answers `404`. A conforming client MUST report that as `ASSET_NOT_FOUND` rather than as a malformed response — and only a `404` the store confirms as a miss: S3 and MinIO answer object errors with an XML body whose `<Code>` names the condition, so a client MUST treat exactly a declared `NoSuchKey` as the absent object and every other `404` (a wrong bucket, access point, or endpoint, under which the bytes still exist) as a malformed response. It is the same physical state the direct path reports as a miss, since the byte layer's own contract calls an absent object a miss and not an error, and what a read means must not depend on a deployment's egress setting. Signing MUST NOT probe for the object to close this window instead: the caller has already done the ownership-checked registry read, and an existence probe would both cost the round trip indirect egress exists to remove and make the mint's price vary with prior presence. This does put one requirement on the byte layer: an absent object MUST answer `404`. S3 answers `404 NoSuchKey` only when the signing identity holds `s3:ListBucket` on the bucket; without it a missing key answers `403`, which no client can tell from a real credential fault, and the miss degrades to a malformed response. Grant it.
- **The signed URL is short-lived.** Its signature is the credential, so possession of the URL serves the bytes to anyone for its whole lifetime: indirect egress converts a per-read authorized response into a bearer token with a fuse. The fuse is seconds, not minutes. It MUST also sit far below the byte reclamation grace period, so bytes referenced when the URL was minted cannot be collected while the URL is still usable. The packaged handler enforces that rather than documenting it: enabling indirect egress requires declaring the reclamation grace the deployment runs its collector with, and construction fails for any lifetime above a tenth of that grace, or above the handler's own fifteen-minute ceiling. The grace has no default here, deliberately. A default would be a guess about a component the handler does not own, and a guess is what turns this invariant into something a deployment can hold wrongly while every individual setting looks reasonable. The "an asset id is not a capability" rule survives precisely because the capability the redirect introduces expires.
- **The contract's response headers survive the redirect because they are pinned into the signature**, not because the client re-derives them: the served media type after the renderable allowlist, the fixed `attachment` disposition for a non-renderable type, and the `private, no-store` cache posture. Object stores support exactly this as signed response-header overrides (`response-content-type`, `response-content-disposition`, `response-cache-control`); a byte layer that cannot pin them has no signing capability, whatever else it can sign. One header does not survive, and the design accounts for it: `X-Content-Type-Options: nosniff` is not among the overridable response headers, so the object store's answer lacks it. That is safe precisely because of the consumption model — the packaged client fetches the bytes and mints a typed `blob:` URL, so no media element or navigation ever sniffs the signed response's type; the allowlist relabeling has already decided what the bytes claim to be. A consumer that navigates to a signed URL directly gets no nosniff protection, which is one more reason the descriptor path is the one conforming clients use.
- **The `302` itself carries `X-Asset-Revision`**, `Cache-Control: private, no-store`, and `Vary: Cookie, Authorization, Accept` — the read route's posture, since the redirect is as per-principal as the bytes it points at. A client whose `fetch` follows redirects opaquely observes only the final response's pinned headers, which is one reason the packaged client asks for the descriptor below rather than follow.
- **Cross-origin deployments own one more configuration.** The byte fetch now crosses to the object store's origin, so that origin's CORS must admit the application origin and expose `Content-Type`. A deployment that skips this fails loud on the first read rather than silently.

What a conforming client does about the hidden `302` headers. Following a redirect is not neutral for it: the platform fetch forwards the original request's headers to the object store's origin — only `Authorization` is stripped across origins — so a deployment whose credential travels in a custom header would hand that credential to the object store, and the cross-origin preflight the forwarded custom headers provoke commonly fails there besides. A client therefore asks for the descriptor instead, and it asks through `Accept: application/vnd.openmaic.asset-descriptor+json` — a CORS-safelisted header, so the negotiation never turns a byte `GET` into a preflighted request, which a custom request header would. A redirect-egress server answers `200` with a JSON body `{"url": ..., "revision": ...}` under that same vendor media type as `Content-Type`, with the read route's cache posture and never a `Location`; the media type is what identifies the shape, so a stored asset can never parse as a descriptor — and to keep that true the type is reserved: a server MUST reject it in its renderable allowlist, since only the allowlist can put a recorded media type on the wire. The client then fetches the signed URL itself, with no deployment headers at all, takes the revision from the descriptor and the served media type from the byte response, and is otherwise unchanged: warm reads still revalidate through `HEAD`, which is never answered indirectly. A server that never redirects ignores the `Accept` and answers bytes exactly as before, so one client build serves both deployment shapes. The `302` remains the answer for generic HTTP consumers that did not ask for the descriptor; what they do with their own headers is their own affair.

The disclosure tradeoff, stated plainly. This contract forbids the content hash on the wire because it discloses byte equality across ids. The byte layers that ship key each object by that hash, so a `Location` into such a layer names the content hash, and a holder of two ids can compare the URLs they were redirected to and learn whether the bytes match — the disclosure the three-layer design exists to prevent, reintroduced at the egress point. Enabling indirect egress with a hash-keyed byte layer is therefore a **deliberate deployment tradeoff**, acceptable where byte equality across ids is not sensitive: public generated media is the motivating case, where payloads are large, visibility is already unrestricted, and moving the download off the application server is worth real cost. A deployment that needs the no-disclosure property MUST keep direct egress. A byte layer that keyed objects per registry entry rather than per hash would restore the property under indirect egress; none ships today.

The same tradeoff has a second, sharper edge that deployments should opt into with open eyes. An object store's `GET` response carries headers the signature cannot remove — `ETag` and `Last-Modified` among them — and the signed response-header overrides add but never strip. `ETag` is content-derived, so it sits in the same disclosure class as the hash in the URL. `Last-Modified` does not: because a deduplicated `PUT` rewrites the hash-keyed object, the header moves when another principal re-uploads the same bytes, and a holder of a signed URL who re-fetches it can observe shared-object write timing — who else wrote these bytes, and when. That is more than byte equality, and no shipped signer can suppress it. A deployment for whom that signal is sensitive MUST keep direct egress; a byte layer that never rewrote an existing object (or keyed objects per entry) would not expose it, and none ships today.

## Allocation discloses nothing

Every successful `POST /assets` allocates a **new** id, including for bytes the registry already holds. Returning an existing id would let any caller test whether arbitrary bytes are already stored — an existence oracle over data the caller never stored, and the reason the three-layer design exists at all.

The requirement is stronger than the return value. Every branch taken and every value returned on the success path MUST be independent of whether the bytes were already present. A server MUST NOT read-then-write: it writes the blob unconditionally and inserts the registry entry, so both paths execute the same statements in the same order.

Three channels stay outside the guarantee, and a deployment MUST budget for them:

- **Quota and metering.** These MUST be accounted on the principal's **logical** bytes — the sum of the bytes referenced by that principal's registry entries — and never on bytes physically newly written. Under physical accounting a deduplicated write costs nothing while a fresh write costs quota, so two equally sized writes answer the oracle the rest of this design closes. The same applies to any storage estimate or billing readout. A deployment MUST also raise `ASSET_QUOTA_EXCEEDED` from the **logical** check before attempting a physical write, and MUST keep physical headroom above the sum of logical quotas — otherwise a write near capacity succeeds when the bytes deduplicate and fails when they are novel, and the filesystem answers the question the accounting rule closed.
- **Cost, on the write path only.** A deduplicated write does less physical work than a novel one, so `POST` and `PUT` latency and write volume vary with whether the bytes were already present. This contract does not promise constant-cost writes, and a deployment requiring that must provide it above this layer. Note that `remove` is *not* in this category: because reclamation is offline, it deletes one row and costs the same whether or not another principal holds the same bytes — a channel that a synchronous reclaimer would have left open. The reference-count value itself is unobservable in any response.
- **Anything a deployment adds.** A diagnostic, a storage estimate, or a rate-limit counter need not be *read from* the blob row to leak: it is enough that its value correlates with whether a write deduplicated. A deployment adding any such value to a response owes it the same analysis as the two channels above, over and beyond the blob-row rule, which closes only the values read directly from that row.

## Where the bytes live

The registry — ids, owners, media types, metadata, and the reference count — lives in a transactional store. The **bytes are a pluggable layer** behind it: a column in that same store, or a filesystem, or an object store addressed by content hash.

That is possible because of a decision made in the next section: **reclamation is offline**, never part of a request. Were a request allowed to delete bytes, a concurrent write deduplicating onto those same bytes could commit against them, and a byte layer outside the transaction would have no way to serialize the two — which is what would force bytes into the transactional store. Offline reclamation removes that race from every request path, and what remains is coordination on a row rather than on the bytes.

The invariant a byte layer must satisfy is therefore an **ordering** rule, not an atomicity one:

- The **blob row is claimed first**, in the transactional store, before the bytes are written. This is the step that serializes a write against the collector: claiming the row takes its lock, so a collector already holding it finishes first and the write then re-claims the row. Writing bytes before claiming would not be safe — the collector could delete them while the claim waited, leaving a fresh entry that points at nothing.
- Bytes are then written, **before** the entry that references them. A crash between the two leaves bytes nobody references, which costs storage and loses nothing; the reverse order would leave a registry entry pointing at bytes that were never stored.
- The write is **unconditional**. It must not be skipped because the bytes appear to be present already — partly because the interleaving above produces exactly that appearance, and partly because branching on prior presence is what the allocation rule forbids.
- Bytes are deleted **after** the last row referencing them, and only by the offline collector.
- The reference count and the decision to collect are serialized on that same **blob row**, which every byte layer keeps regardless of where the bytes themselves sit.

One consequence is worth stating rather than leaving to be discovered: byte-layer I/O happens while the registry transaction is open. The write path holds the blob row's write lock across the upload, and the read path holds a shared blob-row lock across the download so the collector cannot delete the object in flight. For a byte layer inside the registry store this costs nothing; for an object store it means a row lock and a database connection are held across network I/O, which is a consideration for how a deployment sizes `maxAssetBytes` and its connection pool. The read lock is shared, not exclusive, so concurrent reads of the same bytes do not serialize against one another.

Two implementations ship, and the interface exists because both are real rather than because one might be one day. A byte layer in the transactional store keeps bytes in a column: nothing to reconcile, since a rolled-back transaction leaves nothing behind, but its bytes flow through the write-ahead log and the backups, so backup and replication volume scales with stored assets — which is the reason to size `maxAssetBytes` deliberately, and eventually the reason to move off it. An object-storage byte layer keeps that volume out of the database at the cost of one housekeeping duty: the crash window above leaves unreferenced objects, so a deployment reconciles or expires them. Naming each object by its content hash keeps those orphans harmless — the next write of the same bytes overwrites one idempotently, so nothing has to hunt for them.

### Reclamation is offline

Bytes are shared across principals; a registry entry is not. `remove` deletes the registry entry and **nothing else**: it never reads, counts, or deletes bytes. Bytes outlive their last reference until a separate, offline collector takes them — one that finds byte rows with no references older than a grace period, locks each, re-checks, and deletes.

Three things follow, and each is a reason the design is this way rather than a consequence to tolerate:

1. **Request paths never delete bytes.** The write path claims the blob row before storing, and the read path holds a shared lock while reading bytes. The collector takes an exclusive lock before deletion, so it waits for in-flight reads and writes without serializing readers against one another.
2. **A side channel closes.** Were `remove` to reclaim, its cost would vary with whether another principal still held the same bytes, so a caller could learn that by deleting their own asset and timing it. A `remove` that only deletes one row costs the same either way.
3. **Nothing is given up, because the guarantee never existed.** With global deduplication, `remove` could never promise the bytes were destroyed — another principal referencing them keeps them. Synchronous deletion therefore bought far less than it appeared to.

The cost is real and belongs to the deployment: storage grows until the collector runs, and bytes a user deleted remain on disk until then. A deployment MUST configure the collector and its grace period; leaving both unset is a design that grows without bound. The retention posture that follows is the one deduplication already implied, now with a stated delay rather than an implied one.

The reference count spans all principals — that is what makes global deduplication reclaimable — and its value MUST NOT be observable in any response.

Collection is a host decision, not a contract event. A registry entry whose bytes are gone resolves to a miss rather than an error, because inventing an error would make collection observable.

Reference counting has a second level in the wider design, from documents to asset ids. That level depends on manifest work that has not shipped, and a server implementing this contract implements the id-to-bytes level only.

## Metadata domain

Metadata is a JSON object whose one contract-relevant member is `contentType`; every other member is caller-defined and stored verbatim.

Because it travels through JSON, this backend accepts only plain JSON values that survive serialization without changing meaning. It MUST fail loud, before sending, on values such as `Map`, `Set`, `Date`, non-finite numbers, negative zero, nested `undefined`, `bigint`, sparse arrays, symbol-keyed properties, non-enumerable properties, strings containing U+0000, class instances, and circular references. U+2028 and U+2029 are valid JSON string contents and MUST be accepted.

**This is a real capability reduction, not a tightening of a lossy path**, and a deployment moving from the browser backend to a server one must audit its metadata against it. The browser backend persists a structured clone, which carries `Date`, `Map`, `Set`, `ArrayBuffer`, `bigint`, `-0`, and cycles **faithfully**, and throws only for what it genuinely cannot represent. So these values do not degrade quietly today; over this transport a `put` that works locally starts failing. (Structured clone does drop symbol-keyed and non-enumerable properties, so those two are lossy on both sides.) U+0000 deserves its own mention in the other direction: it is legal in the browser and rejected by common server text and JSON column types, so without this rule it becomes a `500`.

The list above binds the **client**, before sending, and every JSON-backed store, before writing. In particular, callers may use `PgAssetStore` directly without crossing the HTTP boundary, so its `put` and metadata-replacing `replace` branches MUST enforce the same lossless domain before any registry or byte write. The decision MUST be made by **inspecting the value, never by trial-serializing it**: a `JSON.stringify` pre-flight runs caller code — `toJSON`, getters — before validation has looked at anything, and a stateful accessor can show the probe one value and the serializer another. A native `TypeError` from serialization MUST NOT escape; it is replaced by a typed error, as a native `SyntaxError` is on the read path. That is not only about error typing: V8's circular-structure message enumerates property names from the object it failed on, which would put caller-supplied metadata into an error message in direct violation of the egress rule above. A validation error names the offending path and MUST NOT include the offending value; that error-egress rule binds direct store calls exactly as it binds HTTP calls.

A server receives the output of a JSON parse, so most of that list cannot reach it — non-finite numbers are a syntax error and the rest are unrepresentable in JSON text. Its obligation is correspondingly short, and is what the `400` row of the error table refers to: reject a `meta` part that is not a JSON object, and reject `-0` and U+0000 inside any string. Those are the only members of the domain that survive parsing.

Nothing reads metadata back to a caller. It is persisted so that provenance recorded at generation time — what produced these bytes, from what prompt or narration, with what voice — survives alongside the asset for later manifest and export work. A deployment should know what it is holding: metadata accumulates caller-supplied text that no code path currently returns, and it is subject to whatever retention and privacy posture that text requires.

## Principal derivation and authorization

The principal is derived server-side from the authenticated session and **never appears in a path, query parameter, or body**. This is the same non-negotiable that governs the other layers: a client-submitted principal is not proof of identity, and trusting one turns every route here into a lateral-authorization vulnerability. Every route requires authentication; there is no anonymous surface. A deployment's `authenticate` hook returning a principal in a malformed shape is `500 INTERNAL_ERROR` rather than `400`, because that is the deployment's bug and not the caller's.

A principal carries a **required, opaque identity key**, and that key is what every registry entry is partitioned on. This differs from the document layer, whose principal is all-optional because documents are author assets with no per-row ownership model; assets are partitioned, so the field the partition is keyed on cannot be optional. A principal that does not carry one has no asset capability at all and receives `403 FORBIDDEN_ASSETS` on every route — never a shared partition. The distinction matters because an absent key is not a value: entries stored against one would collide into a single partition that every such principal could read, replace, and delete, which is a lateral-authorization hole produced by the type rather than by a bug.

Two of the three channels a principal or a hash could arrive through are closed structurally rather than by inspection: the route table admits no segment that could carry either, and no route takes a query string.

The third channel, headers, is closed by **deriving no identity from it**, and this contract deliberately does not attempt to police header names. A server MUST NOT take a principal, an owner, or a content hash from any request header except through the deployment's `authenticate` hook; no other header carries identity here, and one the implementation never consults for identity smuggles nothing. The rule is about what the implementation trusts, not a filter on traffic.

This is narrower than "reads no other header", and deliberately so: the transport headers below are read and acted on — `Content-Type` for the multipart boundary, `Content-Length` as an untrusted hint, and `Content-Encoding` rejected outright because it would defeat the decoded-size limits. Reading a header to decide how to frame or refuse a request is not the same as trusting one to say who is asking.

Rejecting suspicious header names instead would be worse than useless, and it is worth recording why so it is not reintroduced. A name-shaped denylist cannot distinguish a header that asserts identity from one whose name merely contains an identity word: `User-Agent` is caught by any pattern broad enough to catch `X-Remote-User`, and a server enforcing such a pattern answers `400` to every browser, SDK, and command-line client. More decisively, `X-Forwarded-User`, `X-Remote-User`, `On-Behalf-Of`, and their kin are exactly what an authenticating reverse proxy — `auth_request`, an OAuth2 proxy, an identity-aware gateway — injects for `authenticate` to read. A contract that rejects them forbids the deployment shape it most needs to support, and one that exempts them has rebuilt the enumeration it replaced.

A deployment that authenticates from front-door headers owns one obligation this contract states but cannot enforce: that front door MUST strip and reset those headers on every inbound request, so a client cannot supply its own. That is a property of the proxy, not of this handler.

Bodyless methods (`GET`, `HEAD`, `DELETE`) MUST reject **any** request body outright: a server that routes them without reading the body would let a prohibited field arrive unexamined. In the `meta` part of a write, a `principal` or `contentHash` member is rejected.

`authorizeAssets` is evaluated on the principal, the method, and the route **before the entry is read**, and MUST NOT receive the entry — otherwise a policy decision becomes entry-dependent and defeats the ordering rule below. It defaults to **allowing** any authenticated principal, matching document authorization rather than the deny-by-default of the administrative hooks. That default is not an absence of protection: the enforcing boundary is the principal recorded on every registry entry, checked on every route including every byte read. The hook is an additional policy layer for deployments that want one; the administrative hooks default to denial because they are privilege-escalation surfaces with no such per-row boundary behind them. A denial is `403` uniformly, on `DELETE` as on every other route — answering `204` to a caller whose policy forbids deletion would have them clear their reference and orphan the entry permanently.

### Indistinguishability

An id belonging to another principal and an id that was never allocated MUST produce **byte-identical** responses — same status, same code, same message, same details, and the same headers — on every route in the table. Headers are named explicitly because this contract puts an outcome-varying value in one: a later diagnostic or `Retry-After` could break indistinguishability exactly as an added `details` member would. `DELETE` answers `204` for both, and for an already-deleted id. Ownership MUST be checked **before** any classification that could vary the response, including anything derived from the entry's revision or media type; otherwise the classification itself becomes the oracle. `ASSET_NOT_FOUND` responses carry a fixed message and **no** `details`, so that a diagnostic added later cannot break this.

An asset id is an identifier, not a capability. Authorizing once and treating the id as a bearer token afterwards is forbidden: **every** byte read re-checks ownership. A URL valid for one principal must not serve bytes to another that obtained it.

## Errors

Every non-2xx response has this machine-readable JSON shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "@openmaic/storage: asset write body must carry a \"bytes\" part",
    "details": []
  }
}
```

`details` is optional. One class of response cannot carry this envelope: a `431`, and anything else the framework emits before the handler runs, has neither a body of this shape nor an `X-Error-Code`. That is why the `431` row below names no code, and it is the reason the client rule is phrased as it is — **a response the client cannot classify is never a miss.**

Because `HEAD` responses have no body, every error response — on `HEAD` and, so that the two stay identical, on `GET` as well — MUST also carry the code in an `X-Error-Code` response header. Without it a client cannot tell `ASSET_NOT_FOUND` from `ROUTE_NOT_FOUND` from a gateway's own `404` on precisely the route it uses to decide whether a cached snapshot is still real. **A `HEAD` response a client cannot classify is never a miss:** it falls back to `GET`.

The client raises `HttpAssetStoreError` in every throwing case below.

| Condition | HTTP status | Error code | Client behavior |
| --- | --- | --- | --- |
| Malformed multipart, a missing or duplicate part, a query string, a prohibited header, a body on a bodyless method, or metadata outside the value domain (an *id* is opaque and never a validation failure) | `400` | `VALIDATION_FAILED` | Throw with the server message |
| Request `Content-Type` is not `multipart/form-data` | `415` | `UNSUPPORTED_MEDIA_TYPE` | Throw |
| Method not allowed on this route | `405` | `METHOD_NOT_ALLOWED` | Throw |
| Metadata, bytes, or the whole request exceed the deployment's bound | `413` | `PAYLOAD_TOO_LARGE` | Throw |
| The principal's logical bytes would exceed its quota | `507` | `ASSET_QUOTA_EXCEEDED` | Throw |
| Request target exceeds the deployment's ceiling | `431` | (transport) | A transport limit for a pathologically long id, not an id-domain rejection |
| No entry is stored under the id, or the entry is not this principal's | `404` | `ASSET_NOT_FOUND` | `resolve` returns `null`; `remove` succeeds; `replace` throws |
| Route does not exist | `404` | `ROUTE_NOT_FOUND` | Throw |
| Missing or invalid credential | `401` | `UNAUTHENTICATED` | Throw |
| Principal may not perform the operation | `403` | `FORBIDDEN_ASSETS` | Throw |
| Unexpected server failure | `500` | `INTERNAL_ERROR` | Throw; the handler does not expose internal details |

Only `ASSET_NOT_FOUND` becomes a miss, and the client MUST match the **code together with the status**. Status alone is not sufficient: `ROUTE_NOT_FOUND` shares its status and means a broken deployment, and a `401` or `403` MUST NEVER be reported as a miss. A gateway answering `401` while echoing an error code must not be read as "the asset was deleted" — that reading turns an auth outage into apparent data loss, and a caller that reacts by clearing references turns it into real data loss.

A response the client cannot interpret — a non-JSON body under a 2xx status, an allocation response without an `id` member — raises `MALFORMED_RESPONSE`, a client-side code with no server counterpart, carried by the same error type. The client never lets a native `SyntaxError`, `TypeError`, or `URIError` escape in its place.

The content hash MUST NOT appear in any `message` or `details`, on any path, including internal failures. `5xx` responses collapse to `INTERNAL_ERROR` with a fixed message for that reason as well as the usual one.

## Retry and atomicity guarantees

`GET` and `HEAD` are reads. `DELETE` is idempotent: removing an absent, already-removed, or foreign id succeeds. `PUT /assets/{id}/content` is idempotent in its effect on the bytes for the same body, though each application advances the revision — so a retry after an ambiguous failure leaves the bytes correct and the revision advanced twice, which is why the revision is opaque and compared only for equality.

**`POST /assets` is not idempotent and is not implicitly retry-safe.** Every call allocates, so a retried request that in fact succeeded leaves a second entry holding the same bytes. This is a direct consequence of server-assigned ids, and it is the property `POST` carries in the [RuntimeStore HTTP contract](./runtime-http-contract.md). A caller that retries blindly should expect an orphan; a caller that cannot tolerate one must track the allocation it received.

A failed write leaves **no registry entry**, and no entry ever survives pointing at bytes that were not stored. It may leave bytes that nothing references — the crash window described under the byte layer, which costs storage rather than correctness. Whether it does depends on the layer: one inside the transactional store rolls back with the transaction and leaves nothing, while an object store cannot join that transaction and strands an object for reconciliation to take. There is no compare-and-swap. Concurrent `replace` calls on one id are last-writer-wins, and the revision reflects the order the server applied them. A `resolve` racing a `replace` observes either the pre- or the post-replace committed entry and never a mixture of the two.
