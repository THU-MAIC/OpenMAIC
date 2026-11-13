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
 * typefaces, which the @openmaic/editor default font picker writes into
 * slides. Without an alias, text set in one of them falls back to a system font.
 *
 * Generated into the opt-in `picker-fonts.css`, not `fonts.css`: a page that
 * imports it gives these names to the self-hosted faces, so it must not load
 * its own faces under the same names. Each alias gets its own `@font-face` rule
 * with the same woff2 `src` as its target, so the browser downloads the file
 * once however many names use it.
 */
export const FONT_ALIASES = {
  'Noto Sans SC': 'SourceHanSans',
  'Noto Serif SC': 'SourceHanSerif',
  'LXGW WenKai': 'LXGWWenKai',
  'ZCOOL KuaiLe': 'ZcoolHappy',
};

/**
 * Weight range of the variable faces, from each woff2's `wght` axis. Without a
 * `font-weight` descriptor, WebKit (Safari) treats the file as one normal-weight
 * face and synthesizes bold on top of it; Chromium and Firefox read the font's
 * own range. Declaring the range makes bold use the axis in all three. Only the
 * alias rules in `picker-fonts.css` carry it; `fonts.css` stays as it was.
 */
export const VARIABLE_WEIGHTS = {
  SourceHanSans: '250 900',
  SourceHanSerif: '250 900',
};

/** Build the woff2 URL for a given family. */
export const fontUrl = (family) => `${FONT_CDN_BASE_URL}/${FONT_DIR}/${family}.woff2`;
