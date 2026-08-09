This is a Next.js application generated with
[Create Fumadocs](https://github.com/fuma-nama/fumadocs).

Run development server:

```bash
npm run dev
# or
pnpm dev
# or
yarn dev
```

The site is mounted under the `/docs` basePath, so open
http://localhost:3000/docs in your browser.

Build the static site (`next build` + static export, output in `out/`):

```bash
pnpm build
```

## Explore

In the project, you can see:

- `lib/locales.mjs`: Single source of truth for locales — language list, default
  locale, per-locale search tokenizer, RTL set, labels, and the `/docs` basePath.
  Plain JS so the `scripts/postexport.mjs` build step can import it too.
- `lib/source.ts`: Content source adapter, [`loader()`](https://fumadocs.dev/docs/headless/source-api) wires the MDX content with i18n.
- `lib/layout.shared.tsx`: Shared layout options (nav, GitHub link, Live Demo link).

| Route                       | Description                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `app/(en)`                  | English (default locale), served unprefixed at `/docs/<slug>`.      |
| `app/(intl)/[lang]`         | Other locales, served at `/docs/<lang>/<slug>`.                     |
| `app/static.json/route.ts`  | Build-time Orama static search index (served at `/docs/static.json`). |
| `scripts/postexport.mjs`    | Post-build step: per-locale index redirects + English alias stubs.  |

### Fumadocs MDX

A `source.config.ts` config file has been included, you can customise different options like frontmatter schema.

Read the [Introduction](https://fumadocs.dev/docs/mdx) for further details.

## Known limitations

### English supports only top-level docs pages

The default locale (`en`) is served unprefixed (`/docs/getting-started`). To keep
it unprefixed without the hydration conflict that a catch-all two-route-group
split causes, the English route `app/(en)/[slug]` is a single (non-catch-all)
segment. As a result, **nested English pages would 404** — e.g.
`content/docs/guides/intro.mdx` resolves for every other locale (their routes are
catch-all under `app/(intl)/[lang]/[...slug]`) but not for English.

Only top-level English docs pages work today. Adding nested English docs requires
revisiting the `(en)` route group (and resolving the hydration conflict that the
current split avoids); this is deliberately deferred.

## Learn More

To learn more about Next.js and Fumadocs, take a look at the following
resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js
  features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.
- [Fumadocs](https://fumadocs.dev) - learn about Fumadocs
