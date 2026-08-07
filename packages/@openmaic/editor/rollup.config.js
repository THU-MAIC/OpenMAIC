import { nodeResolve } from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

export default {
  input: { 'core/index': 'src/core/index.ts' },
  external: [/^@openmaic\/dsl($|\/)/],
  output: {
    dir: 'dist',
    format: 'es',
    entryFileNames: '[name].js',
    preserveModules: true,
    preserveModulesRoot: 'src',
    sourcemap: true,
  },
  plugins: [
    nodeResolve({ preferBuiltins: false }),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: false,
      declarationMap: false,
      rootDir: 'src',
    }),
  ],
};
