/**
 * Loads the Latin web fonts offered in the slide editor's text-format picker.
 * Imported lazily with the editor by `lib/edit/preload-editor.ts`.
 *
 * `@fontsource` ships the font files via npm (no binaries committed to the
 * repo). The picker's Chinese fonts are not loaded here: the root layout
 * declares them on every page from `@openmaic/renderer/picker-fonts.css`, so
 * the editor and the classroom render them with the same files.
 *
 * The picker list lives in `configs/font.ts`; each Latin entry's `value` must
 * match the `@font-face` family name of a package imported here.
 */
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
