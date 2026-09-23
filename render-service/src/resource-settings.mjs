import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Both privileged readers must reject paths the worker can replace. */
export function readResourceSettings(input) {
  const path = resolve(input);
  const parents = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    parents.unshift(current);
    if (dirname(current) === current) break;
  }
  // Check from root downward before following a component or reading bytes.
  // Symlinks are deliberately rejected; root-controlled updates remain trusted.
  for (const current of [...parents, path]) {
    const stat = lstatSync(current);
    if (
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      (current === path ? !stat.isFile() : !stat.isDirectory())
    )
      throw new Error(
        'Resource settings and parent directories must be root-owned, non-writable by group/others, and not symlinks',
      );
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function assertCanonicalProjectRoot(path) {
  // join() already normalizes harmless spelling differences for task paths.
  if (!isAbsolute(path) || resolve(path) !== realpathSync(path))
    throw new Error(
      'PRODUCER_TMP_PROJECT_DIR must resolve to an absolute canonical path without symlinks',
    );
  if (!lstatSync(path).isDirectory())
    throw new Error('PRODUCER_TMP_PROJECT_DIR must be a directory');
}

export function assertRootOwnedDirectory(path, name = 'resource directory') {
  if (!isAbsolute(path) || resolve(path) !== realpathSync(path))
    throw new Error(`${name} must resolve to an absolute canonical path without symlinks`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
    throw new Error(`${name} must be a root-owned directory not writable by group or others`);
}

/** A task worker needs path traversal without directory listing or write access. */
export function assertRootOwnedWorkerTraversableDirectory(path, name = 'resource directory') {
  assertRootOwnedDirectory(path, name);
  const stat = lstatSync(path);
  if ((stat.mode & 0o001) === 0)
    throw new Error(`${name} must grant other-execute traversal to the unprivileged task worker`);
}

export function assertRootOwnedExecutable(path, name = 'resource executable') {
  if (!isAbsolute(path) || resolve(path) !== realpathSync(path))
    throw new Error(`${name} must resolve to an absolute canonical path without symlinks`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0)
    throw new Error(`${name} must be a root-owned executable not writable by group or others`);
}
