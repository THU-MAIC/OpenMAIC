/**
 * Generate src/snapshot/katex-fonts-embed.ts from the installed KaTeX package.
 *
 * Run via `pnpm run gen-katex-fonts`; the package build runs it first so the
 * embedded CSS always matches the pinned KaTeX version.
 *
 * Why this exists: `slideToPng`'s primary (native-paint) path serializes the
 * slide into an SVG `<foreignObject>`, which cannot reach the document's font
 * registry — every web font must be inlined as a data URL first. For KaTeX that
 * inlining CANNOT be left to runtime `getFontEmbedCSS`: it reads `cssRules` off
 * `document.styleSheets`, which throws for a cross-origin KaTeX stylesheet (e.g.
 * the jsdelivr CDN copy) and silently drops those faces — so a formula using a
 * missing face (a large `\left\{` needs KaTeX_Size4, `\text{}` needs KaTeX_Main)
 * renders in a fallback glyph and the brace collapses. KaTeX ships a fixed, known
 * ~20-face set we bundle, so we embed all of them from disk up front and never
 * depend on runtime CSSOM access for math fonts.
 *
 * Do not edit the generated file by hand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import prettier from 'prettier';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const katexDir = path.dirname(require.resolve('katex/package.json'));
const katexVersion = require('katex/package.json').version;
const cssPath = path.join(katexDir, 'dist', 'katex.min.css');
const css = readFileSync(cssPath, 'utf8');

// Each KaTeX @font-face lists woff2 + woff + ttf. Keep the family/style/weight
// and replace the whole `src` with the single woff2 inlined as a data URL.
const blocks = [...css.matchAll(/@font-face\{([^}]*)\}/g)];
const out = [];
let embedded = 0;
for (const [, body] of blocks) {
  const woff2 = body.match(/url\(fonts\/([^)]+\.woff2)\)/);
  if (!woff2) continue;
  const woff2Path = path.join(katexDir, 'dist', 'fonts', woff2[1]);
  const b64 = readFileSync(woff2Path).toString('base64');
  const decl = (re) => (body.match(re) || [''])[0];
  const family = decl(/font-family:[^;]+/);
  const style = decl(/font-style:[^;]+/);
  const weight = decl(/font-weight:[^;]+/);
  out.push(
    `@font-face{${family};${style};${weight};` +
      `src:url(data:font/woff2;base64,${b64}) format("woff2")}`,
  );
  embedded += 1;
}

const cssString = out.join('\n');
const fileContents = `/**
 * GENERATED FILE — do not edit by hand.
 * Source: KaTeX ${katexVersion} @font-face rules with woff2 inlined as data URLs.
 * Regenerate with \`pnpm run gen-katex-fonts\`.
 *
 * ${embedded} faces. Prepended to the foreignObject font-embed CSS in slideToPng
 * so formulas always have complete math fonts, independent of runtime CSSOM
 * access. See scripts/generate-katex-fonts.mjs for why.
 */
export const KATEX_FONT_EMBED_CSS = ${JSON.stringify(cssString)};
`;

const outFile = path.join(here, '..', 'src', 'snapshot', 'katex-fonts-embed.ts');
// Format with the repo's Prettier config so the generated file is CI-clean and
// stable across rebuilds (otherwise the long CSS literal fails `prettier --check`).
const prettierConfig = await prettier.resolveConfig(outFile);
const formatted = await prettier.format(fileContents, { ...prettierConfig, parser: 'typescript' });
writeFileSync(outFile, formatted);
console.log(
  `[gen-katex-fonts] embedded ${embedded} KaTeX ${katexVersion} faces → src/snapshot/katex-fonts-embed.ts ` +
    `(${Math.round(cssString.length / 1024)} KB)`,
);
