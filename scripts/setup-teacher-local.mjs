import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

export function teacherLocalEnvironment(port, password, token) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Choose a database port between 1024 and 65535.');
  }
  if (![password, token].every((value) => /^[a-f0-9]{48}$/.test(value))) {
    throw new Error('Local credentials must contain 24 random bytes.');
  }
  return [
    '# Local teacher workspace. Generated once; never commit this file.',
    'OPENMAIC_TEACHER_LOCAL_SETUP=1',
    `TEACHER_POSTGRES_PORT=${port}`,
    `PERSISTENCE_POSTGRES_PASSWORD=${password}`,
    `DATABASE_URL=postgres://openmaic:${password}@127.0.0.1:${port}/openmaic`,
    'OPENMAIC_AGENT_RUNTIME_ENABLED=true',
    'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=true',
    'NEXT_PUBLIC_MAIC_EDITOR_ENABLED=true',
    'NEXT_PUBLIC_PERSISTENCE=1',
    `PERSISTENCE_DEV_TOKEN=${token}`,
    `NEXT_PUBLIC_PERSISTENCE_TOKEN=${token}`,
    '',
  ].join('\n');
}

export async function ensureTeacherLocalConfig(workspace, port) {
  const envPath = resolve(workspace, '.env.local');
  try {
    const values = parseEnv(await readFile(envPath, 'utf8'));
    if (values.OPENMAIC_TEACHER_LOCAL_SETUP !== '1') {
      throw new Error(
        'An existing .env.local was preserved. Configure the existing deployment manually.',
      );
    }
    if (Number(values.TEACHER_POSTGRES_PORT) !== port) {
      throw new Error(
        'The existing local database uses a different port. Reuse its configured port.',
      );
    }
    return { created: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const text = teacherLocalEnvironment(
    port,
    randomBytes(24).toString('hex'),
    randomBytes(24).toString('hex'),
  );
  await writeFile(envPath, text, { flag: 'wx', mode: 0o600 });
  return { created: true };
}

async function main() {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '55432' } } });
  const port = Number(values.port);
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (docker.error || docker.status !== 0)
    throw new Error('Start Docker Desktop before local setup.');
  const { created } = await ensureTeacherLocalConfig(workspace, port);
  console.log(
    created ? 'Created private local configuration.' : 'Reusing existing local configuration.',
  );
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      'openmaic-teacher-local',
      '--env-file',
      '.env.local',
      '-f',
      'docker-compose.yml',
      '-f',
      'configs/teacher-local.compose.yml',
      '--profile',
      'server-persistence',
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '60',
      'postgres',
    ],
    { cwd: workspace, stdio: 'inherit', timeout: 120000, windowsHide: true },
  );
  if (result.error || result.status !== 0)
    throw new Error('The local database did not start. Configuration was preserved for retry.');
  console.log(`Database ready on 127.0.0.1:${port}. Start pnpm dev and open /teacher.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Local setup failed.');
    process.exitCode = 1;
  });
}
