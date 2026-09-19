import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Restore an extracted archive to the exact pinned Git commit, without fetching.
 * The caller owns a fresh temporary checkout and removes it on every exit.
 */
export function restoreArchiveSource(source, checkout, commit, revision) {
  const objectId = createHash('sha1')
    .update(`commit ${commit.length}\0`)
    .update(commit)
    .digest('hex');
  if (objectId !== revision) throw new Error('Upstream commit object identity mismatch');
  const tree = /^tree ([a-f0-9]{40})\n/.exec(commit.toString())?.[1];
  if (!tree) throw new Error('Missing upstream tree identity');
  function inspect(directory) {
    for (const name of readdirSync(directory)) {
      if (name.toLowerCase() === '.git') throw new Error('Archive must not contain Git metadata');
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) inspect(path);
      else if (!stat.isFile() && !stat.isSymbolicLink())
        throw new Error(`Unsupported archive entry: ${path}`);
    }
  }
  inspect(source);
  cpSync(source, checkout, { recursive: true, dereference: false, verbatimSymlinks: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
  });
  const git = (args, input) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: checkout,
      env,
      input,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  git(['init', '--quiet', '--template=']);
  git(['config', 'core.fileMode', 'true']);
  git(['config', 'core.symlinks', 'true']);
  // Hash raw archive bytes, not normalized text or locally configured filters.
  mkdirSync(join(checkout, '.git/info'), { recursive: true });
  writeFileSync(
    join(checkout, '.git/info/attributes'),
    '* -text -filter -ident -working-tree-encoding\n',
  );
  git(['add', '--force', '--all', '--', '.']);
  if (git(['write-tree']) !== tree)
    throw new Error('Archive tree identity mismatch (content, paths, modes or links)');
  if (git(['hash-object', '-t', 'commit', '-w', '--stdin'], commit) !== revision)
    throw new Error('Restored commit identity mismatch');
  // Parent commits are intentionally absent, exactly as in a shallow clone.
  writeFileSync(join(checkout, '.git/shallow'), revision + '\n');
  git(['update-ref', 'HEAD', revision]);
  return { revision, tree };
}
