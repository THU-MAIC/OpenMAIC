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

// Windows fix: plugins like @rollup/plugin-commonjs synthesize virtual modules
// (e.g. for `import.meta.url` in the emscripten jpegxr glue) whose content embeds
// a raw absolute path like `export default 'C:\Users\...'`. The backslashes are
// invalid escape sequences in strict mode, so rollup fails to parse the module.
// Escape them and normalize to forward slashes before rollup parses the module.
const fixWindowsPathStrings = () => ({
  name: 'fix-windows-path-strings',
  transform(code) {
    if (!code.includes('\\')) return null;
    let changed = false;
    const fixed = code.replace(/export default '([^'\n]*)'/g, (match, raw) => {
      if (!raw.includes('\\')) return match;
      changed = true;
      return `export default ${JSON.stringify(raw.replaceAll('\\', '/'))}`;
    });
    return changed ? { code: fixed, map: null } : null;
  },
});

const plugins = [
  nodeResolve({ browser: true, preferBuiltins: false }),
  commonjs(),
  fixWindowsPathStrings(),
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
