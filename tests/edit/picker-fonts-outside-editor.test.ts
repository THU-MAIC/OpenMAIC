/**
 * The classroom renders a slide without the editor's `@fontsource` faces
 * (`app/editor-fonts.ts` loads only with the editor), so a font picked in the
 * editor shows there only if the always-loaded `@openmaic/renderer/fonts.css`
 * declares the same family name. These checks keep the Chinese picker fonts,
 * the ones the renderer self-hosts, declared there under the names the pickers
 * write.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_TOOLBAR_FONTS } from '@openmaic/editor/ui';
import { FONTS } from '@/configs/font';

const fontsCss = readFileSync(
  createRequire(import.meta.url).resolve('@openmaic/renderer/fonts.css'),
  'utf8',
);

/** `font-family` → woff2 `src` URL for every `@font-face` rule in fonts.css. */
const declaredFaces = new Map(
  [...fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => [
    body.match(/font-family:\s*'([^']+)'/)?.[1],
    body.match(/src:\s*url\('([^']+)'\)/)?.[1],
  ]),
);

const SELF_HOSTED: Record<string, string> = {
  'Noto Sans SC': 'SourceHanSans',
  'Noto Serif SC': 'SourceHanSerif',
  'LXGW WenKai': 'LXGWWenKai',
  'ZCOOL KuaiLe': 'ZcoolHappy',
};

/** Picker entries labelled in Chinese: the CJK faces the renderer self-hosts. */
const chinesePickerFonts = (fonts: readonly { label: string; value: string }[]) =>
  fonts.filter((font) => /\p{Script=Han}/u.test(font.label)).map((font) => font.value);

describe('picker fonts outside the editor', () => {
  it.each([
    ['the app picker (configs/font.ts)', chinesePickerFonts(FONTS)],
    ['the @openmaic/editor default picker', chinesePickerFonts(DEFAULT_TEXT_TOOLBAR_FONTS)],
  ])('declares every Chinese font of %s in the renderer fonts.css', (_name, families) => {
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      expect(declaredFaces.has(family), `${family} has no @font-face in fonts.css`).toBe(true);
    }
  });

  it('serves each alias from the file of the face it names, so the file downloads once', () => {
    for (const [alias, family] of Object.entries(SELF_HOSTED)) {
      const target = declaredFaces.get(family);
      expect(target, `${family} is not declared`).toMatch(/\/fonts\/\w+\.woff2$/);
      expect(declaredFaces.get(alias), alias).toBe(target);
    }
  });
});
