/** Installed Linux service cases. No downloads, provisioning, retries or fallback.
 * The existing guest/remote execution owner supplies isolation, an empty task
 * delegation, an immutable installation, and bounded final platform cleanup.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { zipSync } from 'fflate';
import { verifyResourcePackage, requireLinuxPlatformLock } from '../scripts/resource-package.mjs';
import { resolveResourceProfile, validateResourceProfileStartup } from '../src/resource-profile.ts';

const service = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => fs.readFileSync(path, 'utf8').trim();
const json = (path) => JSON.parse(read(path));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const save = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
export const cases = [
  'normal',
  'cancel',
  'deadline',
  'task-oom',
  'ancestor-pressure',
  'api-death',
  'supervisor-death',
  'guardian-death',
];

// starttime excludes PID reuse from both signalling and final-drain evidence.
export function processIdentity(stat) {
  const end = stat.lastIndexOf(')');
  assert(end > 0, 'Invalid /proc stat');
  const fields = stat.slice(end + 2).split(' ');
  assert(/^\d+$/.test(fields[19]), 'Missing process starttime');
  return fields[19];
}
function proc(pid) {
  try {
    const stat = read(`/proc/${pid}/stat`);
    return {
      pid,
      starttime: processIdentity(stat),
      stat,
      status: read(`/proc/${pid}/status`),
      cgroup: read(`/proc/${pid}/cgroup`),
      cmdline: read(`/proc/${pid}/cmdline`),
    };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}
function still(row) {
  return row && proc(row.pid)?.starttime === row.starttime;
}
function signal(row, name) {
  assert(still(row), `Process identity changed before ${name}`);
  process.kill(row.pid, name);
}
function ids(path) {
  return read(path).split(/\s+/).filter(Boolean).map(Number);
}
function directories(path) {
  return fs.existsSync(path)
    ? fs
        .readdirSync(path, { withFileTypes: true })
        .filter((row) => row.isDirectory())
        .map((row) => join(path, row.name))
    : [];
}
async function until(check, ms) {
  const deadline = performance.now() + ms;
  do {
    const value = await check();
    if (value) return value;
    await delay(20);
  } while (performance.now() < deadline);
  throw new Error('Required service/lifecycle observation timed out');
}
export function assertSettlement(value, expected) {
  assert(value && typeof value === 'object', 'Missing service settlement');
  for (const [key, item] of Object.entries(expected)) assert.equal(value[key], item, key);
}
export function cgroupDirectory(membership) {
  assert(/^0::\/[^\n]*$/.test(membership), 'Expected unified membership');
  const suffix = membership.slice(3);
  assert(
    !suffix.split('/').some((part) => part === '..' || part === '.'),
    'Cgroup ancestors are hidden by the namespace',
  );
  return resolve('/sys/fs/cgroup' + suffix);
}
function immutable(path, traversable = true) {
  assert.equal(fs.realpathSync(path), path, 'Noncanonical runtime input');
  let current = path;
  for (;;) {
    const st = fs.lstatSync(current);
    assert.equal(st.uid, 0, `Not root-owned: ${current}`);
    assert.equal(st.mode & 0o022, 0, `Writable runtime input: ${current}`);
    // Runtime inputs must remain accessible after the HTTP UID drop.
    if (traversable && st.isDirectory())
      assert(st.mode & 0o001, `Non-traversable runtime directory: ${current}`);
    if (current === '/') break;
    current = dirname(current);
  }
}
function sourceFiles() {
  // Git is read only. Bind current bytes, including new validation files; never
  // inherit a PASS solely from a commit name when the checkout is dirty.
  const names = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '.'],
    { cwd: service, encoding: 'utf8', timeout: 5000 },
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  return Object.fromEntries(
    names.map((path) => [path, hash(fs.readFileSync(join(service, path)))]),
  );
}
function installedLock(root) {
  const bytes = fs.readFileSync(join(root, 'package-lock.json'));
  const lock = JSON.parse(bytes);
  const platformPackage = requireLinuxPlatformLock(lock);
  for (const [path, row] of Object.entries(lock.packages)) {
    if (!path) continue;
    const file = join(root, path, 'package.json');
    if (row.optional && !fs.existsSync(file) && path !== platformPackage) continue;
    immutable(file);
    assert.equal(json(file).version, row.version, `Installed dependency mismatch: ${path}`);
  }
  return { sha256: hash(bytes), lock };
}
export function checkInputs(settingsPath, name, evidencePath) {
  assert(cases.includes(name), 'Unknown service case');
  assert.equal(process.platform, 'linux');
  assert(['arm64', 'x64'].includes(process.arch), 'Unsupported Linux architecture');
  assert.equal(process.getuid(), 0);
  assert(Number(process.versions.node.split('.')[0]) >= 22);
  assert(!fs.existsSync(evidencePath), 'Evidence/run-id already used');
  immutable(settingsPath);
  const settings = json(settingsPath);
  const pkg = verifyResourcePackage(settings.packageRoot);
  const installation = resolve(pkg, '../../..');
  const receipt = json(join(installation, 'resource-build.json'));
  const specification = json(join(service, 'producer-patch/source.json'));
  const shared = join(installation, 'verification/installed-linux-cases.mjs');
  const sharedHash = hash(fs.readFileSync(shared));
  assert.equal(
    sharedHash,
    specification.files['packages/producer/src/resources/installed-linux-cases.mjs'],
  );
  assert.equal(sharedHash, receipt.installedCasesSha256);
  for (const path of [pkg, shared, service, process.execPath]) immutable(path);
  for (const path of Object.keys(receipt.producerFiles)) immutable(join(pkg, path));
  const files = sourceFiles();
  for (const path of Object.keys(files)) immutable(join(service, path));
  // Do not inherit credentials or unreviewed engine/test overrides into root S.
  const env = {
    LANG: 'C.UTF-8',
    ...Object.fromEntries(
      [
        'PATH',
        'PORT',
        'RENDER_RESOURCE_PROFILE',
        'RENDER_HOME',
        'PRODUCER_HEADLESS_SHELL_PATH',
        'PUPPETEER_EXECUTABLE_PATH',
        'HYPERFRAMES_FFMPEG_PATH',
        'FFMPEG_PATH',
        'PRODUCER_TMP_PROJECT_DIR',
      ]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
  };
  const profile = resolveResourceProfile(env);
  validateResourceProfileStartup(profile, { headlessShellPath: env.PRODUCER_HEADLESS_SHELL_PATH });
  assert.equal(process.env.RENDER_CHUNK_EXECUTION ?? 'false', 'false');
  assert.equal(env.PRODUCER_TMP_PROJECT_DIR, settings.projectRoot);
  assert.equal(fs.realpathSync(settings.projectRoot), settings.projectRoot);
  assert.equal(fs.lstatSync(settings.projectRoot).uid, settings.owner.workerUid);
  assert.deepEqual(fs.readdirSync(settings.projectRoot), [], 'Use a fresh project root');
  assert(Number.isSafeInteger(settings.owner.workerUid) && settings.owner.workerUid > 0);
  assert(Number.isSafeInteger(settings.owner.workerGid) && settings.owner.workerGid > 0);
  assert.equal(settings.owner.cleanupTimeoutMs, 10000);
  assert.equal(settings.owner.taskPidsMax, 256);
  for (const budget of [settings.owner, settings.task]) {
    assert.equal(budget.cpuMillis, 1000);
    assert.equal(budget.memoryBytes, 805306368);
  }
  const delegation = settings.owner.taskCgroupRoot;
  assert(delegation.startsWith('/sys/fs/cgroup/'));
  immutable(delegation, false);
  assert.deepEqual(directories(delegation), [], 'Delegation has an existing owner');
  assert.equal(read(join(delegation, 'cgroup.procs')), '');
  assert.match(read(join(delegation, 'cgroup.controllers')), /\bcpu\b/);
  assert.match(read(join(delegation, 'cgroup.controllers')), /\bmemory\b/);
  assert.match(read(join(delegation, 'cgroup.controllers')), /\bpids\b/);
  const ownDirectory = cgroupDirectory(read('/proc/self/cgroup'));
  assert(ownDirectory !== delegation && !ownDirectory.startsWith(delegation + '/'));
  // Read actual enclosing limits, not only the cgroup mount root.
  let ancestor = ownDirectory;
  const ancestors = [];
  while (ancestor !== '/sys/fs/cgroup') {
    const memoryMax = read(join(ancestor, 'memory.max'));
    if (memoryMax !== 'max')
      assert(
        BigInt(memoryMax) >= BigInt(profile.minimumMemoryBytes),
        'Outer memory below selected profile',
      );
    ancestors.push({
      path: ancestor,
      memoryMax,
      memoryEventsLocal: read(join(ancestor, 'memory.events.local')),
    });
    ancestor = dirname(ancestor);
  }
  const launcher = join(pkg, 'dist/native/resource-launcher');
  fs.accessSync(launcher, fs.constants.X_OK);
  const runtimePaths = [
    launcher,
    join(pkg, 'dist/native/resource-supervisor.node'),
    settings.projectRoot,
  ].map((path) => {
    const st = fs.statSync(path);
    return { path, uid: st.uid, gid: st.gid, mode: st.mode, bytes: st.size };
  });
  const port = Number(env.PORT);
  assert(
    Number.isInteger(port) && port >= 1024 && port <= 65535,
    'Explicit nonprivileged test PORT required',
  );
  assert(process.env.HYPERFRAMES_RESOURCE_TEST_PROJECT, 'Existing fixed fixture required');
  const fixture = resolve(process.env.HYPERFRAMES_RESOURCE_TEST_PROJECT, 'index.html');
  const input = {
    case: name,
    settings,
    settingsSha256: hash(fs.readFileSync(settingsPath)),
    files,
    receipt,
    profile: profile.name,
    ancestors,
    serviceLock: installedLock(service),
    producerLock: installedLock(installation),
    fixtureSha256: hash(fs.readFileSync(fixture)),
    node: process.version,
    // Explicit environment identity; no credentials or unrelated environment copied.
    environment: env,
  };
  // Live counters are evidence, not stable authorization input.
  const inputSha256 = hash(
    JSON.stringify({
      ...input,
      ancestors: ancestors.map(({ path, memoryMax }) => ({ path, memoryMax })),
    }),
  );
  return { input, inputSha256, settings, shared, fixture, env, port, pkg, runtimePaths };
}

export async function runServiceCase(settingsPath, name, evidencePath) {
  const checked = checkInputs(settingsPath, name, evidencePath);
  assert.equal(
    process.env.OPENMAIC_RESOURCE_TEST_INPUT_SHA256,
    checked.inputSha256,
    'Approved input digest mismatch',
  );
  fs.mkdirSync(evidencePath, { mode: 0o700 }); // Exclusive creation consumes this run-id.
  const report = {
    status: 'RUNNING',
    case: name,
    inputSha256: checked.inputSha256,
    bootId: read('/proc/sys/kernel/random/boot_id'),
    startedMonotonicMs: Number(process.hrtime.bigint()) / 1e6,
    observations: [],
    cleanup: { status: 'NOT_RUN' },
  };
  const persist = () => save(join(evidencePath, 'service-result.json'), report);
  save(join(evidencePath, 'inputs.json'), checked.input);
  report.runtimePaths = checked.runtimePaths;
  report.observer = proc(process.pid);
  try {
    report.securityProfile = read('/proc/self/attr/current');
  } catch (error) {
    report.securityProfile = { unavailable: error.code };
  }
  persist();
  try {
    fs.writeFileSync(join(evidencePath, 'mountinfo.txt'), fs.readFileSync('/proc/self/mountinfo'));
  } catch (error) {
    report.status = 'FAIL';
    report.error = error.stack;
    persist();
    throw error;
  }
  let mediaGate, observeLauncher, binding;
  const { settings, env, port } = checked;
  const session = join(settings.owner.taskCgroupRoot, 'hyperframes-session');
  const deadlineMs = name === 'deadline' ? 15000 : 120000;
  const argv = ['--import', 'tsx', join(service, 'src/resource-main.ts'), settingsPath];
  let child, observation, api, supervisor, gate, domain, memoryFd, normalArtifact;
  const known = new Map();
  const guardians = new Map();
  const frozen = [];
  let sampler, sampleError;
  let bodyPassed = false;
  const url = `http://127.0.0.1:${port}`;
  const request = (path, init) => {
    if (sampleError) throw sampleError;
    return fetch(url + path, { ...init, signal: AbortSignal.timeout(5000) });
  };
  async function get(path) {
    const response = await request(path);
    assert.equal(response.status, 200);
    return response.json();
  }
  async function submit(fps = 1) {
    const form = new FormData();
    form.append(
      'project',
      new Blob([zipSync({ 'index.html': fs.readFileSync(checked.fixture) })]),
      'project.zip',
    );
    form.append('fps', String(fps));
    form.append('quality', 'draft');
    form.append('format', 'mp4');
    return request('/render', { method: 'POST', body: form });
  }
  async function submitted(fps) {
    const response = await submit(fps);
    assert.equal(response.status, 202);
    return (await response.json()).jobId;
  }
  async function terminal(id) {
    return until(async () => {
      const job = await get(`/render/${id}`);
      return job.done && job;
    }, deadlineMs + 25000);
  }
  function reapOrphans() {
    // Give Node its direct child's exit event before reaping adopted orphans.
    if (api && !still(api) && !observation?.evidence.exitObserved) return;
    binding?.reapTask(read('/proc/self/cgroup').slice(3));
  }
  function sample() {
    try {
      const tasks = directories(session);
      if (!tasks.length) return;
      assert.equal(tasks.length, 1);
      domain = tasks[0];
      const rows = ids(join(domain, 'cgroup.procs')).map(proc).filter(Boolean);
      rows.forEach((row) => known.set(`${row.pid}:${row.starttime}`, row));
      const worker = rows.find((row) => row.cmdline.includes('resourceWorker.js'));
      if (worker) {
        const parent = proc(Number(/^PPid:\s+(\d+)$/m.exec(worker.status)?.[1]));
        if (parent?.cmdline.split('\0')[0].endsWith('/resource-launcher'))
          guardians.set(`${parent.pid}:${parent.starttime}`, parent);
      }
      const found = mediaGate(rows, domain);
      if (found) gate = found;
    } catch (error) {
      if (error.code !== 'ENOENT') sampleError = error;
    }
  }
  async function drained() {
    await until(() => {
      reapOrphans();
      return (
        (!domain || !fs.existsSync(domain) || !ids(join(domain, 'cgroup.procs')).length) &&
        [...known.values()].every((row) => !still(row)) &&
        [...guardians.values()].every((row) => !still(row))
      );
    }, 12000);
    report.guardians = [...guardians.values()].map((row) => ({ ...row, absent: !still(row) }));
    report.reaped = [...known.values()].map((row) => ({
      pid: row.pid,
      starttime: row.starttime,
      absent: !still(row),
    }));
  }
  async function normal() {
    const id = await submitted(1);
    const job = await terminal(id);
    assert.equal(job.status, 'succeeded');
    assertSettlement(job.resources, {
      published: true,
      cleanupVerified: true,
      reservationReturned: true,
      admissionClosed: false,
    });
    const response = await request(`/render/${id}/download`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length > 0 && bytes.length <= 1024 * 1024, 'Artifact exceeds evidence budget');
    const path = join(evidencePath, `normal-${id}.mp4`);
    fs.writeFileSync(path, bytes);
    execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], {
      timeout: 15000,
      maxBuffer: 65536,
    });
    const media = JSON.parse(
      execFileSync(
        '/usr/bin/ffprobe',
        ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path],
        { timeout: 10000, maxBuffer: 65536, encoding: 'utf8' },
      ),
    );
    const video = media.streams.filter((row) => row.codec_type === 'video');
    assert.equal(video.length, 1);
    assert.equal(video[0].codec_name, 'h264');
    assert.equal(video[0].width, 200);
    assert.equal(video[0].height, 200);
    assert(Number(video[0].nb_read_frames) > 0);
    await drained();
    assert.deepEqual(directories(session), []);
    for (const project of directories(settings.projectRoot))
      assert.deepEqual(directories(project), [], 'Normal export left private task directories');
    const result = {
      drained: { remainingTasks: directories(session), reaped: [...report.reaped] },
      id,
      job,
      media,
      bytes: bytes.length,
      sha256: hash(bytes),
      path,
      decoded: true,
    };
    report.observations.push(result);
    persist();
    return result;
  }
  try {
    ({ mediaGate, observeLauncher } = await import(pathToFileURL(checked.shared).href));
    binding = createRequire(import.meta.url)(
      join(checked.pkg, 'dist/native/resource-supervisor.node'),
    );
    // Same dedicated observer/subreaper contract as the existing native cases.
    binding.initialize();
    // Port must be unused before spawn: never drive an unrelated live service.
    const net = await import('node:net');
    await new Promise((ok, fail) => {
      const socket = net.createServer();
      socket.once('error', fail);
      socket.listen(port, '127.0.0.1', () => socket.close(ok));
    });
    child = spawn(process.execPath, argv, {
      cwd: service,
      env: {
        ...env,
        RENDER_JOB_DEADLINE_MS: String(deadlineMs),
        RENDER_JOB_TTL_MS: '1800000',
        RENDER_MAX_JOBS_PER_USER: '0',
        RENDER_SERVICE_NO_LISTEN: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    observation = observeLauncher(child, [process.execPath, ...argv], (value) => {
      report.launcher = value;
      persist();
    });
    api = await until(() => {
      if (observation.evidence.spawnError) throw new Error(observation.evidence.spawnError);
      return child.pid && proc(child.pid);
    }, 5000);
    await until(async () => {
      if (observation.evidence.exitObserved || observation.evidence.spawnError)
        throw new Error(`Service exited: ${observation.evidence.stderr}`);
      if (!observation.evidence.stdout.includes('[render-service] listening on')) return false;
      return get('/health');
    }, 30000);
    api = proc(child.pid);
    const children = ids(`/proc/${child.pid}/task/${child.pid}/children`).map(proc).filter(Boolean);
    supervisor = children.find((row) => row.cmdline.includes('resource-owner.mjs'));
    assert(supervisor, 'Missing dedicated S child');
    assert.match(
      api.status,
      new RegExp(
        `^Uid:\\s+${settings.owner.workerUid}\\s+${settings.owner.workerUid}\\s+${settings.owner.workerUid}\\s+${settings.owner.workerUid}$`,
        'm',
      ),
    );
    assert.match(api.status, /^CapEff:\s+0+$/m);
    assert.match(supervisor.status, /^Uid:\s+0\s+0\s+0\s+0$/m);
    assert(
      !supervisor.cgroup.includes(settings.owner.taskCgroupRoot.slice('/sys/fs/cgroup'.length)),
    );
    report.processes = { api, supervisor };
    report.health = await get('/health');
    assert.equal(report.health.accepting, true);
    assert.equal(report.health.versions?.producer, '0.8.37 (OpenMAIC resource patch)');
    assert.equal(report.health.resourceProfile?.name, checked.input.profile);
    assert.match(
      report.health.runtimeVersions?.chromium ?? report.health.versions?.chromium ?? '',
      /151\./,
    );
    sampler = setInterval(sample, 10);
    normalArtifact = await normal();
    if (name === 'normal') await normal();
    else {
      known.clear();
      gate = undefined;
      domain = undefined;
      const priorProjects = new Set(directories(settings.projectRoot));
      const id = await submitted(30);
      await until(
        () => {
          if (sampleError) throw sampleError;
          sample();
          return gate;
        },
        name === 'deadline' ? 12000 : 30000,
      );
      const project = directories(settings.projectRoot).filter((path) => !priorProjects.has(path));
      assert.equal(project.length, 1);
      report.taskProject = project[0];
      const guardian = proc(Number(/^PPid:\s+(\d+)$/m.exec(gate.worker.status)?.[1]));
      assert(guardian && /^PPid:\s+(\d+)$/m.exec(guardian.status)?.[1] === String(supervisor.pid));
      for (const row of gate.observed) {
        signal(row, 'SIGSTOP');
        frozen.push(row);
      }
      gate = mediaGate(ids(join(domain, 'cgroup.procs')).map(proc).filter(Boolean), domain);
      assert(gate, 'Live renderer and encoder required immediately before injection');
      assert.equal(read(join(domain, 'cpu.max')), '100000 100000');
      assert.equal(read(join(domain, 'memory.max')), '805306368');
      assert.equal(read(join(domain, 'pids.max')), String(settings.owner.taskPidsMax));
      report.injection = {
        gate,
        guardian,
        domain,
        atMonotonicMs: Number(process.hrtime.bigint()) / 1e6,
        cpuMax: read(join(domain, 'cpu.max')),
        memoryMax: read(join(domain, 'memory.max')),
        pidsMax: read(join(domain, 'pids.max')),
      };
      persist();
      let queued;
      if (name === 'ancestor-pressure') {
        queued = await submitted(1);
        assert.equal((await get(`/render/${queued}`)).status, 'queued');
      }
      if (name === 'cancel')
        assert.equal((await request(`/render/${id}`, { method: 'DELETE' })).status, 200);
      if (name === 'api-death') {
        signal(api, 'SIGKILL');
        await until(() => observation.evidence.exitObserved, 25000);
      }
      if (name === 'supervisor-death') signal(supervisor, 'SIGKILL');
      if (name === 'guardian-death') signal(guardian, 'SIGKILL');
      if (name === 'task-oom' || name === 'ancestor-pressure') {
        const target = name === 'task-oom' ? domain : session;
        const events = join(target, 'memory.events.local');
        memoryFd = fs.openSync(events, 'r');
        report.injection.eventsBefore = read(events);
        fs.writeFileSync(join(target, 'memory.max'), String(64 * 1024 * 1024));
        const bytes = Buffer.alloc(4096);
        report.injection.eventsAfter = bytes
          .subarray(0, fs.readSync(memoryFd, bytes, 0, bytes.length, 0))
          .toString();
        const counter = (text) => BigInt(/^oom (\d+)$/m.exec(text)?.[1] ?? '-1');
        assert(counter(report.injection.eventsBefore) >= 0n, 'Missing pre-injection OOM counter');
        assert(counter(report.injection.eventsAfter) > counter(report.injection.eventsBefore));
      }
      if (name !== 'api-death') {
        const job = await terminal(id);
        report.terminal = job;
        assert.equal(job.status, name === 'cancel' ? 'cancelled' : 'failed');
        const quarantined = ['supervisor-death', 'guardian-death'].includes(name);
        assertSettlement(job.resources, {
          published: name === 'supervisor-death' ? 'unknown' : false,
          reservationReturned: !quarantined,
          cleanupVerified: !quarantined,
          admissionClosed: quarantined || name === 'ancestor-pressure',
        });
        if (name === 'deadline') assert.match(job.error, /deadline/i);
        assert.notEqual((await request(`/render/${id}/download`)).status, 200);
        if (quarantined || name === 'ancestor-pressure') {
          assert.equal((await get('/health')).accepting, false);
          assert.equal((await submit()).status, 429);
        }
        if (queued) {
          report.queued = await terminal(queued);
          assert.equal(report.queued.status, 'failed');
        }
        const previous = await request(`/render/${normalArtifact.id}/download`);
        assert.equal(previous.status, 200);
        assert.equal(hash(Buffer.from(await previous.arrayBuffer())), normalArtifact.sha256);
        if (quarantined) {
          assert(fs.existsSync(domain), 'Unverified domain must remain for platform takeover');
          assert(fs.existsSync(project[0]), 'Quarantined project must be retained');
        } else await until(() => !fs.existsSync(project[0]), 5000);
      }
      await drained();
      report.faultDrained = {
        domain,
        reaped: [...report.reaped],
        projectRetained: fs.existsSync(report.taskProject),
        sessionRetained: fs.existsSync(session),
      };
      persist();
      if (['cancel', 'deadline', 'task-oom'].includes(name)) await normal();
      if (name === 'api-death') {
        await until(() => {
          reapOrphans();
          return !still(supervisor);
        }, 25000);
        assert(!fs.existsSync(session), 'S must close its session after HTTP lifeline loss');
        report.deadOwner = {
          httpExited: !still(api),
          supervisorExited: !still(supervisor),
          reservationReturned: 'NOT_OBSERVABLE_AFTER_HTTP_DEATH',
        };
      }
    }
    if (sampleError) throw sampleError;
    assert(
      [...known.values()].some(
        (row) => row.cmdline.includes('chrome') || row.cmdline.includes('headless_shell'),
      ),
      'No actual browser observed',
    );
    assert(
      [...known.values()].some((row) => row.cmdline.includes('ffmpeg')),
      'No actual encoder observed',
    );
    assert(still(supervisor) || ['api-death', 'supervisor-death'].includes(name));
    report.sameSupervisor = still(supervisor);
    bodyPassed = true;
  } catch (error) {
    report.error = error.stack;
    throw error;
  } finally {
    clearInterval(sampler);
    if (memoryFd !== undefined) fs.closeSync(memoryFd);
    report.observedProcesses = [...known.values()];
    // Only identities this invocation started/observed are signalled. Resume
    // injected stops so ordinary bounded cleanup can run; no cgroup force-kill,
    // chmod/remount, directory deletion or blind retry is hidden here.
    try {
      const cleanupDeadline = performance.now() + 25000;
      for (const row of frozen) if (still(row)) signal(row, 'SIGCONT');
      if (still(api)) signal(api, 'SIGTERM');
      // waitpid in the native orphan reaper can steal this direct child's
      // status between a /proc check and Node's SIGCHLD callback. Let Node
      // collect its child before invoking that reaper during shutdown.
      if (child?.pid && observation) await until(() => observation.evidence.exitObserved, 25000);
      await until(
        () => {
          reapOrphans();
          return (
            !still(api) &&
            !still(supervisor) &&
            [...known.values()].every((row) => !still(row)) &&
            [...guardians.values()].every((row) => !still(row))
          );
        },
        Math.max(0, cleanupDeadline - performance.now()),
      );
      report.cleanup = {
        status: 'PROCESSES_EXITED',
        sessionRetained: fs.existsSync(session),
        projectsRetained: fs.readdirSync(settings.projectRoot),
        platformCleanupRequired: true,
      };
      if (observation)
        await Promise.race([
          observation.done,
          delay(2000).then(() => {
            throw new Error('Service streams did not close');
          }),
        ]);
      if (observation && !['api-death', 'supervisor-death', 'guardian-death'].includes(name))
        assert.equal(observation.evidence.code, 0);
    } catch (error) {
      report.cleanup = { status: 'UNVERIFIED', error: error.stack, platformCleanupRequired: true };
    }
    report.finishedMonotonicMs = Number(process.hrtime.bigint()) / 1e6;
    report.status = bodyPassed && report.cleanup.status === 'PROCESSES_EXITED' ? 'PASS' : 'FAIL';
    persist();
    if (report.status !== 'PASS' && !report.error)
      throw new Error('Bounded service cleanup failed; platform takeover required');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, settings, name, evidence] = process.argv.slice(2);
  assert(
    ['--check', '--execute'].includes(mode) && settings && name && evidence,
    'Usage: node --import tsx test/resource-installed-linux.mjs --check|--execute SETTINGS CASE NEW_EVIDENCE',
  );
  if (mode === '--check') {
    const checked = checkInputs(resolve(settings), name, resolve(evidence));
    console.log(
      JSON.stringify(
        {
          status: 'INPUTS_CHECKED_NOT_EXECUTED',
          inputSha256: checked.inputSha256,
          input: checked.input,
        },
        null,
        2,
      ),
    );
  } else await runServiceCase(resolve(settings), name, resolve(evidence));
}
