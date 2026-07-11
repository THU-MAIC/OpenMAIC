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
  globals(),
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
