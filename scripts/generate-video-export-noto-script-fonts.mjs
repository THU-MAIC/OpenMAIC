import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSync } from 'fontkit';
import prettier from 'prettier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const faces = [
  {
    script: 'cyrillic',
    package: 'noto-sans',
    subset: 'cyrillic',
    family: 'OpenMAIC Noto Sans Cyrillic',
    filename: 'noto-sans-cyrillic-400-normal.woff2',
  },
  {
    script: 'cyrillic',
    package: 'noto-sans',
    subset: 'cyrillic-ext',
    family: 'OpenMAIC Noto Sans Cyrillic',
    filename: 'noto-sans-cyrillic-ext-400-normal.woff2',
  },
  {
    script: 'arabic',
    package: 'noto-sans-arabic',
    subset: 'arabic',
    family: 'OpenMAIC Noto Sans Arabic',
    filename: 'noto-sans-arabic-arabic-400-normal.woff2',
  },
];
const outputPath = path.join(
  root,
  'lib',
  'video-export',
  'emit-hyperframes',
  'noto-script-font-assets.ts',
);
const publicFontDir = path.join(root, 'public', 'vendor', 'video-export', 'fonts');
const publicFontBase = '/vendor/video-export/fonts';
const exportFontBase = 'assets/fonts';
mkdirSync(publicFontDir, { recursive: true });

function unicodeRangeFor({ package: packageName, subset }) {
  const unicode = JSON.parse(
    readFileSync(
      path.join(root, 'node_modules', '@fontsource', packageName, 'unicode.json'),
      'utf8',
    ),
  );
  const unicodeRange = unicode[subset];
  if (typeof unicodeRange !== 'string') {
    throw new Error(`Missing unicode.json range for @fontsource/${packageName}:${subset}`);
  }
  return unicodeRange;
}

function numericRanges(unicodeRange) {
  return unicodeRange.split(',').map((part) => {
    const match = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/u.exec(part);
    if (!match) throw new Error(`Invalid Fontsource unicode range: ${part}`);
    const start = Number.parseInt(match[1], 16);
    return [start, Number.parseInt(match[2] ?? match[1], 16)];
  });
}

function isInRanges(codePoint, ranges) {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function compactRanges(codePoints) {
  const sorted = [...new Set(codePoints)].sort((left, right) => left - right);
  const ranges = [];
  for (const codePoint of sorted) {
    const previous = ranges.at(-1);
    if (previous && codePoint === previous[1] + 1) previous[1] = codePoint;
    else ranges.push([codePoint, codePoint]);
  }
  return ranges;
}

function cssUnicodeRange(ranges) {
  return ranges
    .map(([start, end]) => {
      const first = start.toString(16).toUpperCase().padStart(4, '0');
      const last = end.toString(16).toUpperCase().padStart(4, '0');
      return start === end ? `U+${first}` : `U+${first}-${last}`;
    })
    .join(',');
}

function fontPathFor(face) {
  return path.join(
    root,
    'node_modules',
    '@fontsource',
    face.package,
    'files',
    `${face.package}-${face.subset}-400-normal.woff2`,
  );
}

const singleQuoted = (value) =>
  `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')}'`;
const facesWithUnicodeRanges = faces.map((face) => {
  const unicodeRange = unicodeRangeFor(face);
  const declaredRanges = numericRanges(unicodeRange);
  const fontPath = fontPathFor(face);
  const font = openSync(fontPath);
  const characterSet = font.characterSet;
  if (!Array.isArray(characterSet)) {
    throw new Error(`Unable to read WOFF2 cmap for ${face.filename}`);
  }
  const coverage = characterSet.filter(
    (codePoint) => font.hasGlyphForCodePoint(codePoint) && isInRanges(codePoint, declaredRanges),
  );
  const coverageRanges = compactRanges(coverage);
  if (coverageRanges.length === 0) {
    throw new Error(`WOFF2 cmap has no declared glyphs for ${face.filename}`);
  }
  return {
    ...face,
    unicodeRange: cssUnicodeRange(coverageRanges),
    fontPath,
    // A CSS unicode-range can be wider than the actual subset cmap. Only
    // code points present in both are safe for deterministic measurement.
    coverage,
  };
});
const cssFor = (face) =>
  `@font-face{font-family:"${face.family}";font-style:normal;font-weight:400;font-display:block;src:url("__OPENMAIC_QUIZ_FONT_BASE__/${face.filename}") format("woff2");unicode-range:${face.unicodeRange}}`;
const faceCss = Object.fromEntries(
  facesWithUnicodeRanges.map((face) => [face.filename, cssFor(face)]),
);
const scriptCssTemplates = Object.fromEntries(
  ['cyrillic', 'arabic'].map((script) => [
    script,
    facesWithUnicodeRanges
      .filter((face) => face.script === script)
      .map((face) => faceCss[face.filename])
      .join('\n'),
  ]),
);
const scriptCoverage = Object.fromEntries(
  ['cyrillic', 'arabic'].map((script) => [
    script,
    compactRanges(
      facesWithUnicodeRanges
        .filter((face) => face.script === script)
        .flatMap((face) => face.coverage),
    ),
  ]),
);
const scriptAssets = Object.fromEntries(
  ['cyrillic', 'arabic'].map((script) => [
    script,
    facesWithUnicodeRanges
      .filter((face) => face.script === script)
      .map(({ filename }) => ({
        path: `${exportFontBase}/${filename}`,
        sourceUrl: `${publicFontBase}/${filename}`,
      })),
  ]),
);

let totalBytes = 0;
for (const face of facesWithUnicodeRanges) {
  const font = readFileSync(face.fontPath);
  totalBytes += font.byteLength;
  copyFileSync(face.fontPath, path.join(publicFontDir, face.filename));
}

const notoSansLicense = readFileSync(
  path.join(root, 'node_modules', '@fontsource', 'noto-sans', 'LICENSE'),
  'utf8',
);
const notoSansArabicLicense = readFileSync(
  path.join(root, 'node_modules', '@fontsource', 'noto-sans-arabic', 'LICENSE'),
  'utf8',
);
const output = `/**
 * GENERATED FILE — do not edit by hand.
 * Sources: @fontsource/noto-sans and @fontsource/noto-sans-arabic 400 WOFF2.
 * Regenerate with: pnpm gen:video-export-noto-script-fonts
 */
const NOTO_SCRIPT_FONT_CSS_TEMPLATES = ${JSON.stringify(scriptCssTemplates)} as const;
const materializeCss = (template: string, base: string) =>
  template.replaceAll('__OPENMAIC_QUIZ_FONT_BASE__', base);
export const NOTO_SANS_OFL_LICENSE = ${singleQuoted(notoSansLicense)};
export const NOTO_SANS_ARABIC_OFL_LICENSE = ${singleQuoted(notoSansArabicLicense)};

export const NOTO_SCRIPT_FONT_PLANS = {
  cyrillic: {
    measurementCss: materializeCss(NOTO_SCRIPT_FONT_CSS_TEMPLATES.cyrillic, ${singleQuoted(publicFontBase)}),
    exportCss: materializeCss(NOTO_SCRIPT_FONT_CSS_TEMPLATES.cyrillic, ${singleQuoted(exportFontBase)}),
    assets: ${JSON.stringify(scriptAssets.cyrillic)} as const,
    licenses: [{ path: 'LICENSES/Noto-Sans-OFL-1.1.txt', content: NOTO_SANS_OFL_LICENSE }] as const,
    requiredFontLoads: [{ family: 'OpenMAIC Noto Sans Cyrillic', text: 'Привет Ёж Ԁ' }] as const,
    coverage: ${JSON.stringify(scriptCoverage.cyrillic)} as const,
  },
  arabic: {
    measurementCss: materializeCss(NOTO_SCRIPT_FONT_CSS_TEMPLATES.arabic, ${singleQuoted(publicFontBase)}),
    exportCss: materializeCss(NOTO_SCRIPT_FONT_CSS_TEMPLATES.arabic, ${singleQuoted(exportFontBase)}),
    assets: ${JSON.stringify(scriptAssets.arabic)} as const,
    licenses: [{ path: 'LICENSES/Noto-Sans-Arabic-OFL-1.1.txt', content: NOTO_SANS_ARABIC_OFL_LICENSE }] as const,
    requiredFontLoads: [{ family: 'OpenMAIC Noto Sans Arabic', text: 'العربية' }] as const,
    coverage: ${JSON.stringify(scriptCoverage.arabic)} as const,
  },
} as const;
`;

const config = await prettier.resolveConfig(outputPath);
writeFileSync(outputPath, await prettier.format(output, { ...config, parser: 'typescript' }));
console.log(
  `[video-export] emitted script font assets (${totalBytes} bytes) → ${path.relative(root, outputPath)}`,
);
