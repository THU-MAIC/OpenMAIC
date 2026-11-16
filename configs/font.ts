/**
 * Fonts offered in the slide editor's text-format picker.
 *
 * A slide stores the picked family name, so every entry must be declared
 * wherever slides render, not only in the editor. `app/slide-fonts.ts`,
 * imported on every page by the root layout, declares them all:
 *  - Chinese: `@openmaic/renderer/picker-fonts.css`, which declares these names
 *    over the renderer's self-hosted faces (`FONT_ALIASES` in its
 *    `fonts.config.mjs`).
 *  - Latin: `@fontsource` packages; `Inter` is declared by
 *    `app/inter-alias.css` over the UI's `Inter Variable` files.
 *
 * Adding a Latin font: install its `@fontsource` package, import the weight
 * CSS in `app/slide-fonts.ts`, then add an entry here whose `value` matches the
 * package's `@font-face` family name. A Chinese font needs a self-hosted face
 * and an alias in the renderer's `fonts.config.mjs`.
 * `tests/edit/latin-picker-fonts.test.ts` and
 * `tests/edit/picker-fonts-outside-editor.test.ts` check the declarations.
 */
export interface FontEntry {
  /** Display name; rendered as the fallback when `labelKey` is absent. */
  readonly label: string;
  /** CSS font-family value; "" means the element's own default (no override). */
  readonly value: string;
  /** Optional i18n key — preferred over `label` when present. */
  readonly labelKey?: string;
}

export const FONTS: readonly FontEntry[] = [
  { labelKey: 'edit.text.fontDefault', label: 'Default', value: '' },
  // Chinese
  { label: '思源黑体', value: 'Noto Sans SC' },
  { label: '思源宋体', value: 'Noto Serif SC' },
  { label: '霞鹜文楷', value: 'LXGW WenKai' },
  { label: '站酷快乐体', value: 'ZCOOL KuaiLe' },
  // Latin
  { label: 'Inter', value: 'Inter' },
  { label: 'Roboto', value: 'Roboto' },
  { label: 'Open Sans', value: 'Open Sans' },
  { label: 'Montserrat', value: 'Montserrat' },
  { label: 'Source Sans 3', value: 'Source Sans 3' },
  { label: 'Merriweather', value: 'Merriweather' },
  { label: 'Literata', value: 'Literata' },
  { label: 'Source Serif 4', value: 'Source Serif 4' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono' },
];
