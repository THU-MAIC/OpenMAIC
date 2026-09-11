# RuntimeStore, DocumentStore, and AssetStore reference server

The `@openmaic/storage/server` subpath exports a Node-only HTTP request handler implementing the [RuntimeStore HTTP contract](./runtime-http-contract.md), plus the [DocumentStore HTTP contract](./document-http-contract.md) and [AssetStore HTTP contract](./asset-http-contract.md) when their stores are supplied. It accepts injected store implementations; the runnable `@openmaic/storage/server/reference` composition creates and initializes `PgRuntimeStore`, accepts optional host-created document and asset stores, and demonstrates the required node-postgres checkout/transaction/release pattern.

The OpenMAIC application also mounts these same composed handlers as an
app-integrated Next.js route at `/api/persistence`. That embedded route is the
deployment form used by the repository's `server-persistence` Compose profile;
it changes the Fetch/Node request boundary only, not either HTTP contract.

This module is a reference, not a production authentication service. **The example bearer authentication is fully impersonatable.** A production host must supply its own authenticated identity and authorization policy. It must also terminate TLS, bound request sizes and timeouts, rate-limit abusive clients, keep database credentials outside the process image, and expose the service only through an appropriate application gateway.

## Deployment

Build the package and run the compiled entrypoint in a host that provides `pg`:

```sh
DATABASE_URL=postgres://user:password@host/database PORT=3000 \
  node packages/@openmaic/storage/dist/server/reference.js
```

The executable `main()` binds to `127.0.0.1`; `createReferenceRuntimeServer()` only creates and returns an unbound Node `Server`. The default bearer token payload is used directly as the demo `learnerKey`, self-merge is the only allowed merge, and admin operations are denied. Supplying `documentStore` adds the DocumentStore routes to that same server; any authenticated principal is allowed by default, or `authorizeDocuments` can enforce deployment policy. The factory also accepts `authenticate`, `authorizeMerge`, `authorizeAdmin`, and validator overrides. Replace the policy hooks before exposing a deployment:

- `authenticate(req)` must validate a real credential and derive canonical learner and asset partition keys from server-controlled identity state.
- `authorizeDocuments(principal, req)` must establish that the principal may access the requested author document operation. The default permits every authenticated principal.
- `authorizeAssets(principal, req)` must establish that the principal may access the requested asset operation. The default permits every authenticated principal carrying an asset key; registry ownership remains mandatory on every operation.
- `authorizeMerge(principal, fromKey, toKey)` must explicitly establish that the principal may migrate the complete source partition into the destination identity. Default denial is intentional.
- `authorizeAdmin(principal)` must require a separately protected administrative role. Default denial is intentional.

The handler's `payloadValidators` option has the same whole-table replacement semantics as the `BrowserRuntimeStore` and `PgRuntimeStore` constructor option, and defaults to the DSL `chat` / `quizAttempt` skeleton table. Whatever you pass to the store, pass the same thing to the handler. `createReferenceRuntimeServer()` applies its `payloadValidators` override to both automatically. Its `maxBodyBytes` option applies to runtime and document routes and defaults to 32 MiB; oversized bodies receive `413 PAYLOAD_TOO_LARGE`.

The package has no PostgreSQL driver runtime dependency. A host injects its `Pool` (or another compatible `Queryable`) and owns driver lifecycle. Every transactional operation must check out a fresh connection, issue `BEGIN`, run all callback queries on that same connection, issue `COMMIT` or `ROLLBACK`, and release it in `finally`.

## Document endpoints

Every document route requires an authenticated principal. By default,
`authorizeDocuments` allows any authenticated principal; production deployments
must replace that policy when documents are tenant-, role-, or author-scoped.

| Method | Path | Purpose |
| --- | --- | --- |
| `PUT` | `/documents/{stageId}` | Save a complete document |
| `GET` | `/documents/{stageId}` | Load a complete document |
| `GET` | `/documents` | List document summaries |
| `DELETE` | `/documents/{stageId}` | Delete a document and its children |
| `PUT` | `/documents/{stageId}/stage` | Replace stage metadata |
| `PUT` | `/documents/{stageId}/scenes/{sceneId}` | Upsert one scene |
| `GET` | `/documents/{stageId}/scenes/{sceneId}` | Read one scene |
| `DELETE` | `/documents/{stageId}/scenes/{sceneId}` | Delete one scene |

The reference composition applies its `validateScene` and `validateStage`
overrides to the HTTP handler; the host must configure the injected document
store with the same validators. Keep those validators in sync when composing
the lower-level handler yourself. Full response, validation, version, and retry
semantics are specified in the
[DocumentStore HTTP contract](./document-http-contract.md).

## Asset endpoints

Every asset route requires an authenticated principal with an asset partition key. Supplying `assetStore` adds these routes to the composed server; `authorizeAssets` can apply an additional deployment policy before any registry entry is read. Supplying `byteEgress` forwards the option unchanged to the composed asset handler: `{ mode: 'redirect', collectionGraceMs }` opts into indirect byte egress for `GET /assets/{id}/content`, and omitting it keeps direct egress. The full tradeoff is specified under [Indirect byte egress](./asset-http-contract.md) in the asset HTTP contract.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/assets` | Allocate a new id and store bytes |
| `GET` | `/assets/{id}/content` | Read bytes and identity headers |
| `HEAD` | `/assets/{id}/content` | Read identity headers without bytes |
| `PUT` | `/assets/{id}/content` | Replace bytes behind an existing id |
| `DELETE` | `/assets/{id}` | Remove an entry; absent and foreign ids are no-ops |

Writes use bounded `multipart/form-data`; reads are private and uncached. The full media-type allowlist, size limits, response headers, and client snapshot rules are specified in the [AssetStore HTTP contract](./asset-http-contract.md).

## Asset reclamation a host must schedule

**Nothing in this package runs on a timer.** `AssetCollector` is a re-runnable pass a host has to schedule; left unscheduled, unreferenced entries and bytes grow without bound. A host composing this server owns that schedule — a periodic call to `collect()` in-process, a cron job against the same database, whatever fits the deployment. `collect()` is bounded per call and answers how many blobs it deleted; `collectPass()` answers that plus whether the batch was full, which is exactly "run again", and the entry counts below.

Three options decide how much of the [two-level reclamation](./asset-http-contract.md) a deployment gets. All three are off or generous by default, so an existing deployment behaves as it did:

- **`PgDocumentStore`'s `trackAssetReferences`** (default `false`) makes the document store maintain the `document_asset_refs` table and the entry lifecycle columns inside the write transactions it already opens. It is off by default because those are the asset backend's tables: a deployment that provisions documents without `ensureAssetSchema()` has none of them. Enable it by constructing the store you inject as `documentStore` with the option set; nothing about the document routes changes either way. A host that retires a document by tombstone — keeping its rows, so deleting it is never an option — must call `store.withdrawAssetReferences(stageId)` in-process when it retires one, or that document's assets stay referenced forever; it is the release half of `deleteDocument` on its own, it leaves the document rows alone so re-saving re-references normally, and it throws rather than answering if the store does not track references. **There is no ordering to observe against the one-time backfill**: that walk reads stored JSON, which a retirement deliberately does not change, so the call records the retirement itself and the walk skips that document — a retirement made mid-upgrade is honoured like any other. That record is the only thing that makes the walk skip a live-looking document, deliberately: while the walk is behind, an entry's own state cannot say whether some document it has not reached still names it, so the walk re-references whatever it finds and lets the entry pass, which skips referenced entries, sort it out.
- **`PgAssetStore`'s `pendingTtlMs`** (default one day) is how long an allocated entry stays pending before it expires. The window it has to cover is "the bytes were stored, and then the document naming them was saved", which nothing on the wire leases, so a generous default is deliberate: unreclaimed bytes cost storage, while an expiry that fires before the document write costs a document its media. It is written on every allocation and only ever acted on by the entry pass below.
- **`AssetCollector`'s `documentReferences`** (default `false`) adds the entry pass, run ahead of the byte pass under the same batch cap and the same lock-and-re-check discipline. With it, the collector also backfills the reference table for a deployment upgrading into this level, in bounded chunks (`referenceBackfillBatchSize`, default fifty documents), and releases nothing until that walk has covered every document. Every transaction it opens carries a lock-wait budget, as the registry's writes do, so one stuck holder cannot park a scheduled pass indefinitely.

**`documentReferences` requires `trackAssetReferences`, and the collector enforces it.** They are two halves of one mechanism: the document store is what commits an entry and what records the references the pass reads. A collector running the entry pass against a document store that maintains nothing would see every entry as pending and release each one when its TTL expires, while the documents naming them are still there.

That is not left to the operator to get right. A document store with `trackAssetReferences` records a marker row in the registry's own schema on every write that maintains references, and the collector reads it before its entry pass: absent, the entry level refuses with `AssetReferenceTrackingNotEnabledError` and nothing is released. Because that marker arrives with the first such *write*, a host that can vouch for every writer on the database should call `store.declareAssetReferenceTracking()` once at startup, after ensuring the schemas — otherwise a freshly installed or freshly switched-on deployment refuses on every interval until somebody happens to save a document, the backfill never starts, and the refusal looks like a broken pairing rather than an idle one. The **blob pass still runs** — it is correct with or without a reference writer — so a deployment that trips this keeps reclaiming bytes while it fixes the configuration. The check is a marker rather than "are there any reference rows", because an empty table is indistinguishable from documents that reference nothing.

**The check catches enabling the halves in the wrong order; it does not catch rolling one back.** The marker is never removed, so a deployment that has run with both and then sets `trackAssetReferences` back to `false` — a revert, a flag flip, a replica deployed from an older configuration — keeps passing the check while its new allocations are never committed and are released on their TTL. The same mixture has a quieter second symptom: a store with tracking off cannot touch the asset backend's tables at all, so a delete it issues leaves behind the withdrawal record of a retired document, and the collector's one-time walk will then skip whatever later claims that id. **Roll the two back together, and prefer deriving both from one setting so they cannot drift.** A heartbeat would close this, and is deliberately not used: it would make an idle deployment refuse to reclaim its own expired pending entries for the sole reason that nobody wrote a document that week.

One grace period (`graceMs`, default one hour) governs both levels: an entry and its bytes are two rows describing one asset, and separate windows would only let them disagree about how long an undo has. A deployment using indirect byte egress must keep its signed-URL lifetime far below that grace; `assertSignedUrlTtlWithinGrace` states the rule, and the asset handler applies it already.

## Endpoint authorization matrix

The matrix treats learner, merge, and admin credentials as separate capabilities. An admin-only or merge-only credential does not implicitly own a learner partition; a deployment may combine capabilities, but every applicable check still has to pass.

| Method and path | No credential | Owning learner | Other learner | Merge-authorized | Admin-authorized |
| --- | --- | --- | --- | --- | --- |
| `POST /runtime/sessions` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `GET /runtime/sessions/{sessionId}` | Deny (`401`) | Allow | Not found (`404`) | Deny (`403`) | Deny (`403`) |
| `PATCH /runtime/sessions/{sessionId}/status` | Deny (`401`) | Allow | Not found (`404`) | Deny (`403`) | Deny (`403`) |
| `DELETE /runtime/sessions/{sessionId}` | Deny (`401`) | Allow | Not found (`404`) | Deny (`403`) | Deny (`403`) |
| `GET /runtime/stages/{stageId}/learners/{learnerKey}/sessions` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `POST /runtime/sessions/{sessionId}/records` | Deny (`401`) | Allow | Not found (`404`) | Deny (`403`) | Deny (`403`) |
| `GET /runtime/sessions/{sessionId}/records` | Deny (`401`) | Allow | Not found (`404`) | Deny (`403`) | Deny (`403`) |
| `POST /runtime/learners/merge` | Deny (`401`) | Deny by default | Deny by default | Allow | Deny |
| `DELETE /runtime/stages/{stageId}/learners/{learnerKey}` | Deny (`401`) | Allow | Deny (`403`) | Deny | Deny |
| `DELETE /runtime/stages/{stageId}` | Deny (`401`) | Deny (`403`) | Deny (`403`) | Deny (`403`) | Allow |
| `DELETE /runtime` | Deny (`401`) | Deny (`403`) | Deny (`403`) | Deny (`403`) | Allow |
| `POST /assets` | Deny (`401`) | Allow in own partition | Allow in own partition | Deny without asset key | Deny without asset key |
| `GET /assets/{id}/content` | Deny (`401`) | Allow for own id | Not found (`404`) | Deny without asset key | Deny without asset key |
| `HEAD /assets/{id}/content` | Deny (`401`) | Allow for own id | Not found (`404`) | Deny without asset key | Deny without asset key |
| `PUT /assets/{id}/content` | Deny (`401`) | Allow for own id | Not found (`404`) | Deny without asset key | Deny without asset key |
| `DELETE /assets/{id}` | Deny (`401`) | Allow | Allow as no-op | Deny without asset key | Deny without asset key |

## Threat model

`learnerKey` is an opaque partition key, never a credential. An attacker can alter path segments and JSON bodies, so trusting a submitted key enables lateral movement: reading another learner's sessions or records, writing records into their sessions, changing status, or deleting their data. The handler authenticates every contract operation and compares stored or submitted learner ownership before touching learner-scoped data. Direct stage / learner partition mismatches return `403 FORBIDDEN_LEARNER`; missing credentials return `401 UNAUTHENTICATED`.

Session-scoped routes deliberately conceal whether another learner's session ID exists. A credential with a different `learnerKey` receives the same `404 SESSION_NOT_FOUND` as an absent session, and ownership is checked before future-version classification so version metadata cannot disclose existence. A principal with no `learnerKey` is different: it lacks the learner capability entirely and receives `403 FORBIDDEN_LEARNER` on every learner-scoped route.

An asset id is an identifier, not a bearer token. Every asset operation rechecks the authenticated principal's ownership, including every byte read. An id belonging to another principal and an id that was never allocated are indistinguishable on every route: reads and replacements return the same fixed `404 ASSET_NOT_FOUND`, while deletion succeeds as the same no-op.

Merge is a privilege-escalation boundary because it rewrites every source session across every stage. Merely owning either key is insufficient in a real identity system: the authorization hook must verify the account-linking or identity-upgrade proof for both the source and destination. The default is deny.

Stage cascade deletion and whole-runtime deletion are admin-plane capabilities. If exposed to ordinary learners they can erase every partition on one stage or across the entire runtime store, so both routes are controlled by the separate admin authorization hook and denied by default. Production systems should isolate admin credentials, audit decisions, protect against confused-deputy use, and avoid deriving admin authority from a learner-controlled claim.

Authentication failures and authorization denials should be logged without recording bearer credentials or sensitive request payloads. Operators should monitor repeated cross-learner denials, merge attempts, and admin-plane calls as possible account-enumeration or privilege-escalation signals.

### Concurrency semantics during merge-time deletion

`mergeLearner` and `deleteSession` may race. If deletion verifies ownership and a merge changes ownership immediately afterward, the resulting deletion is equivalent to the legal serial order in which delete happens before merge. The handler therefore re-reads and re-checks ownership immediately adjacent to the delete call to shrink the race window; this is treated as a linearizable ordering case, not as an API or schema defect. A store-level conditional delete such as delete-if-owner could further harden this boundary in the future.

### Version and concurrent-write classification

Reads return future-stamped sessions and their records without applying a version gate, while every delete endpoint remains version-agnostic so it can clean up data written by a newer client. Only the three mutating operations that can rewrite session-owned data apply the future-version guard: status updates, record appends, and learner merges return `409 FUTURE_VERSION` rather than mutating a future-stamped session.

Status updates and record appends authorize and validate the session before entering the backing store's write transaction. If the store then rejects the write because a concurrent operation deleted or completed the session, the handler re-fetches the session instead of classifying the failure from driver or error-message text. A now-absent session returns `404 SESSION_NOT_FOUND`; a session whose current status is no longer `active` returns `400 VALIDATION_FAILED` and reports that status. If the structured re-fetch still finds an active, current-version session, or if the re-fetch itself fails, the original failure remains an undisclosed `500 INTERNAL_ERROR`.
