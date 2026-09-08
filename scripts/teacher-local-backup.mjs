import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const PROJECT = 'openmaic-teacher-local';
const ARCHIVE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.dump$/;
const COMPOSE_ARGS = [
  'compose',
  '--project-name',
  PROJECT,
  '--env-file',
  '.env.local',
  '-f',
  'docker-compose.yml',
  '-f',
  'configs/teacher-local.compose.yml',
  '--profile',
  'server-persistence',
];

/** Docker output may contain connection details or row data; never print failures verbatim. */
export function runTeacherDocker(args, { cwd, inputFd, outputFd, timeout = 15000 }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('docker', args, {
      cwd,
      stdio: [inputFd ?? 'ignore', outputFd ?? 'pipe', 'ignore'],
      windowsHide: true,
      timeout,
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 65536) child.kill();
    });
    child.on('error', () => reject(new Error('The local database command could not run.')));
    child.on('close', (code) => {
      if (code === 0 && stdout.length <= 65536) resolveResult(stdout.trim());
      else reject(new Error('The local database command failed. Check Docker Desktop and retry.'));
    });
  });
}

async function verifyLocalConfiguration(workspace) {
  let values;
  try {
    values = parseEnv(await readFile(join(workspace, '.env.local'), 'utf8'));
    const database = new URL(values.DATABASE_URL ?? '');
    const port = Number(values.TEACHER_POSTGRES_PORT);
    if (
      values.OPENMAIC_TEACHER_LOCAL_SETUP !== '1' ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      database.hostname !== '127.0.0.1' ||
      Number(database.port) !== port ||
      database.username !== 'openmaic' ||
      database.pathname !== '/openmaic' ||
      !values.PERSISTENCE_POSTGRES_PASSWORD ||
      database.password !== values.PERSISTENCE_POSTGRES_PASSWORD ||
      database.search ||
      database.hash
    ) {
      throw new Error('Invalid local deployment');
    }
  } catch {
    throw new Error(
      'A matching teacher:setup local deployment is required. Configuration was preserved.',
    );
  }
}

async function localContainer(workspace, runDocker) {
  await verifyLocalConfiguration(workspace);
  const container = await runDocker(
    [...COMPOSE_ARGS, 'ps', '--status', 'running', '-q', 'postgres'],
    { cwd: workspace },
  );
  if (!/^[a-f0-9]{12,64}$/.test(container)) {
    throw new Error('Exactly one running teacher-local PostgreSQL container is required.');
  }
  let labels;
  try {
    labels = JSON.parse(
      await runDocker(['container', 'inspect', '--format', '{{json .Config.Labels}}', container], {
        cwd: workspace,
      }),
    );
  } catch {
    throw new Error('The teacher-local PostgreSQL container could not be verified.');
  }
  if (
    labels?.['com.docker.compose.project'] !== PROJECT ||
    labels?.['com.docker.compose.service'] !== 'postgres'
  ) {
    throw new Error('The container does not belong to the teacher-local PostgreSQL deployment.');
  }
  return container;
}

async function backupDirectory(workspace, create) {
  const root = await realpath(workspace);
  let directory = root;
  for (const name of ['data', 'teacher-backups']) {
    directory = join(directory, name);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Backup directories must be real directories inside the workspace.');
    }
  }
  return directory;
}

async function verifyArchive(file) {
  const header = Buffer.alloc(5);
  const { bytesRead } = await file.read(header, 0, header.length, 0);
  if (bytesRead !== 5 || header.toString('ascii') !== 'PGDMP' || (await file.stat()).size <= 5) {
    throw new Error('The file is not a PostgreSQL custom archive.');
  }
}

/** @param {string} workspace
 * @param {{runDocker?: typeof runTeacherDocker, backupName?: string}} [options]
 */
export async function backupTeacherLocal(
  workspace,
  { runDocker = runTeacherDocker, backupName } = {},
) {
  const name =
    backupName ??
    `teacher-local-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.dump`;
  if (!ARCHIVE_NAME.test(name)) throw new Error('Use a plain .dump backup filename.');
  const container = await localContainer(workspace, runDocker);
  const directory = await backupDirectory(workspace, true);
  const target = join(directory, name);
  const file = await open(target, 'wx+', 0o600);
  try {
    await runDocker(
      [
        'exec',
        container,
        'pg_dump',
        '--username=openmaic',
        '--dbname=openmaic',
        '--format=custom',
        '--no-owner',
        '--no-acl',
      ],
      { cwd: workspace, outputFd: file.fd, timeout: 600000 },
    );
    await verifyArchive(file);
    await file.sync();
  } catch {
    await file.close();
    await unlink(target);
    throw new Error(
      'Backup failed; the incomplete archive was removed. Existing backups were preserved.',
    );
  }
  await file.close();
  return { file: target };
}

export async function restoreTeacherLocal(
  workspace,
  archivePath,
  { replace = false, runDocker = runTeacherDocker } = {},
) {
  if (!replace)
    throw new Error('Restore replaces stored records. Pass --replace explicitly to proceed.');
  if (typeof archivePath !== 'string' || !archivePath)
    throw new Error('Choose a backup with --file.');
  const directory = await backupDirectory(workspace, false);
  const target = resolve(workspace, archivePath);
  if (relative(directory, target) !== basename(target) || !ARCHIVE_NAME.test(basename(target))) {
    throw new Error('Restore only accepts .dump files directly inside data/teacher-backups.');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Restore requires a regular archive file.');
  const file = await open(target, 'r');
  try {
    await verifyArchive(file);
    const container = await localContainer(workspace, runDocker);
    await runDocker(
      [
        'exec',
        '-i',
        container,
        'pg_restore',
        '--username=openmaic',
        '--dbname=openmaic',
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-acl',
        '--single-transaction',
        '--exit-on-error',
      ],
      { cwd: workspace, inputFd: file.fd, timeout: 600000 },
    );
  } finally {
    await file.close();
  }
  return { restored: true };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { file: { type: 'string' }, replace: { type: 'boolean', default: false } },
  });
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (positionals.length === 1 && positionals[0] === 'backup' && !values.file && !values.replace) {
    const { file } = await backupTeacherLocal(workspace);
    console.log(`Database backup created: ${relative(workspace, file)}`);
    return;
  }
  if (positionals.length === 1 && positionals[0] === 'restore') {
    await restoreTeacherLocal(workspace, values.file, { replace: values.replace });
    console.log('Teacher-local database restored. Restart the application before continuing.');
    return;
  }
  throw new Error('Use backup, or restore --file data/teacher-backups/<archive>.dump --replace.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Local database backup operation failed.',
    );
    process.exitCode = 1;
  });
}
