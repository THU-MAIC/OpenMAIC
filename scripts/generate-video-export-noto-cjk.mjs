import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const faces = [
  {
    package: 'noto-sans-sc',
    subset: 'chinese-simplified',
    family: 'OpenMAIC Noto Sans SC',
    licenseExport: 'NOTO_SANS_SC_OFL_LICENSE',
    filename: 'noto-sans-sc-chinese-simplified-400-normal.woff2',
  },
  {
    package: 'noto-sans-kr',
    subset: 'korean',
    family: 'OpenMAIC Noto Sans KR',
    licenseExport: 'NOTO_SANS_KR_OFL_LICENSE',
    filename: 'noto-sans-kr-korean-400-normal.woff2',
  },
];
const outputPath = path.join(root, 'lib', 'video-export', 'emit-hyperframes', 'noto-cjk-assets.ts');
const publicFontDir = path.join(root, 'public', 'vendor', 'video-export', 'fonts');
const publicFontBase = '/vendor/video-export/fonts';
const exportFontBase = 'assets/fonts';
mkdirSync(publicFontDir, { recursive: true });
const singleQuoted = (value) =>
  `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')}'`;

let totalBytes = 0;
const css = [];
const licenses = [];
const assets = [];
for (const face of faces) {
  const packageDir = path.join(root, 'node_modules', '@fontsource', face.package);
  const fontPath = path.join(
    packageDir,
    'files',
    `${face.package}-${face.subset}-400-normal.woff2`,
  );
  const font = readFileSync(fontPath);
  totalBytes += font.byteLength;
  copyFileSync(fontPath, path.join(publicFontDir, face.filename));
  css.push(
    `@font-face{font-family:"${face.family}";font-style:normal;font-weight:400;font-display:block;src:url("__OPENMAIC_QUIZ_FONT_BASE__/${face.filename}") format("woff2")}`,
  );
  assets.push({
    path: `${exportFontBase}/${face.filename}`,
    sourceUrl: `${publicFontBase}/${face.filename}`,
  });
  licenses.push(
    `export const ${face.licenseExport} =\n  ${singleQuoted(readFileSync(path.join(packageDir, 'LICENSE'), 'utf8'))};`,
  );
}

const output = `/**
 * GENERATED FILE — do not edit by hand.
 * Sources: @fontsource/noto-sans-sc and @fontsource/noto-sans-kr 400 WOFF2.
 * Regenerate with: pnpm gen:video-export-noto-cjk
 */
const NOTO_CJK_CSS_TEMPLATE = ${singleQuoted(css.join('\n'))};
export const NOTO_CJK_MEASUREMENT_CSS = NOTO_CJK_CSS_TEMPLATE.replaceAll(
  '__OPENMAIC_QUIZ_FONT_BASE__',
  ${singleQuoted(publicFontBase)},
);
export const NOTO_CJK_EXPORT_CSS = NOTO_CJK_CSS_TEMPLATE.replaceAll(
  '__OPENMAIC_QUIZ_FONT_BASE__',
  ${singleQuoted(exportFontBase)},
);
export const NOTO_CJK_FONT_ASSETS = ${JSON.stringify(assets)} as const;

${licenses.join('\n\n')}
`;

const config = await prettier.resolveConfig(outputPath);
writeFileSync(outputPath, await prettier.format(output, { ...config, parser: 'typescript' }));
console.log(
  `[video-export] emitted Pan-CJK font assets (${totalBytes} bytes) → ${path.relative(root, outputPath)}`,
);
