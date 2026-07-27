import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { changedFiles } from './changed-files.mjs';

const root = resolve(import.meta.dirname, '..');
const lintExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const files = changedFiles().filter((file) =>
  lintExtensions.has(file.slice(file.lastIndexOf('.'))),
);

if (files.length === 0) {
  console.log('ESLint: no supported changed files to check.');
  process.exit(0);
}

console.log(`ESLint: checking ${files.length} changed file(s).`);
const eslint = resolve(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'eslint.cmd' : 'eslint',
);
const result = spawnSync(eslint, ['--no-warn-ignored', ...files], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
