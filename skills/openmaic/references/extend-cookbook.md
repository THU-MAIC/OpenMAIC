# Extend The OpenMAIC Product (Cookbook)

## Scope

You are working **inside a fork of the OpenMAIC product** (the Next.js app at the repo root), customizing it in place. If instead you want to consume `@openmaic/*` in a separate app, use [extend-sdk.md](extend-sdk.md) instead.

Entry points below are given as **file + symbol name** (not line numbers — they drift). Read the file, then jump to the symbol. The `@/*` path alias is anchored at the repo root.

## Task 1 — Swap Or Add An AI Provider

**Goal:** route generation to a different provider, or register a brand-new one.

Two distinct cases:

- **Use an already-supported provider** (it's in the union below): no source change. Configure keys/models in `.env.local` or `server-providers.yml` — follow [provider-keys.md](provider-keys.md). Mind the `DEFAULT_MODEL=provider:model` prefix (without a prefix, parsing defaults to OpenAI).
- **Register a NEW provider** (source change):
  1. Add the id to the `BuiltInProviderId` union in `lib/types/provider.ts`.
  2. Register its config + models in the `PROVIDERS` registry in `lib/ai/providers.ts`.
  3. **Env wiring — required if you want `.env.local` to work:** add a `PREFIX: 'your-id'` entry to `LLM_ENV_MAP` in `lib/server/provider-config.ts`. That map is what actually reads `<PREFIX>_API_KEY` / `_BASE_URL` / `_MODELS` from env — without an entry, your env vars are **silently ignored**. (Bedrock is special-cased separately via `applyBedrockProviderConfig`.)
  4. Then set the key in `.env.local`. **Alternatively**, skip step 3 and configure via `server-providers.yml` — its entries are keyed by provider id and do not need an `LLM_ENV_MAP` entry.

**Gotcha:** OpenMAIC has **no hardcoded model fallback**. If `DEFAULT_MODEL` is unset, generation fails rather than picking a default — always set it.

## Task 2 — Enable Server-Side Persistence (PostgreSQL / S3)

**Goal:** persist documents, runtime state, and assets beyond the browser.

Accurate topology (there is **no local-file backend**):

- **Default:** browser-local storage (in-browser stores). Nothing leaves the device.
- **Opt into server persistence:** set `NEXT_PUBLIC_PERSISTENCE=1` — see `lib/persistence/bootstrap.ts` (this runs **client-side**; when enabled, the browser switches to HTTP-backed `HttpRuntimeStore` / `HttpDocumentStore` / `HttpAssetStore` that call `/api/persistence`). `NEXT_PUBLIC_PERSISTENCE_TOKEN` optionally authenticates those calls.
- **Server side:** the `/api/persistence` catch-all (`app/api/persistence/[...path]/route.ts`) persists **documents + runtime to PostgreSQL**, and **asset bytes to PostgreSQL or S3**. The byte-layer selection lives in `lib/persistence/asset-byte-store.ts` (`configuredS3Bucket` / `lazyAssetByteStore`) and is strictly three-way: **unset/empty** `ASSET_S3_BUCKET` ⇒ `PgAssetByteStore`; a **valid** bucket ⇒ S3; an **invalid** bucket name ⇒ asset operations **fail** — validation throws, there is no fallback to PG. (The failure isn't cached: the next asset request retries, and only asset traffic is affected — document/runtime requests keep working.)
- The backends themselves come from `@openmaic/storage` subpaths (`@openmaic/storage/document/pg`, `@openmaic/storage/runtime/pg`, `@openmaic/storage/asset/pg-bytes`, `@openmaic/storage/asset/s3-bytes`) — see the storage table in [extend-sdk.md](extend-sdk.md).

**Gotcha:** bootstrap is client-side and gated on `NEXT_PUBLIC_PERSISTENCE`; restart the dev server after changing `.env.local`. S3 additionally needs `@aws-sdk/client-s3` (optional peer of `@openmaic/storage`) installed in the app, and PG needs a reachable Postgres + the package's schema-ensure step.

## Task 3 — Branding / UI / Theme

**Goal:** change title, fonts, color tokens, or preset themes.

Entry points:

- Title + fonts: `app/layout.tsx` (the title metadata; fonts include `@openmaic/renderer/fonts.css`).
- Design tokens: `app/globals.css` — Tailwind v4 (`@import 'tailwindcss'`, the `@source` directives that scope the renderer's classes, and the `@theme inline { … }` block for custom tokens).
- Preset themes: the `PRESET_THEMES` array in `configs/theme.ts`.

**Gotcha:** This is Tailwind **v4** — config lives in CSS via `@theme`/`@source`, **not** in `tailwind.config.js`. The renderer's class names are discovered through the `@source` scans of its `dist`; keep token names consistent across `@theme` and the renderer or styles silently drop.

## Task 4 — Add A Page Or API Route

**Goal:** ship a new screen or a new server endpoint.

Entry points:

- Page (App Router): `app/<segment>/page.tsx`.
- API route: `app/api/<segment>/route.ts`.
- Reuse the shared server helpers instead of reimplementing: `lib/server/api-response.ts`, `lib/server/llm-error-response.ts`, `lib/server/ssrf-guard.ts`, `lib/server/proxy-fetch.ts`.
- Import app code via the `@/*` alias (e.g. `import { … } from '@/lib/…'`).

**Gotcha:** Any route that fetches a user-supplied URL must go through `lib/server/ssrf-guard.ts` and `lib/server/proxy-fetch.ts` — do not call `fetch()` directly with attacker-controlled hosts. LLM error responses should go through `llm-error-response.ts` to stay consistent with the rest of the API.

## Task 5 — Embed The Renderer Or Editor

**Goal:** drop a slide canvas (read-only) or the full editable slide surface into a component.

Entry points (real usage examples to copy):

- Render-only `SlideCanvas` from `@openmaic/renderer`: see `components/slide-renderer/SlideThumbnail.tsx`.
- Editable surface `EditableSlideCanvasWithUI` from `@openmaic/editor/ui`: see `components/edit/surfaces/slide/RendererEditorCanvas.tsx`.
- Types for slide data: `Slide`, `PPTElement` from `@openmaic/dsl`.

**Gotcha (CSS is mandatory):** The renderer renders unstyled/broken without its fonts and Tailwind classes. In the consuming layout/globals: `@import '@openmaic/renderer/fonts.css';` (or the JS import form), and ensure the renderer's classes are in Tailwind v4's content scan (an `@source` directive pointing at the renderer's `dist`). Note `fonts.css` is **generated** (regen via the renderer's `genfonts` script) and self-hosts CJK faces by fetching woff2 on demand from `https://file.maic.chat/fonts/<name>.woff2` — relevant for offline/custom-font operation. The editor transitively requires the renderer's full peer stack (Tailwind v4, `motion`, optionally `echarts`/`shiki`) — not just `react`/`react-dom`.

## After Your Edits — Run And Verify

This product still runs like the stock app; don't reinvent the startup steps:

- Dev server / startup mode → [startup-modes.md](startup-modes.md).
- Provider keys the running server needs → [provider-keys.md](provider-keys.md).
- Verify with `GET {url}/api/health` (Phase 4), then confirm UI/route changes in the browser.

Rebuild sequence when you touch `packages/@openmaic/*` source: consumers resolve to the built `dist/`, not `src/`, so rebuild the changed package (dependency order: `dsl → generation → storage → importer → renderer → editor`). `pnpm install`'s postinstall already does this in order; for a single package use its `pnpm run build`.
