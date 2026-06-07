/**
 * Loads the web fonts offered in the slide editor's text-format picker.
 *
 * `@fontsource` ships the font files via npm (no binaries committed to the
 * repo) and `unicode-range`-subsets the CJK faces, so a CJK font downloads
 * lazily — only the glyph-range chunks a slide actually uses. Imported once
 * from the root layout.
 *
 * The picker list lives in `configs/font.ts`; each entry's `value` must match
 * the `@font-face` family name of a package imported here. Inter is loaded
 * separately via `next/font` in `app/layout.tsx`.
 */

// Latin
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/700.css';
import '@fontsource/open-sans/400.css';
import '@fontsource/open-sans/700.css';
import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/700.css';
import '@fontsource/merriweather/400.css';
import '@fontsource/merriweather/700.css';
import '@fontsource/literata/400.css';
import '@fontsource/literata/700.css';
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';

// Chinese — @fontsource unicode-range-subsets these, so each loads lazily.
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/700.css';
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/700.css';
import '@fontsource/lxgw-wenkai/500.css';
import '@fontsource/lxgw-wenkai/700.css';
import '@fontsource/zcool-kuaile/400.css';
