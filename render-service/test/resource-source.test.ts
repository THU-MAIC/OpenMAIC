import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { restoreArchiveSource } from '../scripts/resource-source.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'resource-source-test-'));
  roots.push(root);
  const original = join(root, 'original');
  const archive = join(root, 'archive');
  const checkout = join(root, 'checkout');
  for (const p of [original, archive, checkout]) mkdirSync(p);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: original, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--template=');
  writeFileSync(join(original, 'worker'), 'worker\n');
  chmodSync(join(original, 'worker'), 0o755);
  writeFileSync(join(original, '.gitignore'), 'tracked-but-ignored\n');
  writeFileSync(join(original, '.gitattributes'), '* text=auto eol=lf\n');
  writeFileSync(join(original, 'tracked-but-ignored'), 'required\n');
  symlinkSync('worker', join(original, 'link'));
  git('add', '-f', '--all');
  const tree = git('write-tree');
  const commit = Buffer.from(
    `tree ${tree}\nauthor Test <test@example.invalid> 1 +0000\ncommitter Test <test@example.invalid> 1 +0000\n\npinned\n`,
  );
  const revision = createHash('sha1')
    .update(`commit ${commit.length}\0`)
    .update(commit)
    .digest('hex');
  const tar = execFileSync('git', ['archive', tree], { cwd: original });
  execFileSync('tar', ['-xf', '-', '-C', archive], { input: tar });
  return { root, archive, checkout, commit, revision, tree };
}
it('restores exact commit identity, executable bits, symlinks and ignored tracked files', () => {
  const f = fixture();
  expect(restoreArchiveSource(f.archive, f.checkout, f.commit, f.revision)).toEqual({
    revision: f.revision,
    tree: f.tree,
  });
  expect(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.checkout, encoding: 'utf8' }).trim(),
  ).toBe(f.revision);
  expect(
    execFileSync('git', ['status', '--porcelain'], { cwd: f.checkout, encoding: 'utf8' }),
  ).toBe('');
  expect(readFileSync(join(f.checkout, 'tracked-but-ignored'), 'utf8')).toBe('required\n');
});
it.each(['content', 'missing', 'extra', 'mode', 'link', 'crlf'])(
  'rejects archive %s drift before build',
  (kind) => {
    const f = fixture();
    if (kind === 'content') writeFileSync(join(f.archive, 'worker'), 'changed\n');
    if (kind === 'missing') rmSync(join(f.archive, 'tracked-but-ignored'));
    if (kind === 'extra') writeFileSync(join(f.archive, 'extra'), 'extra');
    if (kind === 'mode') chmodSync(join(f.archive, 'worker'), 0o644);
    if (kind === 'link') {
      rmSync(join(f.archive, 'link'));
      symlinkSync('other', join(f.archive, 'link'));
    }
    if (kind === 'crlf') writeFileSync(join(f.archive, 'worker'), 'worker\r\n');
    expect(() => restoreArchiveSource(f.archive, f.checkout, f.commit, f.revision)).toThrow(
      'tree identity mismatch',
    );
  },
);
it('rejects embedded Git metadata and a commit object from a different revision', () => {
  const f = fixture();
  expect(() =>
    restoreArchiveSource(f.archive, f.checkout, Buffer.from('wrong'), f.revision),
  ).toThrow('commit object identity');
  mkdirSync(join(f.archive, '.git'));
  expect(() => restoreArchiveSource(f.archive, f.checkout, f.commit, f.revision)).toThrow(
    'Git metadata',
  );
});
