/**
 * Single source of truth for the self-hosted font CDN and the whitelist of
 * font families. `fonts.css` is GENERATED from this file by
 * `scripts/generate-fonts-css.mjs` — edit the config here, then run
 * `pnpm run genfonts` (the build does this automatically).
 *
 * These are the self-hosted CJK faces the renderer ships @font-face rules for.
 * The importer passes a slide's original font-family names through unchanged
 * (no remapping); a name only renders in one of these faces if it matches.
 */

/** Object-storage origin that serves the woff2 files. */
export const FONT_CDN_BASE_URL = 'https://file.maic.chat';

/** Path segment under the origin where the woff2 files live. */
export const FONT_DIR = 'fonts';

/** Ordered whitelist of font-family names (each backed by one Regular woff2). */
export const FONT_FAMILIES = [
  'SourceHanSans',
  'SourceHanSerif',
  'LXGWWenKai',
  'ZhuQueFangSong',
  'WenDingPLKaiTi',
  'ZcoolHappy',
];

/**
 * Other family names that render with one of the faces above, as
 * `alias → FONT_FAMILIES entry`. These are the Google Fonts names of the same
 * typefaces, which the OpenMAIC slide editor's font picker writes into slides.
 * The editor declares them itself from `@fontsource`, but a slide shown anywhere
 * else only has this stylesheet; without an alias, text set in one of these
 * fonts falls back to a system font there.
 *
 * Each alias gets its own `@font-face` rule with the same woff2 `src` as its
 * target, so the browser downloads the file once however many names use it.
 */
export const FONT_ALIASES = {
  'Noto Sans SC': 'SourceHanSans',
  'Noto Serif SC': 'SourceHanSerif',
  'LXGW WenKai': 'LXGWWenKai',
  'ZCOOL KuaiLe': 'ZcoolHappy',
};

/** Build the woff2 URL for a given family. */
export const fontUrl = (family) => `${FONT_CDN_BASE_URL}/${FONT_DIR}/${family}.woff2`;
