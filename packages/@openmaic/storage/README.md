# @openmaic/storage

The MAIC pluggable persistence layer: small, swappable-backend primitives for
persisting app state, depending only on [`@openmaic/dsl`](../dsl).

The DSL owns _what_ persists (document / runtime shape + validation + migration +
the asset `StorageProvider` interface). This package owns _where / how_ it
persists — the primitives and their backends. The pluggable seam is the
**backend**, not the database driver: browser backends (the zero-server
`clone-and-run` default), HTTP clients plus a reference server, and PostgreSQL
server backends.

## Dependency arrow (acyclic)

```
@openmaic/storage -> @openmaic/dsl
```

No dependency on React, zustand, or any host app. Backends take their `Storage`
/ `IDBFactory` by injection, so the package is app-agnostic and testable without
a browser.

## What's in here

| Export | Role | Browser backend |
| --- | --- | --- |
| `KVStore` | small `device` / `account`-scoped values not owned by the DSL | `BrowserKVStore` over `localStorage` |
| `StorageProvider` (from `@openmaic/dsl`) | the asset seam: `put(blob) → ref`, `resolve(ref) → url`, `remove(ref)` | `BrowserAssetStore` over IndexedDB (`assets` registry + `blobs`) + object URLs |
| `kvPersistStorage` | adapt a `KVStore` into a zustand `persist` storage | — |
| `DocumentStore` | persist the DSL `document` aggregate (stage + scenes + embedded agents / quiz / actions + an outline snapshot) | `BrowserDocumentStore` over IndexedDB (normalized `stages` / `scenes` / `outlines`) |
| `RuntimeStore` | persist what a learner produces while taking a course — sessions + append-only records (chat, quiz attempts, playback facts) | `BrowserRuntimeStore` over IndexedDB (`sessions` / `records`) |

- **Scopes.** `account` values are user data a server-backed deployment syncs
  across devices; `device` values (theme, locale, layout) never leave the
  device — every backend honours that, so the scope is part of the primitive,
  not the backend choice. The [KV HTTP contract](./docs/kv-http-contract.md) is
  `account`-only and carries no scope on the wire at all, so `HttpKVStore`
  routes `device` to a `LocalKVStore` it requires at construction — a *branded*
  local backend, because a networked store satisfies plain `KVStore`
  structurally and would otherwise be accepted as the place device values live.
- **The asset pool.** `BrowserAssetStore` is a global asset pool (#1007): an
  **allocated** `AssetId` (`ast_` + 128 random bits) names a registry entry
  (`contentHash`, `mime`, `meta`), and the registry names content-addressed
  bytes. A document embeds only the id and the store resolves it to a URL at
  render time (a raw URL would bake in a provider + expiry and break
  portability). Two levels of indirection buy three things at once: an id
  survives the bytes behind it being regenerated through
  `BrowserAssetStore.replace`; identical bytes are stored once however many ids
  name them; and the content hash never leaves the package, so the "whoever
  knows the hash can reach the bytes" threat that pure content-addressing must
  defend against does not arise. Images, audio and video share one id space —
  the medium is a `mime` column, not a partition.
  `put` **always allocates a new id**, so its successful return values and
  branches do not reveal whether the bytes were already present. The browser
  registry embeds its `blobs` table in the same database because reference
  counting, byte writes, and reclamation must share one transaction. This is
  not a replaceable blob backend *in the browser*, because that store reclaims
  inline. The server backend collects offline instead, so no request deletes
  bytes and its byte layer is pluggable — a column of the transactional store,
  or an object store keyed by content hash. Resource-accounting channels remain:
  quota errors, storage estimates, and server billing or metering can disclose
  existence, so server deployments must budget them per principal — the
  [asset registry HTTP contract](./docs/asset-http-contract.md) requires quota
  to be accounted on a principal's logical bytes for exactly that reason. Object URLs
  are minted per id, not shared per `contentHash`: sharing would let a holder of
  two ids learn that their bytes match by comparing URL strings. Each
  `replace(id, ...)` followed by `resolve(id)` adds one retired snapshot that
  only `release(id)` or `close()` reclaims; each ref retains at most one current
  snapshot plus that retired history. A returned URL is an immutable snapshot:
  mutations affect future resolutions but never revoke a URL already issued by
  this or another store instance. Application code that constructs a concrete
  `BrowserAssetStore` owns that lifecycle (the narrower DSL `StorageProvider`
  seam exposes neither method), and media-heavy applications should reclaim
  snapshots explicitly. `release` is an owner-level escape hatch for a caller
  that owns every use of every URL returned for that id in the instance;
  `close` reclaims the whole instance.
  Cross-instance correctness comes from comparing the registry identity on
  every resolve, so a remove yields `null` and a replacement yields a fresh
  URL on the next call without reclaiming older snapshots.
  The id domain is opaque and unvalidated (the KV key-domain lesson, applied
  forward): an unrecognized id is a miss, never an error. The server backend is
  still to come.
- **Document normalization.** The DSL `document` is a portable embedded
  aggregate; `DocumentStore` normalizes it into per-entity rows so scene-level
  writes (`putScene`) stay cheap, and reassembles it on read. Each document is
  stamped with a `dslVersion`; reads run the DSL
  migration ladder forward, and writes are validated against the DSL gate
  (`validateStage` / `validateScene`) so schema drift fails loud. The outline is
  an opaque, app-owned snapshot carried alongside — persisted verbatim, neither
  validated nor migrated.
- **Generic over scene type.** `DocumentStore<TScene>` defaults to the DSL
  `Scene` (universal `slide` / `quiz`). An app that widens `Scene` with its own
  kinds (`interactive` / `pbl`, content the DSL does not own) parameterizes the
  store over its scene union and injects a matching `validateScene`, so those
  scenes persist and the gate stays fail-loud for the app's shapes.
- **Runtime layer.** `RuntimeStore` is partitioned by `(stageId, learnerKey)`:
  a stage has many sessions — one or more per learner — so every listing is
  partition-scoped (there is deliberately no global listing; single-session
  operations are id-keyed, and `mergeLearner` is the one deliberate
  cross-stage sweep). Sessions are **born stamped**: the store
  writes `runtimeDslVersion` itself at `createSession`, and the runtime line
  has no unversioned epoch, so an unstamped row fails loud instead of being
  lifted like a legacy document. Records are **append-only** ordered facts
  under an **active** session; the store assigns the per-session monotonic
  `seq` on append — the sole replay ordering key, never timestamps. Record
  payloads are gated per kind by injectable validators, defaulting to the DSL
  skeleton guards for `chat` / `quizAttempt` (`playback` and app-defined kinds
  carry app-owned payloads). `mergeLearner` re-keys an anonymous learner's
  sessions to a signed-in key across all stages; `deleteLearnerRuntime`
  cascades one learner's sessions + records on one stage, and
  `deleteStageRuntime` clears a whole stage — the hook a document deletion
  cascades through.
- `deleteAllRuntime` clears every runtime session and record for explicit
  whole-cache reset flows.

## Upgrading from 0.1.x

Version 0.2.0 removes `BrowserAssetProvider` outright; it no longer ships. The
asset API is now `BrowserAssetStore`, whose refs are allocated ids and whose
data lives in the new `maic-asset-pool` database.

Reusing a custom `dbName` created by a 0.1.x provider raises an explicit
legacy-schema error rather than corrupting data or operating only partially.

- `BrowserAssetStore` deliberately does not read data written by the 0.1.x
  provider in `maic-assets`. Its content-addressed `sha256-` refs are no longer
  outward references, and the contract suite pins sha256-shaped refs as misses;
  a silent read-through would restore the reference model this release removes.
- If persisted 0.1.x data must be carried forward, open an issue. The supported
  shape is an explicit one-time import helper that enumerates old rows,
  allocates an id per blob, and returns an old-ref-to-new-id mapping for the
  caller to apply to its documents.

## Backend equivalence

Each primitive has one implementation-agnostic contract suite
(`test/kv-contract.ts`, `test/asset-contract.ts`, `test/document-contract.ts`,
`test/runtime-contract.ts`).
Every backend is proven by running the same suite against it, so browser, HTTP,
and PostgreSQL implementations cannot silently diverge from a primitive's
semantics. Assets use the single `test/asset-contract.ts` suite for the
allocated-id store: identical bytes never share a caller-visible id. Asset
backends must let the suite temporarily instrument the production allocation
source while constructing the store through the same factory used by every
other contract test. This proves that every successful `put` consumes exactly
one allocator output, independent of whether the bytes already existed, without
adding a caller-configurable allocation path.

## Roadmap

- [x] `KVStore` + browser backend; zustand `persist` adapter
- [x] `StorageProvider` (in `@openmaic/dsl`) + browser asset registry: allocated
      `AssetId` over an embedded byte table in `BrowserAssetStore` (#1007)
- [x] implementation-agnostic contract suites
- [x] `DocumentStore` (aggregate ↔ normalized adapter, migrate-on-read via the
      DSL migration registry, validation gate) + browser backend
- [x] `RuntimeStore` (sessions + append-only records, runtime version line,
      per-kind payload gate) + browser backend
- [x] wire the app's settings + user-profile `persist` stores through `KVStore`
      (both `account` scope). No automatic migration of pre-cutover data: new
      data persists through `KVStore`, legacy `localStorage` keys are ignored
      (not migrated) and best-effort purged, and a user reconfigures once on
      upgrade
- [ ] wire the app's third `persist` store (`agent-registry-storage`), still on
      zustand's default `localStorage`
- [ ] wire the app's remaining ad-hoc `localStorage` keys through `KVStore`
- [ ] a hydration gate the app actually consumes — **required before an
      `account` scope can be served remotely**. With the browser backend,
      hydration resolves within microtasks of module evaluation and nothing
      observes it; a network round trip makes the gap visible, and the one-shot
      decisions taken against a not-yet-hydrated store (classroom agent-selection
      restore, media orchestration, scene-generator retry, server-provider
      reconcile) decide wrongly and then have their corrective writes refused
- [x] RuntimeStore HTTP backend + reference server + HTTP contract
- [x] RuntimeStore PostgreSQL backend
- [x] DocumentStore HTTP backend + reference-server routes + HTTP contract
- [x] DocumentStore PostgreSQL backend
- [x] `KVStore` (`account`) HTTP backend + HTTP contract
- [ ] `KVStore` server-side reference backend and reference-server route
- [x] asset registry HTTP contract (#1007)
- [ ] asset server backend — registry (principal column, server-derived) over a
      pluggable byte layer, with transactional-store and object-store
      implementations and an offline byte collector (#1007). It must allowlist
      content types before serving bytes, and it must account quota on a
      principal's logical bytes rather than on bytes physically written
- [ ] asset manifest: the one enumeration of "which `AssetId`s does this course
      reference?" the export paths converge on (#1007)

## License

MIT
