import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
vi.mock('server-only', () => ({}));
import { CHECKPOINT_RUNNER } from '@/lib/server/sandbox/checkpoint-runner';
import { checkpointPolicy, type CheckpointPolicy } from '@/lib/server/sandbox/checkpoint-policy';
import { checkpointChunks } from '@/lib/server/sandbox/checkpoint-storage';
const directories: string[] = [];
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-test-')));
  directories.push(root);
  const project = join(root, 'project'),
    app = join(root, 'app');
  mkdirSync(project);
  mkdirSync(app);
  const config: CheckpointPolicy = {
    roots: [
      { name: 'project', path: project, excludes: ['node_modules'] },
      { name: 'app', path: app, excludes: [] },
    ],
    maxBytes: 40 * 1024 ** 2,
    maxFiles: 1000,
  };
  const archive = join(root, 'snapshot.tar');
  function run(action: string, file = archive) {
    const digest =
      action === 'import' ? createHash('sha256').update(readFileSync(file)).digest('hex') : '';
    return execFileSync(
      'python3',
      [
        '-c',
        CHECKPOINT_RUNNER,
        action,
        file,
        Buffer.from(JSON.stringify(config)).toString('base64'),
        digest,
      ],
      { stdio: 'pipe' },
    );
  }
  return { root, project, app, config, archive, run };
}
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe('streamed checkpoint archive', () => {
  it('roundtrips >16 MiB, application settings, empty directories and executable files deterministically', () => {
    const x = setup();
    const data = Buffer.alloc(18 * 1024 ** 2, 137);
    writeFileSync(join(x.project, 'large.bin'), data);
    mkdirSync(join(x.project, 'empty'));
    writeFileSync(join(x.project, 'run'), '#!/bin/sh\necho ok\n', { mode: 0o700 });
    writeFileSync(join(x.app, 'settings.json'), '{"theme":"dark"}');
    mkdirSync(join(x.project, 'node_modules'));
    writeFileSync(join(x.project, 'node_modules', 'excluded'), 'excluded');
    x.run('export');
    const first = readFileSync(x.archive);
    rmSync(x.project, { recursive: true });
    rmSync(x.app, { recursive: true });
    mkdirSync(x.app);
    writeFileSync(join(x.app, 'settings.json'), 'template defaults');
    x.run('import');
    x.run('import');
    expect(readFileSync(join(x.project, 'large.bin')).equals(data)).toBe(true);
    expect(readFileSync(join(x.app, 'settings.json'), 'utf8')).toContain('dark');
    expect(statSync(join(x.project, 'empty')).isDirectory()).toBe(true);
    expect(statSync(join(x.project, 'run')).mode & 0o111).not.toBe(0);
    const second = join(x.root, 'second.tar');
    x.run('export', second);
    expect(readFileSync(second).equals(first)).toBe(true);
  }, 20000);
  it('rejects links and configured size overflow', () => {
    const x = setup();
    symlinkSync('/etc/passwd', join(x.project, 'outside'));
    try {
      x.run('export');
      throw new Error('Expected export failure');
    } catch (error) {
      expect((error as { stderr: Buffer }).stderr.toString()).toBe(
        'OPENMAIC_CHECKPOINT_ERROR:unsupported\n',
      );
    }
    rmSync(join(x.project, 'outside'));
    x.config.maxBytes = 2;
    writeFileSync(join(x.project, 'large'), '123');
    try {
      x.run('export');
      throw new Error('Expected export failure');
    } catch (error) {
      expect((error as { stderr: Buffer }).stderr.toString()).toBe(
        'OPENMAIC_CHECKPOINT_ERROR:limit\n',
      );
    }
  });
  it('validates the whole archive before touching original application data', () => {
    const x = setup();
    writeFileSync(join(x.app, 'settings'), 'original');
    execFileSync('python3', [
      '-c',
      String.raw`
import tarfile,io,sys
with tarfile.open(sys.argv[1],'w') as t:
    for p in ['project','app']:
        i=tarfile.TarInfo(p);i.type=tarfile.DIRTYPE;t.addfile(i)
    i=tarfile.TarInfo('app/settings');i.size=3;t.addfile(i,io.BytesIO(b'new'))
    i=tarfile.TarInfo('app/../../escape');i.size=4;t.addfile(i,io.BytesIO(b'evil'))
`,
      x.archive,
    ]);
    expect(() => x.run('import')).toThrow();
    expect(readFileSync(join(x.app, 'settings'), 'utf8')).toBe('original');
  });
  it('refuses to overwrite an unrelated populated project', () => {
    const x = setup();
    writeFileSync(join(x.project, 'file'), 'before');
    x.run('export');
    writeFileSync(join(x.project, 'file'), 'after');
    expect(() => x.run('import')).toThrow();
    expect(readFileSync(join(x.project, 'file'), 'utf8')).toBe('after');
  });
  it('emits bounded chunks and checks aggregate size', async () => {
    const source = async function* () {
      yield Buffer.alloc(9 * 1024 ** 2, 1);
      yield Buffer.alloc(10, 2);
    };
    const chunks = [];
    for await (const c of checkpointChunks(source(), 10 * 1024 ** 2)) chunks.push(c);
    expect(chunks.map((c) => c.byteLength)).toEqual([8 * 1024 ** 2, 1024 ** 2 + 10]);
    await expect(
      (async () => {
        for await (const _ of checkpointChunks(source(), 100)) void _;
      })(),
    ).rejects.toThrow('limit');
  });
  it('restricts configured roots to disjoint paths under the sandbox user home', () => {
    expect(checkpointPolicy({}).maxBytes).toBe(256 * 1024 ** 2);
    for (const path of [
      '/etc',
      '/home/user',
      '/home/user/../secrets',
      '/home/user/project/nested',
      '/home/user/.openmaic-commands',
    ])
      expect(() =>
        checkpointPolicy({
          OPENMAIC_SANDBOX_CHECKPOINT_PATHS: JSON.stringify([{ name: 'app', path, excludes: [] }]),
        }),
      ).toThrow();
    expect(
      checkpointPolicy({
        OPENMAIC_SANDBOX_CHECKPOINT_PATHS:
          '[{"name":"app","path":"/home/user/.config/workbuddy","excludes":[]}]',
      }).roots,
    ).toHaveLength(2);
  });
});
