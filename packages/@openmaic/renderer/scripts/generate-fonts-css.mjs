/**
 * Generate fonts.css from fonts.config.mjs.
 *
 * Run via `pnpm run genfonts`. The package build runs this first so the CSS
 * always reflects the config. Do not edit fonts.css by hand.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  FONT_ALIASES,
  FONT_CDN_BASE_URL,
  FONT_DIR,
  FONT_FAMILIES,
  fontUrl,
} from '../fonts.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'fonts.css');

for (const [alias, family] of Object.entries(FONT_ALIASES)) {
  if (!FONT_FAMILIES.includes(family)) {
    throw new Error(
      `[genfonts] alias '${alias}' points at '${family}', which is not in FONT_FAMILIES`,
    );
  }
  if (FONT_FAMILIES.includes(alias)) {
    throw new Error(`[genfonts] alias '${alias}' is already a family in FONT_FAMILIES`);
  }
}

const header = `/**
 * GENERATED FILE — do not edit by hand.
 * Source of truth: fonts.config.mjs (run \`pnpm run genfonts\` to regenerate).
 *
 * Self-hosted Chinese faces for slides imported from PPTX. The importer passes
 * original font-family names through unchanged; a name renders here only if it
 * matches one of these families.
 *
 * After them come aliases: the Google Fonts names of the same typefaces, which
 * the OpenMAIC slide editor's font picker writes. Each alias reuses its
 * family's woff2, so the file downloads once for both names.
 *
 * Consumers import this once at the app shell:
 *     import '@openmaic/renderer/fonts.css';
 *
 * The woff2 files are served from object storage at
 * ${FONT_CDN_BASE_URL}/${FONT_DIR}/<name>.woff2, fetched on demand the first
 * time a slide actually uses the corresponding font-family.
 */`;

const fontFace = (name, family) => `@font-face {
  font-display: swap;
  font-family: '${name}';
  src: url('${fontUrl(family)}') format('woff2');
}`;

const blocks = [
  ...FONT_FAMILIES.map((family) => fontFace(family, family)),
  ...Object.entries(FONT_ALIASES).map(([alias, family]) => fontFace(alias, family)),
].join('\n');

writeFileSync(outFile, `${header}\n${blocks}\n`);

console.log(
  `[genfonts] wrote ${FONT_FAMILIES.length} @font-face rules and ` +
    `${Object.keys(FONT_ALIASES).length} aliases → fonts.css ` +
    `(${FONT_CDN_BASE_URL}/${FONT_DIR})`,
);
