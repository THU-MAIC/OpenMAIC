import {
  chmodSync,
  mkdirSync,
  renameSync,
  statSync,
  fstatSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { copyStage } from '../src/resource-stage-copy.mjs';
import {
  bindProjectDirectory,
  buildStageCopyArguments,
  closeoutTask,
  transferCandidate,
} from '../src/resource-task-runner.mjs';

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function root() {
  const path = mkdtempSync(join(tmpdir(), 'openmaic-task-closeout-'));
  roots.push(path);
  return path;
}

const testUid = process.getuid!();
const testGid = process.getgid!();
const identity = {
  getuid: () => testUid,
  getgid: () => testGid,
  getgroups: () => [testGid],
};

it.each([0o600, 0o6755])(
  'copies a source mode %s as bytes into an exclusive fixed-mode stage',
  (sourceMode) => {
    const directory = root();
    const candidate = join(directory, 'candidate.mp4');
    const stage = join(directory, 'stage.mp4');
    writeFileSync(candidate, 'candidate-bytes');
    chmodSync(candidate, sourceMode);

    const result = copyStage(candidate, stage, testUid, testGid, identity);

    expect(readFileSync(stage, 'utf8')).toBe('candidate-bytes');
    expect(lstatSync(stage).mode & 0o7777).toBe(0o600);
    expect(result).toMatchObject({ bytes: 15, mode: 0o600 });
  },
);

it('rejects a candidate symlink without creating a stage', () => {
  const directory = root();
  const target = join(directory, 'target');
  const candidate = join(directory, 'candidate.mp4');
  const stage = join(directory, 'stage.mp4');
  writeFileSync(target, 'sensitive bytes');
  symlinkSync(target, candidate);

  expect(() => copyStage(candidate, stage, testUid, testGid, identity)).toThrow();
  expect(existsSync(stage)).toBe(false);
});

it('does not follow or replace a pre-existing destination symlink', () => {
  const directory = root();
  const candidate = join(directory, 'candidate.mp4');
  const target = join(directory, 'target');
  const stage = join(directory, 'stage.mp4');
  writeFileSync(candidate, 'candidate-bytes');
  writeFileSync(target, 'keep-me');
  symlinkSync(target, stage);

  expect(() => copyStage(candidate, stage, testUid, testGid, identity)).toThrow();
  expect(readFileSync(target, 'utf8')).toBe('keep-me');
  expect(lstatSync(stage).isSymbolicLink()).toBe(true);
});

it('places setpriv and capability clearing before the trusted copy program', () => {
  const args = buildStageCopyArguments(
    { workerUid: 1001, workerGid: 1002 },
    '/private/out/candidate.mp4',
    '/projects/job/stage.mp4',
  );
  expect(args.slice(0, 7)).toEqual([
    '--reuid=1001',
    '--regid=1002',
    '--clear-groups',
    '--bounding-set=-all',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--no-new-privs',
  ]);
  expect(args.slice(-4)).toEqual([
    '/private/out/candidate.mp4',
    '/projects/job/stage.mp4',
    '1001',
    '1002',
  ]);
});

it('spawns the copy helper from a trusted cwd and accepts only fixed-identity evidence', async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    pid: number;
  };
  child.stdout = new PassThrough();
  child.pid = 42;
  const spawn = vi.fn(() => child);
  const transfer = transferCandidate(
    { workerUid: 1001, workerGid: 1002 },
    '/private/out/candidate.mp4',
    '/projects/job/stage.mp4',
    { spawn },
  );
  child.stdout.end(
    `${JSON.stringify({
      bytes: 12,
      sourceDevice: 1,
      destinationDevice: 2,
      uid: 1001,
      gid: 1002,
      mode: 0o600,
    })}\n`,
  );
  child.emit('exit', 0, null);
  child.emit('close', 0, null);

  await expect(transfer).resolves.toMatchObject({ bytes: 12, mode: 0o600 });
  expect(spawn).toHaveBeenCalledWith(
    '/usr/bin/setpriv',
    expect.arrayContaining(['--clear-groups', '--bounding-set=-all', '--no-new-privs']),
    expect.objectContaining({ cwd: '/', stdio: ['ignore', 'pipe', 'inherit'] }),
  );
});

it('waits for stdio close before parsing successful copy evidence', async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    pid: number;
  };
  child.stdout = new PassThrough();
  child.pid = 42;
  const transfer = transferCandidate(
    { workerUid: 1001, workerGid: 1002 },
    '/private/out/candidate.mp4',
    '/projects/job/stage.mp4',
    { spawn: vi.fn(() => child) },
  );
  let settled = false;
  void transfer.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  child.emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  child.stdout.end(
    `${JSON.stringify({
      bytes: 12,
      sourceDevice: 1,
      destinationDevice: 2,
      uid: 1001,
      gid: 1002,
      mode: 0o600,
    })}\n`,
  );
  child.emit('close', 0, null);

  await expect(transfer).resolves.toMatchObject({ bytes: 12, mode: 0o600 });
});

it('preserves a stage-copy launch error until stdio closes', async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    pid: number;
  };
  child.stdout = new PassThrough();
  child.pid = 42;
  const transfer = transferCandidate(
    { workerUid: 1001, workerGid: 1002 },
    '/private/out/candidate.mp4',
    '/projects/job/stage.mp4',
    { spawn: vi.fn(() => child) },
  );

  child.emit('error', new Error('setpriv could not start'));
  child.stdout.end();
  child.emit('close', null, null);

  await expect(transfer).rejects.toThrow('Unprivileged stage copy failed: setpriv could not start');
});

function closeoutFixture(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      cleanupTimeoutMs: 100,
      stagePath: '/projects/job/stage.mp4',
      workerUid: 1001,
      workerGid: 1001,
    },
    group: '/sys/fs/cgroup/tasks/task.service',
    privateRoot: '/run/openmaic/task/private',
    privateProject: '/run/openmaic/task/private/project',
    candidate: '/run/openmaic/task/private/out/candidate.mp4',
    workerExit: { code: 0, signal: null },
    isStopping: () => false,
    projectMounted: true,
    privateMounted: true,
    ...overrides,
  };
}

it('runs the production drain, reference, transfer, and unmount gates in order', async () => {
  const calls: string[] = [];
  const result = await closeoutTask(closeoutFixture(), {
    drain: vi.fn(async () => {
      calls.push('drain');
      return { drained: true, remaining: [] };
    }),
    scanReferences: vi.fn(() => {
      calls.push('scan');
      return { status: 'CLEAR', references: [], errors: [] };
    }),
    transfer: vi.fn(async () => {
      calls.push('transfer');
      return { bytes: 10, sourceDevice: 1, destinationDevice: 2, mode: 0o600 };
    }),
    command: vi.fn((_file: string, args: string[]) => calls.push(`umount:${args[0]}`)),
    remove: vi.fn(() => calls.push('remove-private-root')),
  });

  expect(calls).toEqual([
    'drain',
    'scan',
    'transfer',
    'umount:/run/openmaic/task/private/project',
    'umount:/run/openmaic/task/private',
    'remove-private-root',
  ]);
  expect(result).toMatchObject({ status: 'succeeded', cleanupVerified: true });
});

it('does not transfer when descendant drain or reference evidence fails', async () => {
  const transfer = vi.fn();
  const drainFailure = await closeoutTask(closeoutFixture(), {
    drain: vi
      .fn()
      .mockResolvedValueOnce({ drained: false, remaining: [42] })
      .mockResolvedValueOnce({ drained: true, remaining: [] }),
    scanReferences: vi.fn(() => ({ status: 'CLEAR', references: [], errors: [] })),
    transfer,
    command: vi.fn(),
    remove: vi.fn(),
  });
  expect(drainFailure).toMatchObject({ status: 'failed', cleanupVerified: false });
  expect(transfer).not.toHaveBeenCalled();

  const referenceFailure = await closeoutTask(closeoutFixture(), {
    drain: vi.fn(async () => ({ drained: true, remaining: [] })),
    scanReferences: vi.fn(() => ({ status: 'REFERENCED', references: [{ pid: 7 }], errors: [] })),
    transfer,
    command: vi.fn(),
    remove: vi.fn(),
  });
  expect(referenceFailure).toMatchObject({ status: 'failed', cleanupVerified: false });
  expect(transfer).not.toHaveBeenCalled();
});

it('does not transfer after cancellation and rejects cancellation during transfer', async () => {
  const transfer = vi.fn(async () => ({ bytes: 10 }));
  const cancelled = await closeoutTask(closeoutFixture({ isStopping: () => true }), {
    drain: vi.fn(async () => ({ drained: true, remaining: [] })),
    scanReferences: vi.fn(() => ({ status: 'CLEAR', references: [], errors: [] })),
    transfer,
    command: vi.fn(),
    remove: vi.fn(),
  });
  expect(cancelled).toMatchObject({ status: 'failed', failureCode: 'cancelled' });
  expect(transfer).not.toHaveBeenCalled();

  let stopping = false;
  const duringTransfer = await closeoutTask(closeoutFixture({ isStopping: () => stopping }), {
    drain: vi.fn(async () => ({ drained: true, remaining: [] })),
    scanReferences: vi.fn(() => ({ status: 'CLEAR', references: [], errors: [] })),
    transfer: vi.fn(async () => {
      stopping = true;
      return { bytes: 10 };
    }),
    command: vi.fn(),
    remove: vi.fn(),
  });
  expect(duringTransfer).toMatchObject({
    status: 'failed',
    failureCode: 'cancelled',
    cleanupVerified: true,
  });
});

it('settles a transfer failure without reporting task success', async () => {
  const result = await closeoutTask(closeoutFixture(), {
    drain: vi.fn(async () => ({ drained: true, remaining: [] })),
    scanReferences: vi.fn(() => ({ status: 'CLEAR', references: [], errors: [] })),
    transfer: vi.fn(async () => {
      throw new Error('stage copy rejected candidate');
    }),
    command: vi.fn(),
    remove: vi.fn(),
  });

  expect(result).toMatchObject({
    status: 'failed',
    failureCode: 'execution_failed',
    cleanupVerified: true,
    details: { failure: 'stage copy rejected candidate' },
  });
});

const validCopyEvidence = {
  bytes: 12,
  sourceDevice: 1,
  destinationDevice: 2,
  uid: 1001,
  gid: 1002,
  mode: 0o600,
};
it.each([
  ['nonzero exit', JSON.stringify(validCopyEvidence), 1],
  ['malformed JSON', '{', 0],
  ['null evidence', 'null', 0],
  ...Object.entries({
    bytes: 0,
    uid: 0,
    gid: 0,
    mode: 0o777,
    sourceDevice: '1',
    destinationDevice: '2',
  }).map(([key, value]) => [key, JSON.stringify({ ...validCopyEvidence, [key]: value }), 0]),
  ['same device', JSON.stringify({ ...validCopyEvidence, destinationDevice: 1 }), 0],
])('rejects %s without falling back to a root copy', async (_name, output, code) => {
  const directory = root();
  const candidate = join(directory, 'candidate');
  const stage = join(directory, 'stage');
  writeFileSync(candidate, 'bytes accessible to the parent');
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), pid: 42 });
  const spawn = vi.fn(() => child);
  const onChild = vi.fn();
  const result = transferCandidate({ workerUid: 1001, workerGid: 1002 }, candidate, stage, {
    spawn,
    onChild,
  });
  expect(onChild).toHaveBeenCalledWith(child);
  child.stdout.end(String(output));
  child.emit('close', code, null);
  await expect(result).rejects.toThrow();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(onChild).toHaveBeenLastCalledWith(undefined);
  expect(existsSync(stage)).toBe(false);
});

it.each([
  { ...identity, getuid: () => testUid + 1 },
  { ...identity, getgid: () => testGid + 1 },
  { ...identity, getgroups: () => [testGid, testGid + 1] },
])('refuses copying before file access when worker identity is wrong', (wrongIdentity) => {
  const directory = root();
  const candidate = join(directory, 'candidate');
  const stage = join(directory, 'stage');
  writeFileSync(candidate, 'candidate');
  expect(() => copyStage(candidate, stage, testUid, testGid, wrongIdentity)).toThrow(
    /identity|groups/,
  );
  expect(existsSync(stage)).toBe(false);
});

it('binds an inherited directory descriptor and rejects a replacement inode or symlink', () => {
  const directory = root();
  const project = join(directory, 'project');
  mkdirSync(project);
  const expected = statSync(project);
  const execute = vi.fn((_file, args, options) => {
    expect(args).toEqual(['--no-canonicalize', '--bind', '/proc/self/fd/3', '/private/project']);
    const actual = fstatSync(options.stdio[3]);
    expect(actual.ino).toBe(expected.ino);
    expect(actual.dev).toBe(expected.dev);
  });
  bindProjectDirectory(project, '/private/project', expected, { execFileSync: execute });
  renameSync(project, join(directory, 'original'));
  mkdirSync(project);
  expect(() =>
    bindProjectDirectory(project, '/private/project', expected, { execFileSync: execute }),
  ).toThrow(/identity/);
  rmSync(project, { recursive: true });
  symlinkSync(join(directory, 'original'), project);
  expect(() =>
    bindProjectDirectory(project, '/private/project', expected, { execFileSync: execute }),
  ).toThrow();
  expect(execute).toHaveBeenCalledTimes(1);
});
