#!/usr/bin/env node
/**
 * Build the standalone HTML player into public/vendor/standalone-player/.
 *
 * The standalone HTML export inlines these files into every exported
 * classroom, so the export itself needs no bundler:
 *
 * - player.min.js        the player app (React + @openmaic/renderer), one IIFE
 * - player-charts.min.js the ECharts runtime for chart elements; the export
 *                        adds it only when a slide contains a chart
 * - player.min.css       Tailwind 4 output for the player and the renderer's
 *                        classes, plus KaTeX's stylesheet without its fonts
 * - katex-fonts.min.css  KaTeX @font-face rules with the woff2 files inlined;
 *                        the export adds it only when the classroom shows math
 *
 * The outputs are gitignored build artifacts, produced by `dev` and `build`
 * (or `pnpm build:standalone-player`). `pnpm dev` builds them once at
 * startup and does not watch: after editing lib/standalone-player (or the
 * renderer), rerun `pnpm build:standalone-player` before exporting again. They are checked for sequences that
 * would end their inline <script>/<style> element, since the export embeds
 * them verbatim.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const playerDir = path.join(root, 'lib/standalone-player');
const outDir = path.join(root, 'public/vendor/standalone-player');

/** Mirrors STANDALONE_CHARTS_GLOBAL in lib/export/standalone-html/contract.ts. */
const CHARTS_GLOBAL = '__OPENMAIC_CHARTS__';

/**
 * Module substitutions for the player bundle:
 *
 * - `echarts/{core,charts,components,renderers}` read the runtime the optional
 *   charts script registers. The renderer loads them lazily and shows a chart
 *   only once they resolve, so a file without charts never needs them.
 * - `shiki` is replaced by a highlighter that never resolves: its grammars and
 *   WASM engine would multiply every file's size, and the renderer's code
 *   element renders plain (escaped) lines until a highlighter arrives.
 */
const playerSubstitutions = {
  name: 'standalone-player-substitutions',
  setup(builder) {
    builder.onResolve({ filter: /^echarts\/(core|charts|components|renderers)$/ }, (args) => ({
      path: args.path.slice('echarts/'.length),
      namespace: 'echarts-global',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'echarts-global' }, (args) => ({
      loader: 'js',
      contents: `var runtime = globalThis[${JSON.stringify(CHARTS_GLOBAL)}];
if (!runtime) throw new Error('Charts are not included in this export');
module.exports = runtime[${JSON.stringify(args.path)}];`,
    }));
    builder.onResolve({ filter: /^shiki$/ }, () => ({ path: 'shiki', namespace: 'shiki-stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'shiki-stub' }, () => ({
      loader: 'js',
      contents: 'export function createHighlighter() { return new Promise(function () {}); }',
    }));
  },
};

async function buildScript(entry, plugins = []) {
  const result = await build({
    entryPoints: [path.join(playerDir, entry)],
    plugins,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    jsx: 'automatic',
    tsconfig: path.join(root, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'eof',
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}

/** KaTeX's stylesheet split into its rules (fonts removed) and its @font-face blocks. */
async function katexStyles() {
  const katexDir = path.dirname(require.resolve('katex/package.json'));
  const css = await readFile(path.join(katexDir, 'dist/katex.min.css'), 'utf8');
  const fontFaces = [...css.matchAll(/@font-face\{[^}]*\}/g)].map((match) => match[0]);
  const rules = css.replace(/@font-face\{[^}]*\}/g, '');
  const inlined = await Promise.all(
    fontFaces.map(async (block) => {
      const woff2 = block.match(/url\((fonts\/[^)]+\.woff2)\)/);
      if (!woff2) return '';
      const bytes = await readFile(path.join(katexDir, 'dist', woff2[1]));
      const src = `src:url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2")`;
      return block.replace(/src:[^;}]*/, src);
    }),
  );
  return { rules, fonts: inlined.join('') };
}

async function buildStyle() {
  const entry = path.join(playerDir, 'player.css');
  const result = await postcss([tailwindcss({ optimize: { minify: true } })]).process(
    await readFile(entry, 'utf8'),
    { from: entry },
  );
  return result.css;
}

function assertInlineSafe(name, text, element) {
  const closing = new RegExp(`</${element}`, 'i');
  if (closing.test(text) || (element === 'script' && text.includes('<!--'))) {
    throw new Error(`[standalone-player] ${name} cannot be inlined into a <${element}> element`);
  }
}

function sizeLabel(text) {
  const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
  return `${kib(Buffer.byteLength(text))} (gzip ${kib(gzipSync(text).length)})`;
}

const [script, chartsScript, style, katex] = await Promise.all([
  buildScript('main.tsx', [playerSubstitutions]),
  buildScript('charts.ts'),
  buildStyle(),
  katexStyles(),
]);
const outputs = {
  'player.min.js': [script, 'script'],
  'player-charts.min.js': [chartsScript, 'script'],
  'player.min.css': [`${style}\n${katex.rules}`, 'style'],
  'katex-fonts.min.css': [katex.fonts, 'style'],
};

await mkdir(outDir, { recursive: true });
for (const [name, [text, element]] of Object.entries(outputs)) {
  assertInlineSafe(name, text, element);
  await writeFile(path.join(outDir, name), text);
  console.log(`[standalone-player] ${name}: ${sizeLabel(text)}`);
}
