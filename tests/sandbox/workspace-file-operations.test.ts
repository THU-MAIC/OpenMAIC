import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
vi.mock('server-only', () => ({}));
import { WORKSPACE_FILE_RUNNER } from '@/lib/server/sandbox/workspace-archive';
const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pbl-files-'));
  roots.push(root);
  const project = join(root, 'project');
  await mkdir(project);
  const runner = WORKSPACE_FILE_RUNNER.replace(
    "root='/home/user/project'",
    `root=${JSON.stringify(project)}`,
  );
  let sequence = 0;
  const run = async (action: string, path: string, spec: Record<string, unknown> = {}) => {
    const transfer = join(root, `request-${sequence++}`);
    await writeFile(transfer, JSON.stringify(spec));
    return promisify(execFile)('python3', [
      '-c',
      runner,
      action,
      Buffer.from(path).toString('base64'),
      transfer,
    ]);
  };
  const readMany = async (paths: string[]) => {
    const transfer = join(root, `batch-${sequence++}`);
    await writeFile(transfer + '.paths', JSON.stringify(paths));
    await promisify(execFile)('python3', ['-c', runner, 'read_many', 'eA==', transfer]);
    return JSON.parse(await readFile(transfer, 'utf8'));
  };
  return { root, project, run, readMany };
}
it('creates, moves and deletes nested text files without overwriting existing files', async () => {
  const { project, run } = await fixture();
  await run('create', 'src/one.py', { text: 'hello' });
  await expect(run('create', 'src/one.py', { text: 'overwrite' })).rejects.toMatchObject({
    code: 47,
  });
  await expect(
    run('rename', 'src/one.py', { destination: 'src/two.py', expectedHash: hash('stale') }),
  ).rejects.toMatchObject({ code: 47 });
  await run('rename', 'src/one.py', {
    destination: 'src/nested/two.py',
    expectedHash: hash('hello'),
  });
  expect(await readFile(join(project, 'src/nested/two.py'), 'utf8')).toBe('hello');
  await run('create', 'src/occupied.py', { text: 'keep' });
  await expect(
    run('rename', 'src/nested/two.py', {
      destination: 'src/occupied.py',
      expectedHash: hash('hello'),
    }),
  ).rejects.toMatchObject({ code: 47 });
  await run('delete', 'src/nested/two.py', { expectedHash: hash('hello') });
  await expect(readFile(join(project, 'src/nested/two.py'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(join(project, 'src/occupied.py'), 'utf8')).toBe('keep');
});
it('rejects symlink ancestors, symlink files and multiply linked sources', async () => {
  const { root, project, run } = await fixture();
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.py'), 'keep');
  await symlink(outside, join(project, 'escape'));
  await expect(run('create', 'escape/new.py', { text: 'bad' })).rejects.toMatchObject({ code: 46 });
  await symlink(join(outside, 'keep.py'), join(project, 'linked.py'));
  await expect(run('delete', 'linked.py', { expectedHash: hash('keep') })).rejects.toMatchObject({
    code: 46,
  });
  await link(join(outside, 'keep.py'), join(project, 'hard.py'));
  await expect(
    run('rename', 'hard.py', { destination: 'new.py', expectedHash: hash('keep') }),
  ).rejects.toMatchObject({ code: 46 });
  await run('create', 'normal.py', { text: 'normal' });
  await expect(
    run('rename', 'normal.py', { destination: 'escape/changed.py', expectedHash: hash('normal') }),
  ).rejects.toMatchObject({ code: 46 });
  expect(await readFile(join(outside, 'keep.py'), 'utf8')).toBe('keep');
});

it('reads an ordered UTF-8 source snapshot and preserves repeated text in separate files', async () => {
  const { run, readMany } = await fixture();
  await run('create', 'src/one.py', { text: '中文\nprint("same")' });
  await run('create', 'src/two.py', { text: '中文\nprint("same")' });
  expect(await readMany(['src/one.py', 'src/two.py'])).toEqual({
    'src/one.py': '中文\nprint("same")',
    'src/two.py': '中文\nprint("same")',
  });
});
it('bounds the complete snapshot by UTF-8 bytes, not a per-file or character allowance', async () => {
  const { run, readMany } = await fixture();
  const first = '中'.repeat(174762); // 524286 bytes
  await run('create', 'one.py', { text: first });
  await run('create', 'two.py', { text: 'x'.repeat(524290) });
  expect(Object.values(await readMany(['one.py', 'two.py'])).join('')).toHaveLength(
    first.length + 524290,
  );
  await run('create', 'three.py', { text: 'x' });
  await expect(readMany(['one.py', 'two.py', 'three.py'])).rejects.toMatchObject({ code: 48 });
});
it('refuses missing, linked, non-UTF8 and escaping members rather than returning partial history', async () => {
  const { root, project, run, readMany } = await fixture();
  await run('create', 'valid.py', { text: 'keep' });
  await expect(readMany(['valid.py', 'missing.py'])).rejects.toMatchObject({ code: 44 });
  await expect(readMany(['../outside.py'])).rejects.toMatchObject({ code: 46 });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'file.py'), 'outside');
  await symlink(outside, join(project, 'escape'));
  await expect(readMany(['escape/file.py'])).rejects.toMatchObject({ code: 46 });
  await symlink(join(outside, 'file.py'), join(project, 'linked.py'));
  await expect(readMany(['linked.py'])).rejects.toMatchObject({ code: 46 });
  await link(join(outside, 'file.py'), join(project, 'hard.py'));
  await expect(readMany(['hard.py'])).rejects.toMatchObject({ code: 46 });
  await writeFile(join(project, 'bad.py'), Buffer.from([255]));
  await expect(readMany(['bad.py'])).rejects.toMatchObject({ code: 45 });
  await expect(readMany(['valid.py', 'valid.py'])).rejects.toMatchObject({ code: 46 });
  await expect(readMany(Array.from({ length: 257 }, (_, i) => `${i}.py`))).rejects.toMatchObject({
    code: 46,
  });
  expect(await readFile(join(outside, 'file.py'), 'utf8')).toBe('outside');
});

it('keeps single-file UTF-8 BOM decoding semantics and accepts escaped control content at the source budget', async () => {
  const { run, readMany } = await fixture();
  await run('create', 'bom.md', { text: '\uFEFF说明' });
  expect(await readMany(['bom.md'])).toEqual({ 'bom.md': '说明' });
  await run('create', 'control.txt', { text: '\0'.repeat(1048576) });
  expect((await readMany(['control.txt']))['control.txt']).toHaveLength(1048576);
});
