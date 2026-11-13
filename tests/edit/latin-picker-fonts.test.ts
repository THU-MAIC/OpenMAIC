/**
 * A slide stores the family name picked in the editor, so the classroom shows
 * that font only if a stylesheet loaded on every page declares the name. The
 * Chinese picker fonts are covered by `@openmaic/renderer/picker-fonts.css`
 * (`picker-fonts-outside-editor.test.ts`); these checks cover the rest: the
 * Latin `@fontsource` packages imported by `app/slide-fonts.ts`, and the
 * `Inter` alias over the UI's `Inter Variable` files.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_TOOLBAR_FONTS } from '@openmaic/editor/ui';
import { FONTS } from '@/configs/font';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const resolvePackage = createRequire(path.join(root, 'package.json')).resolve;

const SYSTEM_FONTS = new Set(['Microsoft YaHei', 'Arial']);

/** Picker entries that are neither Chinese nor a system font nor the default. */
const latinWebFonts = (fonts: readonly { label: string; value: string }[]) =>
  fonts
    .filter((font) => font.value && !/\p{Script=Han}/u.test(font.label))
    .filter((font) => !SYSTEM_FONTS.has(font.value))
    .map((font) => font.value);

interface FontFace {
  readonly family: string;
  readonly descriptors: string;
}

/** The `@font-face` rules of a stylesheet, with the `src` URL reduced to its file name. */
function fontFaces(css: string): FontFace[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
    family: body.match(/font-family:\s*'([^']+)'/)?.[1] ?? '',
    descriptors: body
      .replace(/font-family:[^;]*;/, '')
      .replace(/url\(\s*'?[^)']*\/([^/)']+)'?\s*\)/g, 'url($1)')
      .replace(/\s+/g, ''),
  }));
}

/** The CSS each bare `import '…css'` in `file` pulls in. */
function importedStylesheets(file: string): string[] {
  return [...read(file).matchAll(/^import '([^']+\.css)';/gm)].map(([, specifier]) =>
    specifier.startsWith('.')
      ? read(path.join(path.dirname(file), specifier))
      : readFileSync(resolvePackage(specifier), 'utf8'),
  );
}

describe('Latin picker fonts outside the editor', () => {
  const layout = read('app/layout.tsx');
  const globalFamilies = new Set(
    importedStylesheets('app/slide-fonts.ts')
      .flatMap(fontFaces)
      .map((face) => face.family),
  );

  it('loads the font module from the root layout, and nothing loads fonts with the editor', () => {
    expect(layout).toMatch(/^import '\.\/slide-fonts';/m);
    expect(read('lib/edit/preload-editor.ts')).not.toMatch(/import\(['"][^'"]*fonts/);
  });

  it.each([
    ['the app picker (configs/font.ts)', latinWebFonts(FONTS)],
    ['the @openmaic/editor default picker', latinWebFonts(DEFAULT_TEXT_TOOLBAR_FONTS)],
  ])('declares every Latin web font of %s on every page', (_name, families) => {
    expect(families).toContain('Inter');
    for (const family of families) {
      expect(globalFamilies.has(family), `${family} is not declared on every page`).toBe(true);
    }
  });

  it('declares Inter with exactly the rules and files of the Inter Variable stylesheet', () => {
    expect(layout).toMatch(/^import '@fontsource-variable\/inter';/m);
    const upstream = fontFaces(
      readFileSync(resolvePackage('@fontsource-variable/inter'), 'utf8'),
    ).map((face) => face.descriptors);
    const alias = fontFaces(read('app/inter-alias.css'));
    expect(alias.map((face) => face.family)).toEqual(upstream.map(() => 'Inter'));
    expect(alias.map((face) => face.descriptors)).toEqual(upstream);
  });

  it('points every Inter alias source at a file the package ships', () => {
    const css = read('app/inter-alias.css');
    const sources = [...css.matchAll(/url\('([^']+)'\)/g)].map(([, url]) => url);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).toMatch(/^\.\.\/node_modules\/@fontsource-variable\/inter\/files\//);
      expect(() => readFileSync(path.join(root, 'app', source))).not.toThrow();
    }
  });
});
