/**
 * Declares every font the slide editor's text-format picker offers, on every
 * page. Imported once from the root layout.
 *
 * A slide stores the picked family name, so a face must be declared wherever
 * slides render (classroom, thumbnails, exports), not only in the editor; the
 * editor uses these same rules, so a slide renders alike in both.
 *
 * - Chinese: `@openmaic/renderer/picker-fonts.css` declares the names the
 *   picker writes over the renderer's self-hosted faces (whole files).
 * - Latin: `@fontsource` packages. Their 16 stylesheets total about 53 KB, and
 *   each face is `unicode-range`-subset into files of roughly 20–50 KB that
 *   download only when a page actually uses that font.
 * - Inter: the root layout loads it as `Inter Variable`; `./inter-alias.css`
 *   declares the `Inter` name the picker writes over the same files.
 *
 * The picker list lives in `configs/font.ts`; each entry's `value` must match a
 * family name declared here.
 */
import '@openmaic/renderer/picker-fonts.css';
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
import './inter-alias.css';
