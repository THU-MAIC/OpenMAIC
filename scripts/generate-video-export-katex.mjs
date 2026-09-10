/** Generate the offline KaTeX CSS/license module used by Quiz video export. */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import prettier from 'prettier';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const katexDir = path.dirname(require.resolve('katex/package.json'));
const katexVersion = require('katex/package.json').version;
const sourceCss = readFileSync(path.join(katexDir, 'dist', 'katex.min.css'), 'utf8');
const license = readFileSync(path.join(katexDir, 'LICENSE'), 'utf8');
const publicFontDir = path.join(root, 'public', 'vendor', 'video-export', 'fonts');
const publicFontBase = '/vendor/video-export/fonts';
const exportFontBase = 'assets/fonts';
mkdirSync(publicFontDir, { recursive: true });

const faces = [];
const assets = [];
for (const [, body] of sourceCss.matchAll(/@font-face\{([^}]*)\}/g)) {
  const woff2 = body.match(/url\(fonts\/([^)]+\.woff2)\)/);
  if (!woff2) continue;
  const filename = woff2[1];
  copyFileSync(path.join(katexDir, 'dist', 'fonts', filename), path.join(publicFontDir, filename));
  const declaration = (pattern) => body.match(pattern)?.[0] ?? '';
  faces.push(
    `@font-face{${declaration(/font-family:[^;]+/)};${declaration(/font-style:[^;]+/)};${declaration(/font-weight:[^;]+/)};font-display:block;src:url("__OPENMAIC_QUIZ_FONT_BASE__/${filename}") format("woff2")}`,
  );
  assets.push({
    path: `${exportFontBase}/${filename}`,
    sourceUrl: `${publicFontBase}/${filename}`,
  });
}
if (faces.length !== 20) {
  throw new Error(`Expected 20 KaTeX WOFF2 faces, found ${faces.length}`);
}

const rules = sourceCss.replace(/@font-face\{[^}]*\}/g, '');
const cssTemplate = `${faces.join('')}\n${rules}`;
const contents = `/**
 * GENERATED FILE — do not edit by hand.
 * Complete KaTeX ${katexVersion} CSS with all 20 WOFF2 fonts emitted as
 * deterministic project-relative binary assets.
 * Regenerate with \`pnpm gen:video-export-katex\`.
 */
const KATEX_CSS_TEMPLATE = ${JSON.stringify(cssTemplate)};
export const KATEX_MEASUREMENT_CSS = KATEX_CSS_TEMPLATE.replaceAll(
  '__OPENMAIC_QUIZ_FONT_BASE__',
  ${JSON.stringify(publicFontBase)},
);
export const KATEX_EXPORT_CSS = KATEX_CSS_TEMPLATE.replaceAll(
  '__OPENMAIC_QUIZ_FONT_BASE__',
  ${JSON.stringify(exportFontBase)},
);
export const KATEX_FONT_ASSETS = ${JSON.stringify(assets)} as const;
export const KATEX_MIT_LICENSE = ${JSON.stringify(license)};
`;

const outFile = path.join(root, 'lib', 'video-export', 'emit-hyperframes', 'katex-assets.ts');
const config = await prettier.resolveConfig(outFile);
writeFileSync(outFile, await prettier.format(contents, { ...config, parser: 'typescript' }));
console.log(
  `[video-export-katex] emitted ${faces.length} KaTeX ${katexVersion} WOFF2 assets and complete CSS`,
);
