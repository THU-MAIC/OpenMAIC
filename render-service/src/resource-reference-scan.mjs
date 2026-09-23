import { lstatSync, readFileSync, readlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_PIDS = 4096;
const MAX_HANDLES_PER_PROCESS = 8192;
const MAX_RECORDED = 64;
const MAX_TEXT = 4096;

function bounded(value) {
  return String(value ?? '').slice(0, MAX_TEXT);
}

function gone(error) {
  return error && typeof error === 'object' && ['ENOENT', 'ESRCH'].includes(error.code);
}

export function processIdentity(stat) {
  const end = stat.lastIndexOf(')');
  if (end < 0) throw new Error('Invalid process stat');
  const fields = stat.slice(end + 2).split(' ');
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('Missing process starttime');
  return { state: fields[0], starttime: fields[19] };
}

function identity(proc) {
  return processIdentity(readFileSync(join(proc, 'stat'), 'utf8'));
}

function sameDevice(path, device) {
  try {
    return statSync(path).dev === device;
  } catch (error) {
    if (gone(error)) return false;
    throw error;
  }
}

function linkTarget(path) {
  try {
    return bounded(readlinkSync(path));
  } catch {
    return null;
  }
}

function scanLinks(proc, directory, kind, device, references) {
  const root = join(proc, directory);
  let names;
  try {
    names = readdirSync(root);
  } catch (error) {
    if (gone(error)) return;
    throw error;
  }
  if (names.length > MAX_HANDLES_PER_PROCESS)
    throw new Error(`${directory} enumeration exceeded its bound`);
  for (const name of names) {
    const path = join(root, name);
    if (!sameDevice(path, device)) continue;
    if (references.length >= MAX_RECORDED) throw new Error('Reference evidence exceeded its bound');
    references.push({ kind, handle: name, target: linkTarget(path) });
  }
}

/**
 * Scan stable process identities for references to the task-private filesystem.
 * This closes the specific FD/mmap/cwd/root/exe gap that ordinary umount cannot
 * prove. It relies on readable host procfs and exclusive privileged ownership;
 * a privileged process racing the scan remains outside the product boundary.
 */
export function scanExternalReferences(privateRoot, taskCgroup, ownPid = process.pid) {
  const privateDevice = lstatSync(privateRoot).dev;
  const names = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  if (names.length > MAX_PIDS)
    return {
      status: 'COLLECTION_FAILED',
      scannedPids: 0,
      references: [],
      errors: [{ field: 'proc', error: 'PID enumeration exceeded its bound' }],
    };
  const references = [];
  const errors = [];
  let scannedPids = 0;
  for (const name of names) {
    const pid = Number(name);
    if (pid === ownPid) continue;
    const proc = join('/proc', name);
    let before;
    try {
      before = identity(proc);
    } catch (error) {
      if (gone(error)) continue;
      errors.push({
        pid,
        field: 'stat',
        error: bounded(error instanceof Error ? error.message : error),
      });
      if (errors.length >= MAX_RECORDED) break;
      continue;
    }
    if (before.state === 'Z') continue;
    try {
      const membership = readFileSync(join(proc, 'cgroup'), 'utf8');
      if (membership.includes(`0::${taskCgroup}\n`)) {
        errors.push({ pid, field: 'cgroup', error: 'Undrained task-cgroup process' });
        if (errors.length >= MAX_RECORDED) break;
        continue;
      }
      const processReferences = [];
      for (const [field, kind] of [
        ['cwd', 'cwd'],
        ['root', 'root'],
        ['exe', 'exe'],
      ]) {
        const path = join(proc, field);
        if (sameDevice(path, privateDevice))
          processReferences.push({ kind, handle: null, target: linkTarget(path) });
      }
      scanLinks(proc, 'fd', 'fd', privateDevice, processReferences);
      scanLinks(proc, 'map_files', 'mmap', privateDevice, processReferences);
      const after = identity(proc);
      if (after.starttime !== before.starttime) continue;
      scannedPids += 1;
      for (const item of processReferences) {
        if (references.length >= MAX_RECORDED)
          throw new Error('Reference evidence exceeded its bound');
        references.push({ pid, starttime: before.starttime, ...item });
      }
    } catch (error) {
      if (gone(error)) continue;
      errors.push({
        pid,
        field: 'referenceScan',
        error: bounded(error instanceof Error ? error.message : error),
      });
      if (errors.length >= MAX_RECORDED) break;
    }
  }
  return {
    status: errors.length ? 'COLLECTION_FAILED' : references.length ? 'REFERENCED' : 'CLEAR',
    scannedPids,
    references,
    errors,
    bounds: {
      maxPids: MAX_PIDS,
      maxHandlesPerProcess: MAX_HANDLES_PER_PROCESS,
      maxRecorded: MAX_RECORDED,
    },
  };
}
