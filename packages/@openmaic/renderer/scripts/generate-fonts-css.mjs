/**
 * Generate fonts.css and picker-fonts.css from fonts.config.mjs.
 *
 * Run via `pnpm run genfonts`. The package build runs this first so the CSS
 * always reflects the config. Do not edit either file by hand.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  FONT_ALIASES,
  FONT_CDN_BASE_URL,
  FONT_DIR,
  FONT_FAMILIES,
  VARIABLE_WEIGHTS,
  fontUrl,
} from '../fonts.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(here, '..');

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
for (const family of Object.keys(VARIABLE_WEIGHTS)) {
  if (!FONT_FAMILIES.includes(family)) {
    throw new Error(`[genfonts] VARIABLE_WEIGHTS names '${family}', which is not in FONT_FAMILIES`);
  }
}

const fontsHeader = `/**
 * GENERATED FILE — do not edit by hand.
 * Source of truth: fonts.config.mjs (run \`pnpm run genfonts\` to regenerate).
 *
 * Self-hosted Chinese faces for slides imported from PPTX. The importer passes
 * original font-family names through unchanged; a name renders here only if it
 * matches one of these families.
 *
 * Consumers import this once at the app shell:
 *     import '@openmaic/renderer/fonts.css';
 *
 * The woff2 files are served from object storage at
 * ${FONT_CDN_BASE_URL}/${FONT_DIR}/<name>.woff2, fetched on demand the first
 * time a slide actually uses the corresponding font-family.
 */`;

const pickerHeader = `/**
 * GENERATED FILE — do not edit by hand.
 * Source of truth: FONT_ALIASES in fonts.config.mjs (run \`pnpm run genfonts\`).
 *
 * Opt-in. Declares the Google Fonts names that the @openmaic/editor default
 * font picker writes for its Chinese fonts, over the self-hosted faces in
 * fonts.css, so a slide set in one of them renders in it wherever it is shown:
 *     import '@openmaic/renderer/picker-fonts.css';
 *
 * Importing it claims these family names for the whole page, and each covers
 * every character with no unicode-range: any text on the page set in one of
 * them, slide or not, renders with (and downloads) the whole self-hosted file.
 * Do not import it if the page loads its own faces under these names.
 */`;

const fontFace = (name, family, weight) => `@font-face {
  font-display: swap;
  font-family: '${name}';${weight ? `\n  font-weight: ${weight};` : ''}
  src: url('${fontUrl(family)}') format('woff2');
}`;

const write = (file, header, blocks) =>
  writeFileSync(path.join(packageDir, file), `${header}\n${blocks.join('\n')}\n`);

write(
  'fonts.css',
  fontsHeader,
  FONT_FAMILIES.map((family) => fontFace(family, family)),
);
write(
  'picker-fonts.css',
  pickerHeader,
  Object.entries(FONT_ALIASES).map(([alias, family]) =>
    fontFace(alias, family, VARIABLE_WEIGHTS[family]),
  ),
);

console.log(
  `[genfonts] wrote ${FONT_FAMILIES.length} @font-face rules → fonts.css and ` +
    `${Object.keys(FONT_ALIASES).length} aliases → picker-fonts.css ` +
    `(${FONT_CDN_BASE_URL}/${FONT_DIR})`,
);
