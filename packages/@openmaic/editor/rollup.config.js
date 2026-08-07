import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import preserveDirectives from 'rollup-plugin-preserve-directives';

const external = [
  /^@openmaic\/dsl($|\/)/,
  /^@openmaic\/renderer($|\/)/,
  /^react($|\/)/,
  /^react-dom($|\/)/,
  /^motion($|\/)/,
  /^katex($|\/)/,
  /^lucide-react($|\/)/,
  /^react-colorful($|\/)/,
  /^prosemirror-/,
];

const onwarn = (warning) => {
  if (warning.code === 'CIRCULAR_DEPENDENCY') return;
  if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
  console.warn(`(!) ${warning.message}`);
};

export default {
  input: {
    'core/index': 'src/core/index.ts',
    'react/index': 'src/react/index.ts',
    'ui/index': 'src/ui/index.ts',
  },
  external,
  onwarn,
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
    commonjs(),
    typescript({
      tsconfig: './tsconfig.json',
      declaration: false,
      declarationMap: false,
      rootDir: 'src',
    }),
    preserveDirectives(),
  ],
};
