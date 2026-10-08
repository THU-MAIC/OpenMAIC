import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';
import globals from 'rollup-plugin-node-globals';
import builtins from 'rollup-plugin-node-builtins';

const onwarn = (warning) => {
  if (warning.code === 'CIRCULAR_DEPENDENCY') return;
  console.warn(`(!) ${warning.message}`);
};

const plugins = [
  nodeResolve({ browser: true, preferBuiltins: false }),
  commonjs(),
  json(),
  typescript({ tsconfig: './tsconfig.json' }),
  terser(),
  globals({
    dirname: false,
    filename: false,
    // @openmaic/dsl ships browser-safe ES2022 and never needs Node global
    // shims. This plugin re-parses any module mentioning `global`/`process`
    // with an old acorn that predates `??`, so keep it off the dsl build.
    exclude: [/[\\/]@openmaic[\\/]dsl[\\/]dist[\\/]/],
  }),
  builtins(),
];

const createConfig = (output) => ({
  input: 'src/index.ts',
  onwarn,
  output: { ...output, inlineDynamicImports: true },
  plugins,
});

export default [
  createConfig({ file: 'dist/index.umd.js', format: 'umd', name: 'pptxtojsonPro' }),
  createConfig({ file: 'dist/index.cjs', format: 'cjs' }),
  createConfig({ file: 'dist/index.js', format: 'es' }),
];
