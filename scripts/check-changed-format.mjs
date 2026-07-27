import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { changedFiles } from './changed-files.mjs';

const root = resolve(import.meta.dirname, '..');
const formatExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);
const files = changedFiles().filter((file) =>
  formatExtensions.has(file.slice(file.lastIndexOf('.'))),
);

if (files.length === 0) {
  console.log('Prettier: no supported changed files to check.');
  process.exit(0);
}

console.log(`Prettier: checking ${files.length} changed file(s).`);
const prettier = resolve(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prettier.cmd' : 'prettier',
);
const result = spawnSync(prettier, ['--check', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
