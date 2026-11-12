/**
 * A slide stores the family name picked in the editor, so the classroom renders
 * that font only if a stylesheet loaded on every page declares the name. The
 * picker's Chinese fonts are declared by `@openmaic/renderer/picker-fonts.css`
 * over the renderer's self-hosted faces, and the editor renders them with the
 * same rules, so a slide looks the same in both. These checks keep that wiring
 * in place.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_TOOLBAR_FONTS } from '@openmaic/editor/ui';
import { FONTS } from '@/configs/font';

const root = path.resolve(__dirname, '../..');
const resolvePackage = createRequire(path.join(root, 'package.json')).resolve;
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const readPackageFile = (specifier: string) => readFileSync(resolvePackage(specifier), 'utf8');

/** `font-family` → woff2 `src` URL for every `@font-face` rule of a stylesheet. */
const declaredFaces = (css: string) =>
  new Map(
    [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => [
      body.match(/font-family:\s*'([^']+)'/)?.[1],
      body.match(/src:\s*url\('([^']+)'\)/)?.[1],
    ]),
  );

const faces = declaredFaces(readPackageFile('@openmaic/renderer/fonts.css'));
const pickerFaces = declaredFaces(readPackageFile('@openmaic/renderer/picker-fonts.css'));

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
  ])('declares every Chinese font of %s in picker-fonts.css', (_name, families) => {
    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      expect(pickerFaces.has(family), `${family} has no @font-face in picker-fonts.css`).toBe(true);
    }
  });

  it('serves each alias from the file of the face it names, so the file downloads once', () => {
    expect([...pickerFaces.keys()].sort()).toEqual(Object.keys(SELF_HOSTED).sort());
    for (const [alias, family] of Object.entries(SELF_HOSTED)) {
      const target = faces.get(family);
      expect(target, `${family} is not declared in fonts.css`).toMatch(/\/fonts\/\w+\.woff2$/);
      expect(pickerFaces.get(alias), alias).toBe(target);
    }
  });

  it('declares the weight axis of the variable faces, so bold uses it rather than synthesis', () => {
    const weights = new Map(
      [
        ...readPackageFile('@openmaic/renderer/picker-fonts.css').matchAll(
          /@font-face\s*\{([^}]*)\}/g,
        ),
      ].map(([, body]) => [
        body.match(/font-family:\s*'([^']+)'/)?.[1],
        body.match(/font-weight:\s*([^;]+);/)?.[1] ?? null,
      ]),
    );
    expect(Object.fromEntries(weights)).toEqual({
      // Source Han Sans / Serif CN VF: `wght` axis 250–900.
      'Noto Sans SC': '250 900',
      'Noto Serif SC': '250 900',
      // Single-weight files: no range to declare.
      'LXGW WenKai': null,
      'ZCOOL KuaiLe': null,
    });
  });

  it('keeps the aliases out of fonts.css, which other consumers import for imported slides', () => {
    for (const alias of Object.keys(SELF_HOSTED)) expect(faces.has(alias), alias).toBe(false);
  });

  it('loads the aliases on every page and no other face under those names in the editor', () => {
    expect(read('app/layout.tsx')).toMatch(/^import '@openmaic\/renderer\/picker-fonts\.css';/m);
    const editorFonts = read('app/editor-fonts.ts');
    for (const pkg of ['noto-sans-sc', 'noto-serif-sc', 'lxgw-wenkai', 'zcool-kuaile']) {
      expect(editorFonts, pkg).not.toContain(`@fontsource/${pkg}`);
    }
  });
});
