import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanExternalReferences } from './resource-reference-scan.mjs';

const WORKER = fileURLToPath(new URL('./resource-task-worker.mjs', import.meta.url));
const STAGE_COPY = fileURLToPath(new URL('./resource-stage-copy.mjs', import.meta.url));
const MAX_TRANSFER_OUTPUT = 64 * 1024;
const MAX_ACCOUNTING_BYTES = 64 * 1024;
const ACCOUNTING_FILES = Object.freeze({
  memoryCurrent: 'memory.current',
  memoryEvents: 'memory.events',
  memoryEventsLocal: 'memory.events.local',
  cpuStat: 'cpu.stat',
  pidsCurrent: 'pids.current',
  pidsEvents: 'pids.events',
});

function bounded(value) {
  return String(value ?? '').slice(0, 4096);
}

function command(file, args) {
  execFileSync(file, args, { stdio: ['ignore', 'inherit', 'inherit'], timeout: 20_000 });
}

export function buildStageCopyArguments(config, candidate, stagePath) {
  return [
    `--reuid=${config.workerUid}`,
    `--regid=${config.workerGid}`,
    '--clear-groups',
    '--bounding-set=-all',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--no-new-privs',
    process.execPath,
    STAGE_COPY,
    candidate,
    stagePath,
    String(config.workerUid),
    String(config.workerGid),
  ];
}

/** Run the trusted byte copier only after setpriv has dropped all root authority. */
export async function transferCandidate(config, candidate, stagePath, dependencies = {}) {
  const launch = dependencies.spawn ?? spawn;
  const onChild = dependencies.onChild ?? (() => {});
  const child = launch('/usr/bin/setpriv', buildStageCopyArguments(config, candidate, stagePath), {
    // Keep pre-setpriv process setup on a trusted directory. The helper uses
    // absolute paths and resolves both worker-controlled paths only after uid
    // and capabilities have been dropped.
    cwd: '/',
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  onChild(child);
  let stdout = '';
  child.stdout?.on('data', (chunk) => {
    if (Buffer.byteLength(stdout) <= MAX_TRANSFER_OUTPUT) stdout += String(chunk);
  });
  const completion = await new Promise((resolveClose) => {
    let launchError;
    child.once('error', (error) => {
      launchError = bounded(error.message);
    });
    child.once('close', (code, signal) => resolveClose({ code, signal, error: launchError }));
  });
  onChild(undefined);
  if (Buffer.byteLength(stdout) > MAX_TRANSFER_OUTPUT)
    throw new Error('Stage copy returned oversized evidence');
  if (completion.error || completion.code !== 0)
    throw new Error(
      completion.error
        ? `Unprivileged stage copy failed: ${completion.error}`
        : `Unprivileged stage copy exited with ${completion.code ?? completion.signal ?? 'unknown status'}`,
    );
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error('Stage copy returned invalid evidence');
  }
  if (
    !result ||
    typeof result !== 'object' ||
    !Number.isSafeInteger(result.bytes) ||
    result.bytes <= 0 ||
    result.uid !== config.workerUid ||
    result.gid !== config.workerGid ||
    result.mode !== 0o600 ||
    !Number.isSafeInteger(result.sourceDevice) ||
    !Number.isSafeInteger(result.destinationDevice)
  )
    throw new Error('Stage copy evidence did not match the configured identity');
  if (result.sourceDevice === result.destinationDevice)
    throw new Error('Candidate and staging file are not on independent filesystems');
  return result;
}

function writeResult(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const fd = openSync(temporary, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function cgroupPath() {
  const row = readFileSync('/proc/self/cgroup', 'utf8')
    .split('\n')
    .find((line) => line.startsWith('0::'));
  if (!row) throw new Error('Unified cgroup membership is unavailable');
  return resolve('/sys/fs/cgroup', `.${row.slice(3)}`);
}

function cgroupPids(path) {
  try {
    return {
      pids: readFileSync(join(path, 'cgroup.procs'), 'utf8')
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    };
  } catch (error) {
    return {
      pids: [],
      readError: {
        code: error && typeof error === 'object' && 'code' in error ? String(error.code) : null,
        message: bounded(error instanceof Error ? error.message : error),
      },
    };
  }
}

/** Capture task-domain counters while this runner still keeps the cgroup alive. */
export function readTaskAccounting(path, dependencies = {}) {
  const readFile = dependencies.readFile ?? readFileSync;
  const measurements = {};
  const errors = {};
  for (const [field, file] of Object.entries(ACCOUNTING_FILES)) {
    try {
      const value = readFile(join(path, file), 'utf8');
      if (Buffer.byteLength(value) > MAX_ACCOUNTING_BYTES)
        throw new Error(`Oversized task accounting field: ${file}`);
      if (!value.trim()) throw new Error(`Empty task accounting field: ${file}`);
      measurements[field] = value.trim();
    } catch (error) {
      errors[field] = {
        ...(error && typeof error === 'object' && 'code' in error
          ? { code: bounded(error.code) }
          : {}),
        message: bounded(error instanceof Error ? error.message : error),
      };
    }
  }
  return {
    status: Object.keys(errors).length === 0 ? 'CAPTURED' : 'COLLECTION_FAILED',
    measurements,
    errors,
  };
}

async function pause(ms) {
  await new Promise((resolvePause) => setTimeout(resolvePause, ms));
}

async function drain(path, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let sentTerm = false;
  let sentKill = false;
  while (Date.now() < end) {
    const snapshot = cgroupPids(path);
    if (snapshot.readError) return { drained: false, remaining: [], readError: snapshot.readError };
    const others = snapshot.pids.filter((pid) => pid !== process.pid);
    if (others.length === 0) return { drained: true, remaining: [] };
    const elapsed = timeoutMs - (end - Date.now());
    if (!sentTerm) {
      for (const pid of others) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
      sentTerm = true;
    } else if (!sentKill && elapsed >= Math.floor(timeoutMs / 2)) {
      for (const pid of others) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      sentKill = true;
    }
    await pause(25);
  }
  const final = cgroupPids(path);
  return {
    drained: false,
    remaining: final.pids.filter((pid) => pid !== process.pid),
    ...(final.readError ? { readError: final.readError } : {}),
  };
}

function validateConfig(config) {
  const requiredStrings = [
    'id',
    'projectDir',
    'stagePath',
    'privateRoot',
    'resultPath',
    'browserPath',
    'ffmpegPath',
  ];
  if (requiredStrings.some((key) => typeof config[key] !== 'string' || !config[key]))
    throw new Error('Invalid task configuration');
  if (
    !Number.isSafeInteger(config.workerUid) ||
    !Number.isSafeInteger(config.workerGid) ||
    !Number.isSafeInteger(config.cleanupTimeoutMs) ||
    !Number.isSafeInteger(config.memoryBytes)
  )
    throw new Error('Invalid numeric task configuration');
  const project = realpathSync(config.projectDir);
  if (project !== config.projectDir || dirname(config.stagePath) !== project)
    throw new Error('Task paths escaped the project boundary');
  const projectIdentity = lstatSync(project);
  if (
    !projectIdentity.isDirectory() ||
    projectIdentity.uid !== config.workerUid ||
    !config.projectIdentity ||
    projectIdentity.dev !== config.projectIdentity.dev ||
    projectIdentity.ino !== config.projectIdentity.ino
  )
    throw new Error('Task project identity changed');
  for (const executable of [config.browserPath, config.ffmpegPath]) {
    if (!lstatSync(realpathSync(executable)).isFile())
      throw new Error('Configured tool is not a file');
  }
  const allowedProducerEnvironment = new Set([
    'PRODUCER_MAX_WORKERS',
    'PRODUCER_LOW_MEMORY_MODE',
    'PRODUCER_FORCE_SCREENSHOT',
    'PRODUCER_BROWSER_GPU_MODE',
    'PRODUCER_EXPECTED_CHROMIUM_MAJOR',
    'RENDER_REQUIRE_BEGINFRAME',
  ]);
  if (
    !config.producerEnvironment ||
    typeof config.producerEnvironment !== 'object' ||
    Object.entries(config.producerEnvironment).some(
      ([key, value]) => !allowedProducerEnvironment.has(key) || typeof value !== 'string',
    )
  )
    throw new Error('Invalid Producer environment');
  return projectIdentity;
}

/**
 * Execute the production closeout gates after the Producer worker exits.
 * Tests call this same function so deleting a drain, reference, transfer, or
 * unmount gate from the real task path is observable in-repository.
 */
export async function closeoutTask(
  {
    config,
    group,
    privateRoot,
    privateProject,
    candidate,
    workerExit,
    isStopping,
    projectMounted: initialProjectMounted,
    privateMounted: initialPrivateMounted,
  },
  dependencies = {},
) {
  const drainTask = dependencies.drain ?? drain;
  const scanReferences = dependencies.scanReferences ?? scanExternalReferences;
  const transfer = dependencies.transfer ?? transferCandidate;
  const runCommand = dependencies.command ?? command;
  const remove = dependencies.remove ?? rmSync;
  let projectMounted = initialProjectMounted;
  let privateMounted = initialPrivateMounted;
  let status = 'failed';
  let failureCode = 'execution_failed';
  let cleanupVerified = false;
  let referencesClear = false;
  const details = {};
  try {
    const drained = await drainTask(group, config.cleanupTimeoutMs);
    details.descendantDrain = drained;
    if (!drained.drained) throw new Error('Task descendants did not drain');

    const taskCgroup = group.slice('/sys/fs/cgroup'.length);
    const referenceScan = scanReferences(privateRoot, taskCgroup);
    details.referenceScan = referenceScan;
    if (referenceScan.status !== 'CLEAR')
      throw new Error(
        referenceScan.status === 'REFERENCED'
          ? 'Task-private filesystem still has external references'
          : 'Task-private reference scan could not be completed',
      );
    referencesClear = true;

    if (isStopping()) failureCode = 'cancelled';
    if (!isStopping() && workerExit.code === 0) {
      details.transfer = await transfer(config, candidate, config.stagePath);
      if (isStopping()) {
        failureCode = 'cancelled';
        throw new Error('Task cancelled during stage transfer');
      }
      status = 'succeeded';
    }

    runCommand('/usr/bin/umount', [privateProject]);
    projectMounted = false;
    runCommand('/usr/bin/umount', [privateRoot]);
    privateMounted = false;
    remove(privateRoot, { recursive: true, force: true });
    cleanupVerified = true;
  } catch (error) {
    details.failure = bounded(error instanceof Error ? error.message : error);
    const drained = await drainTask(group, config.cleanupTimeoutMs);
    details.failureDrain = drained;
    if (projectMounted) {
      try {
        runCommand('/usr/bin/umount', [privateProject]);
        projectMounted = false;
      } catch (unmountError) {
        details.projectUnmountFailure = bounded(
          unmountError instanceof Error ? unmountError.message : unmountError,
        );
      }
    }
    if (privateMounted) {
      try {
        runCommand('/usr/bin/umount', [privateRoot]);
        privateMounted = false;
      } catch (unmountError) {
        details.privateUnmountFailure = bounded(
          unmountError instanceof Error ? unmountError.message : unmountError,
        );
      }
    }
    cleanupVerified = referencesClear && drained.drained && !projectMounted && !privateMounted;
    status = 'failed';
    if (isStopping()) failureCode = 'cancelled';
  }
  return {
    status,
    failureCode,
    cleanupVerified,
    projectMounted,
    privateMounted,
    details,
  };
}

/** Bind the validated inode, even if the source pathname is replaced later. */
export function bindProjectDirectory(project, target, expected, dependencies = {}) {
  const execute = dependencies.execFileSync ?? execFileSync;
  const fd = openSync(project, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== expected.dev || opened.ino !== expected.ino)
      throw new Error('Task project identity changed before bind');
    execute('/usr/bin/mount', ['--no-canonicalize', '--bind', '/proc/self/fd/3', target], {
      stdio: ['ignore', 'inherit', 'inherit', fd],
      timeout: 20_000,
    });
  } finally {
    closeSync(fd);
  }
}

async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0)
    throw new Error('Resource task runner requires Linux root');
  const configPath = resolve(process.argv[2] ?? '');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const result = await runTask(config);
  process.exitCode = result.status === 'succeeded' ? 0 : 1;
}

/** Production task lifecycle; OS boundaries can be mocked without replacing its cancellation wiring. */
export async function runTask(config) {
  const projectIdentity = validateConfig(config);
  const privateRoot = config.privateRoot;
  const privateProject = join(privateRoot, 'project');
  const candidate = join(privateRoot, 'out', 'candidate.mp4');
  const group = cgroupPath();
  let privateMounted = false;
  let projectMounted = false;
  let activeChild;
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (activeChild?.pid) {
      try {
        process.kill(activeChild.pid, 'SIGTERM');
      } catch {}
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let status = 'failed';
  let failureCode = 'execution_failed';
  let cleanupVerified = false;
  const details = {
    cgroup: group,
    mountNamespace: readlinkSync('/proc/self/ns/mnt'),
    privateFilesystem: 'tmpfs',
    projectMount: 'read-only bind',
  };
  try {
    command('/usr/bin/mount', ['--make-rprivate', '/']);
    mkdirSync(privateRoot, { mode: 0o700 });
    command('/usr/bin/mount', [
      '-t',
      'tmpfs',
      '-o',
      `size=${config.memoryBytes},nosuid,nodev,noexec,mode=0755`,
      `openmaic-${config.id}`,
      privateRoot,
    ]);
    privateMounted = true;
    for (const path of ['tmp', 'home', 'out', 'project']) mkdirSync(join(privateRoot, path));
    bindProjectDirectory(config.projectDir, privateProject, projectIdentity);
    projectMounted = true;
    command('/usr/bin/mount', ['-o', 'remount,bind,ro,nosuid,nodev', privateProject]);
    for (const path of ['tmp', 'home', 'out'])
      command('/usr/bin/chown', [
        `${config.workerUid}:${config.workerGid}`,
        join(privateRoot, path),
      ]);

    const workerEnvironment = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      LANG: 'C.UTF-8',
      HOME: join(privateRoot, 'home'),
      TMPDIR: join(privateRoot, 'tmp'),
      PRODUCER_HEADLESS_SHELL_PATH: realpathSync(config.browserPath),
      PUPPETEER_EXECUTABLE_PATH: realpathSync(config.browserPath),
      HYPERFRAMES_FFMPEG_PATH: realpathSync(config.ffmpegPath),
      FFMPEG_PATH: realpathSync(config.ffmpegPath),
      HYPERFRAMES_EXTRACT_CACHE_DIR: 'off',
      PRODUCER_ENABLE_BROWSER_POOL: 'false',
      ...config.producerEnvironment,
    };
    activeChild = spawn(
      '/usr/bin/setpriv',
      [
        `--reuid=${config.workerUid}`,
        `--regid=${config.workerGid}`,
        '--clear-groups',
        '--bounding-set=-all',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--no-new-privs',
        process.execPath,
        WORKER,
        privateProject,
        candidate,
        JSON.stringify(config.options),
      ],
      {
        cwd: join(privateRoot, 'home'),
        env: workerEnvironment,
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    const workerExit = await new Promise((resolveExit) => {
      activeChild.once('error', (error) =>
        resolveExit({ code: null, error: bounded(error.message) }),
      );
      activeChild.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    activeChild = undefined;
    details.workerExit = workerExit;
    const closeout = await closeoutTask(
      {
        config,
        group,
        privateRoot,
        privateProject,
        candidate,
        workerExit,
        isStopping: () => stopping,
        projectMounted,
        privateMounted,
      },
      {
        transfer: (taskConfig, source, destination) =>
          transferCandidate(taskConfig, source, destination, {
            onChild: (child) => {
              activeChild = child;
            },
          }),
      },
    );
    status = closeout.status;
    failureCode = closeout.failureCode;
    cleanupVerified = closeout.cleanupVerified;
    projectMounted = closeout.projectMounted;
    privateMounted = closeout.privateMounted;
    Object.assign(details, closeout.details);
  } catch (error) {
    details.failure = bounded(error instanceof Error ? error.message : error);
    const drained = await drain(group, config.cleanupTimeoutMs);
    details.failureDrain = drained;
    if (projectMounted) {
      try {
        command('/usr/bin/umount', [privateProject]);
        projectMounted = false;
      } catch (unmountError) {
        details.projectUnmountFailure = bounded(
          unmountError instanceof Error ? unmountError.message : unmountError,
        );
      }
    }
    if (privateMounted) {
      try {
        command('/usr/bin/umount', [privateRoot]);
        privateMounted = false;
      } catch (unmountError) {
        details.privateUnmountFailure = bounded(
          unmountError instanceof Error ? unmountError.message : unmountError,
        );
      }
    }
    cleanupVerified = false;
    status = 'failed';
    if (stopping) failureCode = 'cancelled';
  }
  const resourceAccounting = readTaskAccounting(group);
  details.resourceAccounting = resourceAccounting;
  if (resourceAccounting.status === 'CAPTURED') details.residual = resourceAccounting.measurements;
  else details.accountingFailure = resourceAccounting.errors;
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  const result = { status, failureCode, cleanupVerified, details };
  writeResult(config.resultPath, result);
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  try {
    await main();
  } catch (error) {
    console.error('Resource task runner failed before settlement:', error);
    process.exitCode = 1;
  }
