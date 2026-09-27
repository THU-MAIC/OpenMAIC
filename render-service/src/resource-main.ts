/** Opt-in bootstrap: start the resource owner, then run the HTTP service unprivileged. */
import { fork } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResourceClient } from './resource-client.js';
import { config } from './config.js';
import { availableMemoryBytes } from './resource-profile.js';
import {
  readResourceSettings,
  assertCanonicalProjectRoot,
  assertRootOwnedWorkerTraversableDirectory,
  assertRootOwnedExecutable,
} from './resource-settings.mjs';

if (process.platform !== 'linux' || process.getuid?.() !== 0)
  throw new Error('Resource bootstrap requires Linux root');
if (config.chunkExecutionEnabled)
  throw new Error('Budgeted rendering does not support chunk execution');
assertCanonicalProjectRoot(config.tmpDir);
const settingsPath = resolve(process.argv[2] ?? '');
const value = readResourceSettings(settingsPath);
if (
  typeof value !== 'object' ||
  value === null ||
  !('owner' in value) ||
  typeof value.owner !== 'object' ||
  value.owner === null ||
  !('projectRoot' in value) ||
  value.projectRoot !== resolve(config.tmpDir) ||
  !('stateRoot' in value) ||
  typeof value.stateRoot !== 'string'
)
  throw new Error('Resource config must bind the service project root');
const owner = value.owner;
if (
  !('workerUid' in owner) ||
  typeof owner.workerUid !== 'number' ||
  !Number.isSafeInteger(owner.workerUid) ||
  owner.workerUid <= 0 ||
  !('workerGid' in owner) ||
  typeof owner.workerGid !== 'number' ||
  !Number.isSafeInteger(owner.workerGid) ||
  owner.workerGid <= 0 ||
  !('taskPidsMax' in owner) ||
  typeof owner.taskPidsMax !== 'number' ||
  !Number.isSafeInteger(owner.taskPidsMax) ||
  owner.taskPidsMax <= 0 ||
  owner.taskPidsMax > 2_147_483_647 ||
  !('cleanupTimeoutMs' in owner) ||
  typeof owner.cleanupTimeoutMs !== 'number' ||
  !Number.isSafeInteger(owner.cleanupTimeoutMs) ||
  owner.cleanupTimeoutMs <= 0 ||
  owner.cleanupTimeoutMs > 60_000 ||
  !('browserPath' in owner) ||
  typeof owner.browserPath !== 'string' ||
  !('ffmpegPath' in owner) ||
  typeof owner.ffmpegPath !== 'string' ||
  !('task' in value) ||
  typeof value.task !== 'object' ||
  value.task === null ||
  !('cpuMillis' in value.task) ||
  typeof value.task.cpuMillis !== 'number' ||
  !Number.isSafeInteger(value.task.cpuMillis) ||
  value.task.cpuMillis <= 0 ||
  value.task.cpuMillis > 1_000_000 ||
  !('memoryBytes' in value.task) ||
  typeof value.task.memoryBytes !== 'number' ||
  !Number.isSafeInteger(value.task.memoryBytes) ||
  value.task.memoryBytes <= 0
)
  throw new Error('Invalid worker identity, tool path, task budget or cleanup bound');
if (lstatSync(config.tmpDir).uid !== owner.workerUid)
  throw new Error('Project root must already belong to the unprivileged service user');
assertRootOwnedWorkerTraversableDirectory(value.stateRoot, 'Resource state root');
assertRootOwnedExecutable(owner.browserPath, 'Resource browser');
assertRootOwnedExecutable(owner.ffmpegPath, 'Resource FFmpeg');
if (
  value.task.cpuMillis > availableParallelism() * 1000 ||
  value.task.memoryBytes > availableMemoryBytes()
)
  throw new Error('Per-task resource budget exceeds the effective service capacity');
if (readdirSync(value.stateRoot).length !== 0)
  throw new Error(
    'Resource state root is not empty; audit prior owner/task cleanup before restart',
  );
mkdirSync(join(value.stateRoot, 'owner.lock'), { mode: 0o700 });
const child = fork(
  fileURLToPath(new URL('./resource-owner.mjs', import.meta.url)),
  [resolve(settingsPath)],
  {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    execArgv: [],
  },
);
const executor = new ResourceClient(child, owner.cleanupTimeoutMs);
try {
  await executor.ready;
  process.setgroups!([]);
  process.setgid!(owner.workerGid);
  process.setuid!(owner.workerUid);
  process.env.HOME = process.env.RENDER_HOME || config.tmpDir;
  process.env.XDG_CACHE_HOME = join(process.env.HOME, '.cache');

  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      void executor.close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
  process.env.RENDER_SERVICE_NO_LISTEN = 'true';
  const { startService } = await import('./main.js');
  await startService(executor);
} catch (error) {
  await executor.close().catch(() => {});
  throw error;
}
