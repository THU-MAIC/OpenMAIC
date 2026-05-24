/**
 * Fonts offered in the slide editor's text-format picker.
 *
 * Every entry is a real web font: Inter via `next/font` (`app/layout.tsx`),
 * the rest via `@fontsource` packages loaded in `app/editor-fonts.ts`.
 * `@fontsource` `unicode-range`-subsets the CJK faces, so they download lazily
 * per glyph range — a picked font actually renders.
 *
 * Adding a font: install its `@fontsource` package, import the weight CSS in
 * `app/editor-fonts.ts`, then add an entry here whose `value` matches the
 * package's `@font-face` family name.
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
