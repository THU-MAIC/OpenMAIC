import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const CGROUP_ROOT = '/sys/fs/cgroup';
const MAX_ANCESTORS = 64;
const MAX_CONTROL_BYTES = 64 * 1024;

function boundedRead(path, readFile) {
  const value = readFile(path, 'utf8');
  if (Buffer.byteLength(value) > MAX_CONTROL_BYTES)
    throw new Error(`Oversized cgroup control file: ${path}`);
  return value.trim();
}

function unsigned(value, label) {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label}`);
  return BigInt(value);
}

function localCounter(text, key) {
  const match = new RegExp(`^${key} (\\d+)$`, 'm').exec(text);
  if (!match?.[1]) throw new Error(`Missing local memory event ${key}`);
  return BigInt(match[1]);
}

export function compareAncestorPressure(previous, current) {
  if (previous.length !== current.length) throw new Error('Ancestor pressure identity changed');
  const triggers = [];
  current.forEach((row, index) => {
    const before = previous[index];
    if (!before || before.path !== row.path) throw new Error('Ancestor pressure identity changed');
    for (const event of ['high', 'max', 'oom']) {
      const a = localCounter(before.memoryEventsLocal, event);
      const b = localCounter(row.memoryEventsLocal, event);
      if (b < a) throw new Error(`Ancestor memory ${event} counter reset`);
      if (b > a) triggers.push({ path: row.path, event, before: String(a), after: String(b) });
    }
    const currentBytes = unsigned(row.memoryCurrent, 'ancestor memory.current');
    if (
      row.memoryHigh !== 'max' &&
      currentBytes >= unsigned(row.memoryHigh, 'ancestor memory.high')
    )
      triggers.push({
        path: row.path,
        event: 'at-memory.high',
        before: row.memoryHigh,
        after: row.memoryCurrent,
      });
  });
  return { ancestors: current, triggers };
}

function unifiedMembership(text) {
  const rows = text
    .split('\n')
    .filter(Boolean)
    .filter((row) => row.startsWith('0::'));
  if (rows.length !== 1) throw new Error('Unified cgroup membership is unavailable');
  const membership = rows[0].slice(3);
  if (!membership.startsWith('/')) throw new Error('Invalid unified cgroup membership');
  return membership;
}

function sharedSlice(membership) {
  const own = resolve(CGROUP_ROOT, `.${membership}`);
  if (!own.startsWith(`${CGROUP_ROOT}/`) || dirname(own) === CGROUP_ROOT)
    throw new Error('Resource owner must run below an explicit systemd slice');
  const parent = dirname(own);
  const unit = basename(parent);
  if (!unit.endsWith('.slice'))
    throw new Error('Resource owner cgroup parent is not a systemd slice');
  return { path: parent, unit };
}

function ancestorPaths(first) {
  const paths = [];
  for (let current = first; current !== CGROUP_ROOT; current = dirname(current)) {
    if (!current.startsWith(`${CGROUP_ROOT}/`))
      throw new Error('Ancestor pressure path escaped cgroup v2');
    if (paths.length >= MAX_ANCESTORS) throw new Error('Too many visible cgroup ancestors');
    paths.push(current);
  }
  return paths;
}

/**
 * Monitor the shared ancestors of this owner and its transient task units.
 * This closes admission on local ancestor pressure; it is not a capacity ledger.
 */
export function createAncestorPressureMonitor(dependencies = {}) {
  const readFile = dependencies.readFile ?? readFileSync;
  const membership = unifiedMembership(
    dependencies.membership ?? boundedRead('/proc/self/cgroup', readFile),
  );
  const slice = sharedSlice(membership);
  const paths = ancestorPaths(slice.path);
  const readSnapshot = () =>
    paths.map((path) => ({
      path,
      memoryCurrent: boundedRead(join(path, 'memory.current'), readFile),
      memoryHigh: boundedRead(join(path, 'memory.high'), readFile),
      memoryMax: boundedRead(join(path, 'memory.max'), readFile),
      memoryEventsLocal: boundedRead(join(path, 'memory.events.local'), readFile),
    }));
  const baseline = readSnapshot();
  // Validate all required counters and reject an already-saturated ancestor.
  const initial = compareAncestorPressure(baseline, baseline);
  if (initial.triggers.length)
    throw Object.assign(new Error('Ancestor memory pressure is already present'), {
      details: initial,
    });

  let failure;
  let timer;
  let notify;
  const fail = (reason, details) => {
    if (failure) return false;
    failure = { reason, details };
    console.error(
      'Resource ancestor pressure closed admission:',
      JSON.stringify(failure).slice(0, MAX_CONTROL_BYTES),
    );
    if (timer) clearInterval(timer);
    notify?.(failure);
    return false;
  };
  const check = () => {
    if (failure) return false;
    try {
      const observation = compareAncestorPressure(baseline, readSnapshot());
      return observation.triggers.length ? fail('ancestor_memory_pressure', observation) : true;
    } catch (error) {
      return fail('ancestor_pressure_unverifiable', {
        error: String(error instanceof Error ? error.message : error).slice(0, 4096),
      });
    }
  };
  return {
    taskSlice: slice.unit,
    paths: [...paths],
    check,
    failure: () => failure,
    start(onFailure) {
      notify = onFailure;
      if (failure) notify(failure);
      else timer = setInterval(check, 100).unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
