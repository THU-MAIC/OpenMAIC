// Generate per-locale index redirect pages for the static export.
//
// The non-default-locale route requires >=1 slug segment, so /docs/<lang>/
// (the bare locale index) has no generated page. We emit a tiny static
// redirect HTML for each non-default locale that bounces to its
// getting-started page. The default-locale index (/docs/) is produced by the
// real app route, so it is left untouched.
import { existsSync } from 'node:fs';
import { mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_LANGUAGE, LANGUAGES, DOCS_BASE_PATH } from '../lib/locales.mjs';

const OUT = new URL('../out/', import.meta.url).pathname;
const INDEX_SLUG = 'getting-started';
const DEFAULT_LANG = DEFAULT_LANGUAGE;
const LANGS = LANGUAGES;

function redirectHtml(target) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${target}">
<script>location.replace(${JSON.stringify(target)})</script>
<title>Redirecting…</title></head>
<body><p style="padding:2rem">Redirecting to <a href="${target}">${target}</a>…</p></body></html>`;
}

async function main() {
  if (!existsSync(OUT)) {
    throw new Error(`out/ not found at ${OUT}; run "next build" first.`);
  }

  for (const lang of LANGS) {
    if (lang === DEFAULT_LANG) continue;
    const dir = join(OUT, lang);
    await mkdir(dir, { recursive: true });
    const target = `${DOCS_BASE_PATH}/${lang}/${INDEX_SLUG}`;
    await writeFile(join(dir, 'index.html'), redirectHtml(target));
    console.log(`[postexport] wrote out/${lang}/index.html -> ${target}`);
  }

  // The default locale (en) is unprefixed, so /docs/en/<slug> has no generated
  // page and would 404. Emit redirect stubs that bounce the prefixed English
  // form to its canonical unprefixed URL, so /docs/en/getting-started works too.
  const SPECIAL = new Set(['404', '_not-found', 'index']);
  const enSlugs = (await readdir(OUT))
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.slice(0, -'.html'.length))
    .filter((s) => !SPECIAL.has(s));
  const enDir = join(OUT, DEFAULT_LANG);
  await mkdir(enDir, { recursive: true });
  await writeFile(join(enDir, 'index.html'), redirectHtml(`${DOCS_BASE_PATH}/`));
  for (const slug of enSlugs) {
    await writeFile(
      join(enDir, `${slug}.html`),
      redirectHtml(`${DOCS_BASE_PATH}/${slug}`),
    );
  }
  console.log(`[postexport] wrote out/${DEFAULT_LANG}/{index,${enSlugs.join(',')}}.html -> unprefixed`);

  // Sanity report. Derived from the locale source so it can't drift.
  const expect = [
    'index.html',
    `${INDEX_SLUG}.html`,
    'static.json',
    ...LANGS.filter((l) => l !== DEFAULT_LANG).flatMap((l) => [
      `${l}/${INDEX_SLUG}.html`,
      `${l}/index.html`,
    ]),
  ];
  let ok = true;
  for (const rel of expect) {
    const p = join(OUT, rel);
    const exists = existsSync(p);
    if (!exists) ok = false;
    const size = exists ? (await stat(p)).size : 0;
    console.log(`[postexport] ${exists ? 'OK ' : 'MISSING'} ${rel}${exists ? ` (${size}b)` : ''}`);
  }
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
