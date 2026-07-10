import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import preserveDirectives from 'rollup-plugin-preserve-directives';

const external = [
  /^@openmaic\/dsl($|\/)/,
  /^react($|\/)/,
  /^react-dom($|\/)/,
  /^motion($|\/)/,
  /^katex($|\/)/,
  /^echarts($|\/)/,
  /^shiki($|\/)/,
  /^lucide-react($|\/)/,
  /^tinycolor2($|\/)/,
  /^tailwind-merge($|\/)/,
  /^clsx($|\/)/,
  /^html-to-image($|\/)/,
  /^html2canvas-pro($|\/)/,
];

const onwarn = (warning) => {
  if (warning.code === 'CIRCULAR_DEPENDENCY') return;
  if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
  console.warn(`(!) ${warning.message}`);
};

const plugins = [
  nodeResolve({ browser: true, preferBuiltins: false }),
  commonjs(),
  typescript({
    tsconfig: './tsconfig.json',
    declaration: false,
    declarationMap: false,
    rootDir: 'src',
  }),
  // Preserve module-level directives (e.g. 'use client') into the built output.
  // Rollup strips them by default (see the MODULE_LEVEL_DIRECTIVE warning silenced
  // in onwarn above), which drops the client-boundary marker from dist/ — breaking
  // Next App Router server-component consumers of the editing entry.
  preserveDirectives(),
];

const entries = {
  index: 'src/index.ts',
  'elements/index': 'src/elements/index.ts',
  'types/index': 'src/types/index.ts',
  'snapshot/index': 'src/snapshot/index.ts',
  'editing/index': 'src/editing/index.ts',
};

// ESM-only: @openmaic/dsl (kept external) is ESM-only, so a CJS renderer bundle
// could not `require('@openmaic/dsl')`. Ship ESM only and don't advertise a
// `require` entry we can't honor. Consumers use bundlers (Next/Vite) or native ESM.
const buildBundle = () => ({
  input: entries,
  external,
  onwarn,
  output: {
    dir: 'dist',
    format: 'es',
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
    // Emit one file per source module so per-module directives ('use client')
    // survive into dist (rollup-plugin-preserve-directives requires this); a
    // bundled build would mix client and non-client modules and drop the marker.
    preserveModules: true,
    preserveModulesRoot: 'src',
    sourcemap: true,
  },
  plugins,
});

export default buildBundle();
