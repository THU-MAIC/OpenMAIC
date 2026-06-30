import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';

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
];

const entries = {
  index: 'src/index.ts',
  'elements/index': 'src/elements/index.ts',
  'types/index': 'src/types/index.ts',
  'snapshot/index': 'src/snapshot/index.ts',
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
    preserveModulesRoot: 'src',
    sourcemap: true,
  },
  plugins,
});

export default buildBundle();
