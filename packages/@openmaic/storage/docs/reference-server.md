# RuntimeStore and DocumentStore reference server

The `@openmaic/storage/server` subpath exports a Node-only HTTP request handler implementing the [RuntimeStore HTTP contract](./runtime-http-contract.md) and, when a document store is supplied, the [DocumentStore HTTP contract](./document-http-contract.md). It accepts injected `RuntimeStore` and `DocumentStore` implementations; the runnable `@openmaic/storage/server/reference` composition creates and initializes `PgRuntimeStore`, accepts an optional host-created document store, and demonstrates the required node-postgres checkout/transaction/release pattern.

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

- `authenticate(req)` must validate a real credential and derive the canonical learner partition from server-controlled identity state.
- `authorizeDocuments(principal, req)` must establish that the principal may access the requested author document operation. The default permits every authenticated principal.
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

## Threat model

`learnerKey` is an opaque partition key, never a credential. An attacker can alter path segments and JSON bodies, so trusting a submitted key enables lateral movement: reading another learner's sessions or records, writing records into their sessions, changing status, or deleting their data. The handler authenticates every contract operation and compares stored or submitted learner ownership before touching learner-scoped data. Direct stage / learner partition mismatches return `403 FORBIDDEN_LEARNER`; missing credentials return `401 UNAUTHENTICATED`.

Session-scoped routes deliberately conceal whether another learner's session ID exists. A credential with a different `learnerKey` receives the same `404 SESSION_NOT_FOUND` as an absent session, and ownership is checked before future-version classification so version metadata cannot disclose existence. A principal with no `learnerKey` is different: it lacks the learner capability entirely and receives `403 FORBIDDEN_LEARNER` on every learner-scoped route.

Merge is a privilege-escalation boundary because it rewrites every source session across every stage. Merely owning either key is insufficient in a real identity system: the authorization hook must verify the account-linking or identity-upgrade proof for both the source and destination. The default is deny.

Stage cascade deletion and whole-runtime deletion are admin-plane capabilities. If exposed to ordinary learners they can erase every partition on one stage or across the entire runtime store, so both routes are controlled by the separate admin authorization hook and denied by default. Production systems should isolate admin credentials, audit decisions, protect against confused-deputy use, and avoid deriving admin authority from a learner-controlled claim.

Authentication failures and authorization denials should be logged without recording bearer credentials or sensitive request payloads. Operators should monitor repeated cross-learner denials, merge attempts, and admin-plane calls as possible account-enumeration or privilege-escalation signals.

### Concurrency semantics during merge-time deletion

`mergeLearner` and `deleteSession` may race. If deletion verifies ownership and a merge changes ownership immediately afterward, the resulting deletion is equivalent to the legal serial order in which delete happens before merge. The handler therefore re-reads and re-checks ownership immediately adjacent to the delete call to shrink the race window; this is treated as a linearizable ordering case, not as an API or schema defect. A store-level conditional delete such as delete-if-owner could further harden this boundary in the future.

### Version and concurrent-write classification

Reads return future-stamped sessions and their records without applying a version gate, while every delete endpoint remains version-agnostic so it can clean up data written by a newer client. Only the three mutating operations that can rewrite session-owned data apply the future-version guard: status updates, record appends, and learner merges return `409 FUTURE_VERSION` rather than mutating a future-stamped session.

Status updates and record appends authorize and validate the session before entering the backing store's write transaction. If the store then rejects the write because a concurrent operation deleted or completed the session, the handler re-fetches the session instead of classifying the failure from driver or error-message text. A now-absent session returns `404 SESSION_NOT_FOUND`; a session whose current status is no longer `active` returns `400 VALIDATION_FAILED` and reports that status. If the structured re-fetch still finds an active, current-version session, or if the re-fetch itself fails, the original failure remains an undisclosed `500 INTERNAL_ERROR`.
