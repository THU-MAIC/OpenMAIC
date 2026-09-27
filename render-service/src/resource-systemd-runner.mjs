import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { processIdentity } from './resource-reference-scan.mjs';

const exec = promisify(execFile);
const TASK_RUNNER = fileURLToPath(new URL('./resource-task-runner.mjs', import.meta.url));
const MAX_COMMAND_OUTPUT = 64 * 1024;
export const TASK_DIRECTORY_MODE = 0o711;
export const MAIN_PID_DIAGNOSTIC_CODES = Object.freeze({
  fieldsNotReady: 'main_pid_fields_not_ready',
  startupTransient: 'main_pid_startup_transient',
  processExited: 'main_pid_process_exited',
  readError: 'main_pid_read_error',
  identityMismatch: 'main_pid_identity_mismatch',
});

export function createTaskDirectory(path) {
  mkdirSync(path, { mode: TASK_DIRECTORY_MODE });
  // The owner service deliberately has UMask=0077. Apply the reviewed final
  // traversal mode explicitly instead of silently accepting 0700.
  chmodSync(path, TASK_DIRECTORY_MODE);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function boundedText(value) {
  return String(value ?? '').slice(0, MAX_COMMAND_OUTPUT);
}

function parseShow(stdout) {
  return Object.fromEntries(
    stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
}

async function showUnit(unit) {
  try {
    const { stdout } = await exec(
      '/usr/bin/systemctl',
      [
        'show',
        unit,
        '--property=LoadState,MainPID,ControlGroup,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus',
      ],
      { timeout: 5000, maxBuffer: MAX_COMMAND_OUTPUT },
    );
    const state = parseShow(stdout);
    return { found: state.LoadState !== 'not-found', ...state };
  } catch (error) {
    const stdout =
      error && typeof error === 'object' && 'stdout' in error ? boundedText(error.stdout) : '';
    const state = stdout ? parseShow(stdout) : {};
    if (state.LoadState === 'not-found') return { found: false, ...state };
    if (error && typeof error === 'object' && 'code' in error && error.code === 4)
      return {
        found: false,
        LoadState: 'not-found',
        lookupError: boundedText(error instanceof Error ? error.message : error),
      };
    return {
      found: false,
      readError: boundedText(error instanceof Error ? error.message : error),
    };
  }
}

function errorRecord(error) {
  return {
    ...(error && typeof error === 'object' && 'code' in error
      ? { code: boundedText(error.code) }
      : {}),
    message: boundedText(error instanceof Error ? error.message : error),
  };
}

function missingProcess(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['ENOENT', 'ESRCH'].includes(String(error.code)),
  );
}

function missingPath(error) {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && String(error.code) === 'ENOENT',
  );
}

function readStat(pid, readFile) {
  try {
    const raw = readFile(`/proc/${pid}/stat`, 'utf8');
    const identity = processIdentity(raw);
    if (['Z', 'X', 'x'].includes(identity.state))
      return {
        status: MAIN_PID_DIAGNOSTIC_CODES.processExited,
        check: { result: 'process_exited', state: identity.state, starttime: identity.starttime },
      };
    return {
      status: 'ready',
      identity,
      check: { result: 'ready', state: identity.state, starttime: identity.starttime },
    };
  } catch (error) {
    return missingProcess(error)
      ? {
          status: MAIN_PID_DIAGNOSTIC_CODES.processExited,
          check: { result: 'process_exited', error: errorRecord(error) },
        }
      : {
          status: MAIN_PID_DIAGNOSTIC_CODES.readError,
          check: { result: 'read_error', error: errorRecord(error) },
        };
  }
}

/** Inspect one observed systemd MainPID without treating missing proc fields as a mismatch. */
export function inspectMainPid(pid, controlGroup, dependencies = {}) {
  const readFile = dependencies.readFile ?? readFileSync;
  const realpath = dependencies.realpath ?? realpathSync;
  const expectedExe = dependencies.expectedExe ?? realpath(process.execPath);
  const systemdExecStubs = dependencies.systemdExecStubs ?? new Set(['/usr/lib/systemd/systemd']);
  const base = `/proc/${pid}`;
  const before = readStat(pid, readFile);
  if (before.status !== 'ready')
    return {
      status: before.status,
      pid,
      checks: { process: before.check },
    };

  const checks = { process: before.check };
  let exe;
  try {
    exe = realpath(join(base, 'exe'));
    checks.exe = {
      result: exe === expectedExe ? 'match' : 'mismatch',
      expected: expectedExe,
      observed: exe,
    };
  } catch (error) {
    checks.exe = {
      result: missingProcess(error) ? 'not_ready' : 'read_error',
      error: errorRecord(error),
    };
  }

  let membership;
  try {
    membership = readFile(join(base, 'cgroup'), 'utf8');
    const observedGroups = membership.split('\n').filter(Boolean);
    const expectedMembership = `0::${controlGroup}`;
    checks.cgroup = {
      result: observedGroups.includes(expectedMembership) ? 'match' : 'mismatch',
      expected: expectedMembership,
      observed: observedGroups.map(boundedText),
    };
  } catch (error) {
    checks.cgroup = {
      result: missingProcess(error) ? 'not_ready' : 'read_error',
      error: errorRecord(error),
    };
  }

  const after = readStat(pid, readFile);
  if (after.status !== 'ready')
    return {
      status: after.status,
      pid,
      checks: { ...checks, processAfterRead: after.check },
    };
  checks.processAfterRead = after.check;
  if (after.identity.starttime !== before.identity.starttime)
    return {
      status: MAIN_PID_DIAGNOSTIC_CODES.processExited,
      pid,
      checks: {
        ...checks,
        processAfterRead: { ...after.check, result: 'pid_reused' },
      },
    };
  if (checks.exe.result === 'read_error' || checks.cgroup.result === 'read_error')
    return { status: MAIN_PID_DIAGNOSTIC_CODES.readError, pid, checks };
  if (checks.exe.result === 'not_ready' || checks.cgroup.result === 'not_ready')
    return { status: MAIN_PID_DIAGNOSTIC_CODES.fieldsNotReady, pid, checks };
  if (
    checks.exe.result === 'mismatch' &&
    checks.cgroup.result === 'match' &&
    systemdExecStubs.has(exe)
  ) {
    checks.exe = {
      ...checks.exe,
      result: 'startup_transient',
      reason: 'systemd_exec_stub_before_target_exec',
    };
    return { status: MAIN_PID_DIAGNOSTIC_CODES.startupTransient, pid, checks };
  }
  if (checks.exe.result === 'mismatch' || checks.cgroup.result === 'mismatch')
    return { status: MAIN_PID_DIAGNOSTIC_CODES.identityMismatch, pid, checks };
  return { status: 'match', pid, exe, membership: boundedText(membership), checks };
}

function startupError(message, safeDiagnosticCode, details) {
  return Object.assign(new Error(message), { safeDiagnosticCode, details });
}

function startupLog(unit, diagnostic) {
  console.error(
    'Resource task MainPID diagnostic:',
    boundedText(JSON.stringify({ unit, ...diagnostic })),
  );
}

function unitDiagnostic(state, seenUnit) {
  if (state.readError)
    return {
      status: MAIN_PID_DIAGNOSTIC_CODES.readError,
      reason: 'systemd_state_read_error',
      unit: state,
    };
  if (!state.found)
    return seenUnit
      ? {
          status: MAIN_PID_DIAGNOSTIC_CODES.processExited,
          reason: 'unit_disappeared_after_becoming_visible',
          unit: state,
        }
      : {
          status: MAIN_PID_DIAGNOSTIC_CODES.fieldsNotReady,
          reason: 'unit_not_visible_yet',
          unit: state,
        };
  if (['inactive', 'failed'].includes(String(state.ActiveState)))
    return {
      status: MAIN_PID_DIAGNOSTIC_CODES.processExited,
      reason: 'unit_stopped_before_identity_verification',
      unit: state,
    };
  const pid = Number(state.MainPID ?? 0);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !state.ControlGroup)
    return {
      status: MAIN_PID_DIAGNOSTIC_CODES.fieldsNotReady,
      reason: 'main_pid_or_control_group_not_ready',
      unit: state,
    };
  return { status: 'ready', pid, controlGroup: state.ControlGroup, unit: state };
}

/** Wait only for evidence-backed startup fields; known failures stop immediately. */
export async function waitForStarted(unit, resultPath, timeoutMs, dependencies = {}) {
  const readUnit = dependencies.showUnit ?? showUnit;
  const inspect = dependencies.inspectMainPid ?? inspectMainPid;
  const resultExists = dependencies.exists ?? existsSync;
  const pause = dependencies.sleep ?? sleep;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? startupLog;
  const end = now() + timeoutMs;
  let last;
  let seenUnit = false;
  let lastLogged;
  let diagnosticLogs = 0;
  while (now() < end) {
    const state = await readUnit(unit);
    seenUnit ||= state.found === true;
    const fields = unitDiagnostic(state, seenUnit);
    last = fields;
    if (fields.status === 'ready') {
      const identity = inspect(fields.pid, fields.controlGroup);
      last = { ...fields, status: identity.status, mainPidIdentity: identity };
      if (identity.status === 'match') {
        log(unit, { status: 'match', mainPid: fields.pid, controlGroup: fields.controlGroup });
        return {
          state,
          controlGroup: fields.controlGroup,
          mainPid: fields.pid,
          mainPidIdentity: identity,
        };
      }
    }

    const signature = JSON.stringify({
      status: last.status,
      reason: last.reason,
      pid: last.pid,
      checks: last.mainPidIdentity?.checks
        ? Object.fromEntries(
            Object.entries(last.mainPidIdentity.checks).map(([field, check]) => [
              field,
              check.result,
            ]),
          )
        : undefined,
    });
    if (signature !== lastLogged && diagnosticLogs < 8) {
      log(unit, last);
      lastLogged = signature;
      diagnosticLogs++;
    }
    if (
      last.status !== MAIN_PID_DIAGNOSTIC_CODES.fieldsNotReady &&
      last.status !== MAIN_PID_DIAGNOSTIC_CODES.startupTransient
    )
      throw startupError('Transient task MainPID verification failed', last.status, last);
    if (resultExists(resultPath)) {
      const completed = { ...last, reason: 'task_result_exists_before_identity_verification' };
      log(unit, completed);
      throw startupError(
        'Transient task completed before MainPID verification',
        MAIN_PID_DIAGNOSTIC_CODES.processExited,
        completed,
      );
    }
    await pause(25);
  }
  log(unit, { ...last, timeoutMs, reason: 'startup_window_expired' });
  throw startupError(
    'Transient task did not expose a verifiable MainPID',
    last?.status ?? MAIN_PID_DIAGNOSTIC_CODES.fieldsNotReady,
    { ...last, timeoutMs, reason: 'startup_window_expired' },
  );
}

export async function waitForStopped(unit, controlGroup, timeoutMs, dependencies = {}) {
  const readUnit = dependencies.showUnit ?? showUnit;
  const pathExists = dependencies.exists ?? existsSync;
  const pause = dependencies.sleep ?? sleep;
  const now = dependencies.now ?? Date.now;
  const end = now() + timeoutMs;
  const cgroupPath = resolve('/sys/fs/cgroup', `.${controlGroup}`);
  let last;
  while (now() < end) {
    last = await readUnit(unit);
    const stopped = !last.found || last.ActiveState === 'inactive' || last.ActiveState === 'failed';
    if (stopped && !pathExists(cgroupPath)) return { unit: last, cgroupRemoved: true };
    await pause(50);
  }
  const stopped = Boolean(
    last && (!last.found || last.ActiveState === 'inactive' || last.ActiveState === 'failed'),
  );
  return { unit: last, cgroupRemoved: stopped && !pathExists(cgroupPath) };
}

async function stopUnit(unit) {
  try {
    await exec('/usr/bin/systemctl', ['stop', unit], {
      timeout: 20_000,
      maxBuffer: MAX_COMMAND_OUTPUT,
    });
  } catch {
    // The readback below, not systemctl's exit status, decides settlement.
  }
}

function safeTaskConfig(settings, request, taskDir, stagePath) {
  const producerEnvironment = Object.fromEntries(
    [
      'PRODUCER_MAX_WORKERS',
      'PRODUCER_LOW_MEMORY_MODE',
      'PRODUCER_FORCE_SCREENSHOT',
      'PRODUCER_BROWSER_GPU_MODE',
      'PRODUCER_EXPECTED_CHROMIUM_MAJOR',
      'RENDER_REQUIRE_BEGINFRAME',
    ].map((name) => [name, process.env[name] ?? '']),
  );
  return {
    id: request.id,
    projectDir: request.projectDir,
    projectIdentity: request.projectIdentity,
    stagePath,
    privateRoot: join(taskDir, 'private'),
    resultPath: join(taskDir, 'result.json'),
    workerUid: settings.owner.workerUid,
    workerGid: settings.owner.workerGid,
    cleanupTimeoutMs: settings.owner.cleanupTimeoutMs,
    memoryBytes: settings.task.memoryBytes,
    browserPath: settings.owner.browserPath,
    ffmpegPath: settings.owner.ffmpegPath,
    producerEnvironment,
    options: request.options,
  };
}

function writeExclusiveJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function readTaskResult(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) !== 0)
    throw new Error('Task result is not a root-private regular file');
  const bytes = readFileSync(path);
  if (bytes.byteLength > 1024 * 1024) throw new Error('Oversized task result');
  return JSON.parse(bytes.toString('utf8'));
}

function openProjectDirectory(directory, expectedIdentity) {
  if (
    !expectedIdentity ||
    !Number.isSafeInteger(expectedIdentity.dev) ||
    !Number.isSafeInteger(expectedIdentity.ino)
  )
    throw new Error('Missing trusted project directory identity');
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== expectedIdentity.dev || opened.ino !== expectedIdentity.ino)
      throw new Error('Project directory identity changed');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

// The resource runtime is Linux-only. The portable branch supports local tests;
// it does not qualify pathname-race handling on another operating system.
function directoryEntry(fd, directory, name) {
  return join(process.platform === 'linux' ? `/proc/self/fd/${fd}` : directory, name);
}

export function publishStagedArtifact(stagePath, outputPath, expectedIdentity) {
  const directory = dirname(outputPath);
  if (dirname(stagePath) !== directory) throw new Error('Publication paths must share a directory');
  const fd = openProjectDirectory(directory, expectedIdentity);
  let publication;
  try {
    // Fail before the commit point if the target directory cannot be synced.
    fsyncSync(fd);
    renameSync(
      directoryEntry(fd, directory, basename(stagePath)),
      directoryEntry(fd, directory, basename(outputPath)),
    );
    try {
      fsyncSync(fd);
      publication = { directoryFsync: true };
    } catch (error) {
      // rename(2) already committed. Do not report a failure that would imply
      // the previous formal artifact is still present.
      publication = {
        directoryFsync: false,
        directoryFsyncFailure: boundedText(error instanceof Error ? error.message : error),
      };
    }
  } catch (error) {
    // No commit point was crossed. Preserve the publication error even if the
    // directory descriptor also cannot be closed.
    try {
      closeSync(fd);
    } catch {}
    throw error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    // The rename already committed. Descriptor cleanup cannot reverse that
    // fact, so report it instead of changing the publication outcome.
    return {
      ...publication,
      directoryClose: false,
      directoryCloseFailure: boundedText(error instanceof Error ? error.message : error),
    };
  }
  return publication;
}

function removeAndVerify(path, dependencies = {}, singleFile = false) {
  const remove = singleFile ? (dependencies.unlink ?? unlinkSync) : (dependencies.remove ?? rmSync);
  const lstat = dependencies.lstat ?? lstatSync;
  let removalFailure;
  try {
    // Staging is worker-controlled: never traverse it, even if it is a directory.
    if (singleFile) remove(path);
    else remove(path, { recursive: true, force: true });
  } catch (error) {
    removalFailure = errorRecord(error);
  }
  try {
    lstat(path);
    return { verified: false, remains: true, ...(removalFailure ? { removalFailure } : {}) };
  } catch (error) {
    if (missingPath(error))
      return { verified: true, remains: false, ...(removalFailure ? { removalFailure } : {}) };
    return {
      verified: false,
      remains: 'unknown',
      ...(removalFailure ? { removalFailure } : {}),
      observationFailure: errorRecord(error),
    };
  }
}

function removeStageAndVerify(stagePath, expectedIdentity, dependencies) {
  let fd;
  try {
    const directory = dirname(stagePath);
    fd = openProjectDirectory(directory, expectedIdentity);
    return removeAndVerify(directoryEntry(fd, directory, basename(stagePath)), dependencies, true);
  } catch (error) {
    // Absence at a replacement pathname is not evidence about the original object.
    return {
      verified: false,
      remains: 'unknown',
      projectIdentityVerified: false,
      observationFailure: errorRecord(error),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function settleUnpublished(
  stagePath,
  taskDir,
  status,
  failureCode,
  details,
  dependencies = {},
) {
  const stageCleanup = removeStageAndVerify(stagePath, details.projectIdentity, dependencies);
  const taskDirectoryCleanup =
    stageCleanup.projectIdentityVerified === false
      ? { verified: false, remains: 'unknown', skipped: 'project_identity_unverified' }
      : removeAndVerify(taskDir, dependencies);
  const cleanupVerified = stageCleanup.verified && taskDirectoryCleanup.verified;
  return {
    status,
    failureCode,
    published: false,
    cleanupVerified,
    reservationReturned: cleanupVerified,
    admissionClosed: !cleanupVerified,
    details: { ...details, stageCleanup, taskDirectoryCleanup },
  };
}

/** Keep accounting at the product settlement level while retaining raw task evidence. */
export function taskSettlementDetails(task, readback, extra = {}) {
  const taskDetails =
    task && typeof task === 'object' && task.details && typeof task.details === 'object'
      ? task.details
      : {};
  return {
    task,
    readback,
    ...(taskDetails.resourceAccounting
      ? { resourceAccounting: taskDetails.resourceAccounting }
      : {}),
    ...(taskDetails.residual ? { residual: taskDetails.residual } : {}),
    ...(taskDetails.accountingFailure ? { accountingFailure: taskDetails.accountingFailure } : {}),
    ...extra,
  };
}

/** Preserve the publication commit fact while settling its remaining owned paths. */
export function finalizePublication(stagePath, outputPath, taskDir, details, dependencies = {}) {
  const publish = dependencies.publish ?? publishStagedArtifact;
  const cleanupDependencies = {
    ...(dependencies.unlink ? { unlink: dependencies.unlink } : {}),
    ...(dependencies.remove ? { remove: dependencies.remove } : {}),
    ...(dependencies.lstat ? { lstat: dependencies.lstat } : {}),
  };
  let publication;
  try {
    publication = publish(stagePath, outputPath, details.projectIdentity);
  } catch (error) {
    return settleUnpublished(
      stagePath,
      taskDir,
      'failed',
      'execution_failed',
      {
        ...details,
        publishFailure: boundedText(error instanceof Error ? error.message : error),
      },
      cleanupDependencies,
    );
  }

  const taskDirectoryCleanup = removeAndVerify(taskDir, cleanupDependencies);
  return {
    status: 'succeeded',
    published: true,
    cleanupVerified: taskDirectoryCleanup.verified,
    reservationReturned: taskDirectoryCleanup.verified,
    admissionClosed: !taskDirectoryCleanup.verified,
    details: { ...details, publication, taskDirectoryCleanup },
  };
}

export function buildSystemdRunArguments(settings, unit, configPath, remainingMs) {
  const quota = settings.task.cpuMillis / 10;
  return [
    '--no-block',
    '--collect',
    `--unit=${unit.slice(0, -'.service'.length)}`,
    `--slice=${settings.owner.taskSlice}`,
    '--property',
    `RuntimeMaxSec=${Math.max(1, Math.ceil(remainingMs / 1000))}s`,
    '--property',
    `TimeoutStopSec=${Math.max(
      1,
      Math.ceil((2 * settings.owner.cleanupTimeoutMs + 5000) / 1000),
    )}s`,
    '--property',
    'KillMode=control-group',
    '--property',
    `CPUQuota=${quota}%`,
    '--property',
    `MemoryMax=${settings.task.memoryBytes}`,
    '--property',
    'MemorySwapMax=0',
    '--property',
    `TasksMax=${settings.owner.taskPidsMax}`,
    '--property',
    'PrivateNetwork=yes',
    '--property',
    'PrivateMounts=yes',
    '--property',
    'ProtectControlGroups=yes',
    '--property',
    'UMask=0077',
    process.execPath,
    TASK_RUNNER,
    configPath,
  ];
}

/** Run one already-admitted render in a transient systemd service. */
export async function runResourceTask(settings, request, signal, dependencies = {}) {
  const nextId = dependencies.randomUUID ?? randomUUID;
  const makeTaskDirectory = dependencies.createTaskDirectory ?? createTaskDirectory;
  const writeConfig = dependencies.writeExclusiveJson ?? writeExclusiveJson;
  const launchUnit = dependencies.exec ?? exec;
  const awaitStarted = dependencies.waitForStarted ?? waitForStarted;
  const readUnit = dependencies.showUnit ?? showUnit;
  const awaitStopped = dependencies.waitForStopped ?? waitForStopped;
  const stop = dependencies.stopUnit ?? stopUnit;
  const resultExists = dependencies.exists ?? existsSync;
  const readResult = dependencies.readTaskResult ?? readTaskResult;
  const settle = dependencies.settleUnpublished ?? settleUnpublished;
  const publish = dependencies.finalizePublication ?? finalizePublication;
  const nowNs = dependencies.nowNs ?? (() => process.hrtime.bigint());
  const pause = dependencies.sleep ?? sleep;
  const nowMs = dependencies.nowMs ?? Date.now;
  const token = nextId().replaceAll('-', '');
  const unit = `openmaic-render-${token}.service`;
  const taskDir = join(settings.stateRoot, `task-${token}`);
  // The worker receives absolute paths below this directory after setuid().
  // Execute-only access permits traversal but neither listing nor mutation;
  // request/result files remain root-private 0600.
  makeTaskDirectory(taskDir);
  const stagePath = join(request.projectDir, `.openmaic-resource-${token}.mp4`);
  const config = safeTaskConfig(settings, request, taskDir, stagePath);
  const configPath = join(taskDir, 'request.json');
  writeConfig(configPath, config);

  const remainingMs = Math.min(
    request.timeoutMs,
    Number((BigInt(request.deadlineNs) - nowNs()) / 1_000_000n),
  );
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
    return settle(stagePath, taskDir, 'failed', 'deadline_exceeded', {
      notAdmitted: true,
      projectIdentity: config.projectIdentity,
    });
  }

  const args = buildSystemdRunArguments(settings, unit, configPath, remainingMs);

  let started;
  let readback;
  let abortRequested = signal.aborted;
  let deadlineReached = false;
  const abort = () => {
    abortRequested = true;
    void stop(unit);
  };
  const deadlineTimer = setTimeout(() => {
    deadlineReached = true;
    void stop(unit);
  }, remainingMs);
  deadlineTimer.unref?.();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const launch = await launchUnit('/usr/bin/systemd-run', args, {
      timeout: 15_000,
      maxBuffer: MAX_COMMAND_OUTPUT,
    });
    if (launch.stderr) console.error('Resource task launch:', boundedText(launch.stderr));
    console.error(
      'Resource task launch accepted:',
      boundedText(JSON.stringify({ unit, stdout: boundedText(launch.stdout) })),
    );
    started = await awaitStarted(unit, config.resultPath, 10_000);
    if (abortRequested) await stop(unit);

    const end = nowMs() + remainingMs + 2 * settings.owner.cleanupTimeoutMs + 5000;
    while (nowMs() < end) {
      const state = await readUnit(unit);
      if (!state.found || state.ActiveState === 'inactive' || state.ActiveState === 'failed') break;
      if (abortRequested) await stop(unit);
      await pause(50);
    }
    readback = await awaitStopped(
      unit,
      started.controlGroup,
      2 * settings.owner.cleanupTimeoutMs + 5000,
    );
  } catch (error) {
    await stop(unit);
    if (started)
      readback = await awaitStopped(
        unit,
        started.controlGroup,
        2 * settings.owner.cleanupTimeoutMs + 5000,
      );
    const cleanupVerified = readback?.cgroupRemoved === true;
    return {
      status: abortRequested ? 'cancelled' : 'failed',
      failureCode: abortRequested
        ? 'cancelled'
        : deadlineReached
          ? 'deadline_exceeded'
          : 'execution_failed',
      published: false,
      cleanupVerified: false,
      reservationReturned: false,
      admissionClosed: true,
      ...(error && typeof error === 'object' && 'safeDiagnosticCode' in error
        ? { diagnosticCode: error.safeDiagnosticCode }
        : {}),
      details: {
        controllerFailure: boundedText(error instanceof Error ? error.message : error),
        ...(error && typeof error === 'object' && 'details' in error
          ? { diagnostic: error.details }
          : {}),
        platformCgroupRemoved: cleanupVerified,
      },
    };
  } finally {
    clearTimeout(deadlineTimer);
    signal.removeEventListener('abort', abort);
  }

  if (!readback?.cgroupRemoved || !resultExists(config.resultPath)) {
    return {
      status: abortRequested ? 'cancelled' : 'failed',
      failureCode: abortRequested
        ? 'cancelled'
        : deadlineReached
          ? 'deadline_exceeded'
          : 'execution_failed',
      published: false,
      cleanupVerified: false,
      reservationReturned: false,
      admissionClosed: true,
      details: { missingTaskResult: !resultExists(config.resultPath), readback },
    };
  }

  let taskResult;
  try {
    taskResult = readResult(config.resultPath);
  } catch (error) {
    return {
      status: 'failed',
      failureCode: deadlineReached ? 'deadline_exceeded' : 'execution_failed',
      published: false,
      cleanupVerified: false,
      reservationReturned: false,
      admissionClosed: true,
      details: { invalidTaskResult: boundedText(error instanceof Error ? error.message : error) },
    };
  }
  const cleanupVerified = taskResult.cleanupVerified === true && readback.cgroupRemoved === true;
  if (!cleanupVerified) {
    return {
      status: abortRequested ? 'cancelled' : 'failed',
      failureCode: abortRequested
        ? 'cancelled'
        : deadlineReached
          ? 'deadline_exceeded'
          : 'execution_failed',
      published: false,
      cleanupVerified: false,
      reservationReturned: false,
      admissionClosed: true,
      details: taskSettlementDetails(taskResult, readback),
    };
  }
  const deadlineExpired = deadlineReached || nowNs() >= BigInt(request.deadlineNs);
  if (abortRequested || deadlineExpired || taskResult.status !== 'succeeded') {
    return settle(
      stagePath,
      taskDir,
      abortRequested ? 'cancelled' : 'failed',
      abortRequested
        ? 'cancelled'
        : deadlineExpired
          ? 'deadline_exceeded'
          : (taskResult.failureCode ?? 'execution_failed'),
      taskSettlementDetails(taskResult, readback, { projectIdentity: config.projectIdentity }),
    );
  }

  if (signal.aborted) {
    return settle(
      stagePath,
      taskDir,
      'cancelled',
      'cancelled',
      taskSettlementDetails(taskResult, readback, {
        cancelledBeforePublish: true,
        projectIdentity: config.projectIdentity,
      }),
    );
  }
  return publish(
    stagePath,
    request.outputPath,
    taskDir,
    taskSettlementDetails(taskResult, readback, { projectIdentity: config.projectIdentity }),
  );
}
