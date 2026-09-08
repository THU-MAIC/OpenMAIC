import { writeSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { backupTeacherLocal, restoreTeacherLocal } from '@/scripts/teacher-local-backup.mjs';
import { teacherLocalEnvironment } from '@/scripts/setup-teacher-local.mjs';

const CONTAINER = 'a'.repeat(64);
const FIXTURE_ARCHIVE = Buffer.from('PGDMPfictional-test-archive');

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'teacher-backup-fixture-'));
  await writeFile(
    join(workspace, '.env.local'),
    teacherLocalEnvironment(55432, 'a'.repeat(48), 'b'.repeat(48)),
  );
  const directory = join(workspace, 'data', 'teacher-backups');
  await mkdir(directory, { recursive: true });
  return { workspace, directory };
}

function dockerFixture() {
  return vi.fn(
    async (
      args: string[],
      options: { outputFd?: number; inputFd?: number; cwd: string; timeout?: number },
    ) => {
      if (args[0] === 'compose') return CONTAINER;
      if (args[0] === 'container') {
        return JSON.stringify({
          'com.docker.compose.project': 'openmaic-teacher-local',
          'com.docker.compose.service': 'postgres',
        });
      }
      if (args.includes('pg_dump')) writeSync(options.outputFd!, FIXTURE_ARCHIVE);
      return '';
    },
  );
}

describe('local teacher database backup', () => {
  it('streams a custom archive into the ignored directory without credentials in command arguments', async () => {
    const { workspace, directory } = await fixture();
    const runDocker = dockerFixture();
    const result = await backupTeacherLocal(workspace, { runDocker });

    expect(result.file.startsWith(directory)).toBe(true);
    expect(await readFile(result.file)).toEqual(FIXTURE_ARCHIVE);
    const calls = runDocker.mock.calls;
    expect(calls[0]![0]).toContain('openmaic-teacher-local');
    expect(calls[1]![0]).toEqual([
      'container',
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      CONTAINER,
    ]);
    expect(calls[2]![0]).toEqual([
      'exec',
      CONTAINER,
      'pg_dump',
      '--username=openmaic',
      '--dbname=openmaic',
      '--format=custom',
      '--no-owner',
      '--no-acl',
    ]);
    expect(calls[2]![1].outputFd).toEqual(expect.any(Number));
    expect(JSON.stringify(calls.map(([args]) => args))).not.toContain('postgres://');
    expect(JSON.stringify(calls.map(([args]) => args))).not.toContain('a'.repeat(48) + '@');
  });

  it('does not overwrite an existing backup', async () => {
    const { workspace, directory } = await fixture();
    const existing = join(directory, 'fixture.dump');
    await writeFile(existing, 'preserve-existing-fixture');
    const runDocker = dockerFixture();

    await expect(
      backupTeacherLocal(workspace, { runDocker, backupName: 'fixture.dump' }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(existing, 'utf8')).toBe('preserve-existing-fixture');
    expect(runDocker.mock.calls.some(([args]) => args.includes('pg_dump'))).toBe(false);
  });

  it('removes its incomplete file after a failed dump and does not expose database errors', async () => {
    const { workspace, directory } = await fixture();
    const runDocker = dockerFixture();
    const defaultRun = runDocker.getMockImplementation()!;
    runDocker.mockImplementation(async (args, options) => {
      if (args.includes('pg_dump')) {
        writeSync(options.outputFd!, FIXTURE_ARCHIVE);
        throw new Error('fictional-secret-and-student-row');
      }
      return defaultRun(args, options);
    });

    await expect(backupTeacherLocal(workspace, { runDocker })).rejects.toThrow(
      'incomplete archive was removed',
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it('removes non-archive command output instead of reporting a successful backup', async () => {
    const { workspace, directory } = await fixture();
    const runDocker = dockerFixture();
    const defaultRun = runDocker.getMockImplementation()!;
    runDocker.mockImplementation(async (args, options) => {
      if (args.includes('pg_dump')) return '';
      return defaultRun(args, options);
    });

    await expect(backupTeacherLocal(workspace, { runDocker })).rejects.toThrow('Backup failed');
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['other-project', ''])('rejects a container belonging to %s', async (project) => {
    const { workspace } = await fixture();
    const runDocker = dockerFixture();
    runDocker.mockResolvedValueOnce(CONTAINER).mockResolvedValueOnce(
      JSON.stringify({
        'com.docker.compose.project': project,
        'com.docker.compose.service': 'postgres',
      }),
    );

    await expect(backupTeacherLocal(workspace, { runDocker })).rejects.toThrow('does not belong');
    expect(runDocker).toHaveBeenCalledTimes(2);
  });

  it.each(['', `${CONTAINER}\n${CONTAINER}`, 'unexpected-container'])(
    'refuses an ambiguous or absent target',
    async (container) => {
      const { workspace } = await fixture();
      const runDocker = dockerFixture().mockResolvedValueOnce(container);

      await expect(backupTeacherLocal(workspace, { runDocker })).rejects.toThrow('Exactly one');
      expect(runDocker).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves configurations for unrelated deployments without invoking Docker', async () => {
    const { workspace } = await fixture();
    const configuration = 'DATABASE_URL=postgres://fictional-remote-deployment\n';
    await writeFile(join(workspace, '.env.local'), configuration);
    const runDocker = dockerFixture();

    await expect(backupTeacherLocal(workspace, { runDocker })).rejects.toThrow(
      'matching teacher:setup',
    );
    expect(runDocker).not.toHaveBeenCalled();
    expect(await readFile(join(workspace, '.env.local'), 'utf8')).toBe(configuration);
  });

  it('rejects an external database URL even when the setup marker exists', async () => {
    const { workspace } = await fixture();
    const configuration = teacherLocalEnvironment(55432, 'a'.repeat(48), 'b'.repeat(48)).replace(
      '127.0.0.1',
      'database.example',
    );
    await writeFile(join(workspace, '.env.local'), configuration);
    const runDocker = dockerFixture();

    await expect(backupTeacherLocal(workspace, { runDocker })).rejects.toThrow(
      'matching teacher:setup',
    );
    expect(runDocker).not.toHaveBeenCalled();
  });

  it('refuses a backup directory junction outside the workspace', async () => {
    const { workspace } = await fixture();
    const external = await mkdtemp(join(tmpdir(), 'teacher-backup-external-fixture-'));
    const junctionWorkspace = join(workspace, 'junction-fixture');
    await mkdir(junctionWorkspace);
    await writeFile(
      join(junctionWorkspace, '.env.local'),
      teacherLocalEnvironment(55432, 'a'.repeat(48), 'b'.repeat(48)),
    );
    await symlink(external, join(junctionWorkspace, 'data'), 'junction');

    await expect(
      backupTeacherLocal(junctionWorkspace, { runDocker: dockerFixture() }),
    ).rejects.toThrow('real directories');
    expect(await readdir(external)).toEqual([]);
  });
});

describe('local teacher database restore', () => {
  it('requires explicit replacement authorization before reading files or calling Docker', async () => {
    const runDocker = dockerFixture();

    await expect(
      restoreTeacherLocal('missing-workspace', 'anything.dump', { runDocker }),
    ).rejects.toThrow('--replace');
    expect(runDocker).not.toHaveBeenCalled();
  });

  it('targets the verified container and restores in one transaction without database creation', async () => {
    const { workspace, directory } = await fixture();
    await writeFile(join(directory, 'fixture.dump'), FIXTURE_ARCHIVE);
    const runDocker = dockerFixture();

    await expect(
      restoreTeacherLocal(workspace, 'data/teacher-backups/fixture.dump', {
        replace: true,
        runDocker,
      }),
    ).resolves.toEqual({ restored: true });
    expect(runDocker.mock.calls[2]![0]).toEqual([
      'exec',
      '-i',
      CONTAINER,
      'pg_restore',
      '--username=openmaic',
      '--dbname=openmaic',
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '--single-transaction',
      '--exit-on-error',
    ]);
    expect(runDocker.mock.calls[2]![1].inputFd).toEqual(expect.any(Number));
    expect(await readFile(join(directory, 'fixture.dump'))).toEqual(FIXTURE_ARCHIVE);
  });

  it.each([
    '../outside.dump',
    '.env.local',
    'data/teacher-backups/../outside.dump',
    'data/teacher-backups/not-an-archive.txt',
  ])('rejects a path outside the dedicated archive directory: %s', async (file) => {
    const { workspace } = await fixture();
    const runDocker = dockerFixture();

    await expect(
      restoreTeacherLocal(workspace, file, { replace: true, runDocker }),
    ).rejects.toThrow('directly inside');
    expect(runDocker).not.toHaveBeenCalled();
  });

  it('rejects invalid archive content before touching the database', async () => {
    const { workspace, directory } = await fixture();
    await writeFile(join(directory, 'fixture.dump'), 'fictional non-archive data');
    const runDocker = dockerFixture();

    await expect(
      restoreTeacherLocal(workspace, 'data/teacher-backups/fixture.dump', {
        replace: true,
        runDocker,
      }),
    ).rejects.toThrow('not a PostgreSQL custom archive');
    expect(runDocker).not.toHaveBeenCalled();
  });
});
