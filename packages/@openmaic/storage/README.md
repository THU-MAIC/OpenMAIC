# @openmaic/storage

The MAIC pluggable persistence layer: small, swappable-backend primitives for
persisting app state, depending only on [`@openmaic/dsl`](../dsl).

The DSL owns _what_ persists (document / runtime shape + validation + migration +
the asset `StorageProvider` interface). This package owns _where / how_ it
persists — the primitives and their backends. The pluggable seam is the
**backend**, not the database driver: a browser backend (zero server, the
`clone-and-run` default) and, later, an HTTP backend whose server owns a
database.

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
| `StorageProvider` (from `@openmaic/dsl`) | the asset seam: `put(blob) → ref`, `resolve(ref) → url`, `remove(ref)` | `BrowserAssetProvider` over IndexedDB + object URLs |
| `kvPersistStorage` | adapt a `KVStore` into a zustand `persist` storage | — |
| `DocumentStore` | persist the DSL `document` aggregate (stage + scenes + embedded agents / quiz / actions + an outline snapshot) | `BrowserDocumentStore` over IndexedDB (normalized `stages` / `scenes` / `outlines`) |
| `RuntimeStore` | persist what a learner produces while taking a course — sessions + append-only records (chat, quiz attempts, playback facts) | `BrowserRuntimeStore` over IndexedDB (`sessions` / `records`) |

- **Scopes.** `account` values are user data a server-backed deployment syncs
  across devices; `device` values (theme, locale, layout) never leave the
  device — every backend honours that, so the scope is part of the primitive,
  not the backend choice.
- **Content-addressed assets.** `BrowserAssetProvider` refs are `sha256-<hex>`,
  so identical bytes de-duplicate to one stored asset. A document embeds only
  the stable ref; the provider resolves it to a URL at render time (a raw URL
  would bake in a provider + expiry and break portability).
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

## Backend equivalence

Each primitive has one implementation-agnostic contract suite
(`test/kv-contract.ts`, `test/asset-contract.ts`, `test/document-contract.ts`,
`test/runtime-contract.ts`).
Every backend is proven by running the same suite against it, so a new backend
(the coming HTTP one) cannot silently diverge from the primitive's semantics.

## Roadmap

- [x] `KVStore` + browser backend; zustand `persist` adapter
- [x] `StorageProvider` (in `@openmaic/dsl`) + browser `BrowserAssetProvider`
- [x] implementation-agnostic contract suites
- [x] `DocumentStore` (aggregate ↔ normalized adapter, migrate-on-read via the
      DSL migration registry, validation gate) + browser backend
- [x] `RuntimeStore` (sessions + append-only records, runtime version line,
      per-kind payload gate) + browser backend
- [ ] wire the app's zustand stores + ad-hoc `localStorage` through `KVStore`
- [ ] HTTP backend + reference server + one HTTP contract

## License

MIT
