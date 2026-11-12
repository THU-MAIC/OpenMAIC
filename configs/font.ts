/**
 * Fonts offered in the slide editor's text-format picker.
 *
 * A slide stores the picked family name, so an entry renders only where its
 * name is declared:
 *  - Chinese: `@openmaic/renderer/picker-fonts.css`, imported on every page by
 *    `app/layout.tsx`, declares these names over the renderer's self-hosted
 *    faces (`FONT_ALIASES` in its `fonts.config.mjs`). The editor and the
 *    classroom use the same files, so they render alike.
 *  - Latin: `@fontsource` packages loaded with the editor by
 *    `app/editor-fonts.ts`. Inter is loaded by `app/layout.tsx` as
 *    `Inter Variable`.
 *
 * Adding a Latin font: install its `@fontsource` package, import the weight
 * CSS in `app/editor-fonts.ts`, then add an entry here whose `value` matches
 * the package's `@font-face` family name. A Chinese font needs a self-hosted
 * face and an alias in the renderer's `fonts.config.mjs`.
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
