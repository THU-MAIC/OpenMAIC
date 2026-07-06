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

## What's in here (Part 1)

| Export | Role | Browser backend |
| --- | --- | --- |
| `KVStore` | small `device` / `account`-scoped values not owned by the DSL | `BrowserKVStore` over `localStorage` |
| `StorageProvider` (from `@openmaic/dsl`) | the asset seam: `put(blob) → ref`, `resolve(ref) → url`, `remove(ref)` | `BrowserAssetProvider` over IndexedDB + object URLs |
| `kvPersistStorage` | adapt a `KVStore` into a zustand `persist` storage | — |

- **Scopes.** `account` values are user data a server-backed deployment syncs
  across devices; `device` values (theme, locale, layout) never leave the
  device — every backend honours that, so the scope is part of the primitive,
  not the backend choice.
- **Content-addressed assets.** `BrowserAssetProvider` refs are `sha256-<hex>`,
  so identical bytes de-duplicate to one stored asset. A document embeds only
  the stable ref; the provider resolves it to a URL at render time (a raw URL
  would bake in a provider + expiry and break portability).

## Backend equivalence

Each primitive has one implementation-agnostic contract suite
(`test/kv-contract.ts`, `test/asset-contract.ts`). Every backend is proven by
running the same suite against it, so a new backend (the coming HTTP one) cannot
silently diverge from the primitive's semantics.

## Roadmap

- [x] `KVStore` + browser backend; zustand `persist` adapter
- [x] `StorageProvider` (in `@openmaic/dsl`) + browser `BrowserAssetProvider`
- [x] implementation-agnostic contract suites
- [ ] wire the app's zustand stores + ad-hoc `localStorage` through `KVStore`
- [ ] `DocumentStore` (aggregate ↔ normalized adapter, migrate-on-read via the
      DSL migration registry, validation gate)
- [ ] `RuntimeStore`
- [ ] HTTP backend + reference server + one HTTP contract

## License

MIT
