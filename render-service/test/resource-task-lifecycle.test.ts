import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const os = vi.hoisted(() => ({ spawn: vi.fn(), command: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: os.spawn, execFileSync: os.command }));
vi.mock('../src/resource-reference-scan.mjs', () => ({
  scanExternalReferences: () => ({ status: 'CLEAR', references: [], errors: [] }),
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync(path: string, ...args: unknown[]) {
      if (path === '/proc/self/cgroup') return '0::/test-task\n';
      if (String(path).startsWith('/sys/fs/cgroup/')) {
        if (String(path).endsWith('/cgroup.procs')) return `${process.pid}\n`;
        return '1\n';
      }
      return Reflect.apply(fs.readFileSync, fs, [path, ...args]);
    },
    readlinkSync(path: string) {
      return path === '/proc/self/ns/mnt' ? 'mnt:[test]' : fs.readlinkSync(path);
    },
  };
});
import { runTask } from '../src/resource-task-runner.mjs';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  os.spawn.mockReset();
  os.command.mockReset();
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

it('routes production cancellation to the active copy helper, unregisters it, and refuses success', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resource-task-cancel-')));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  const tool = join(root, 'tool');
  writeFileSync(tool, 'fixture');
  const worker = new EventEmitter();
  const helper = Object.assign(new EventEmitter(), { pid: 123456, stdout: new PassThrough() });
  os.spawn
    .mockImplementationOnce(() => {
      queueMicrotask(() => worker.emit('exit', 0, null));
      return worker;
    })
    .mockReturnValueOnce(helper);
  const handlers = new Map<string, () => void>();
  const once = process.once.bind(process);
  vi.spyOn(process, 'once').mockImplementation(
    (event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGTERM' || event === 'SIGINT') {
        handlers.set(event, listener);
        return process;
      }
      return once(event, listener);
    },
  );
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const pending = runTask({
    id: 'cancel-copy',
    projectDir: project,
    projectIdentity: statSync(project),
    stagePath: join(project, 'stage.mp4'),
    privateRoot: join(root, 'private'),
    resultPath: join(root, 'result.json'),
    browserPath: tool,
    ffmpegPath: tool,
    workerUid: process.getuid!(),
    workerGid: process.getgid!(),
    cleanupTimeoutMs: 100,
    memoryBytes: 1024 * 1024,
    producerEnvironment: {},
    options: {},
  });
  // Wait until main's actual transfer callback has registered the helper.
  await vi.waitFor(() => expect(os.spawn).toHaveBeenCalledTimes(2));
  expect(os.spawn.mock.calls[1][1]).toEqual(
    expect.arrayContaining([expect.stringContaining('resource-stage-copy.mjs')]),
  );
  handlers.get('SIGTERM')!();
  // Always release the simulated child, including when testing a broken registration.
  const signalled = kill.mock.calls.slice();
  helper.stdout.end(
    JSON.stringify({
      bytes: 12,
      uid: process.getuid!(),
      gid: process.getgid!(),
      mode: 0o600,
      sourceDevice: 1,
      destinationDevice: 2,
    }),
  );
  helper.emit('close', 0, null);
  const result = await pending;
  expect(signalled).toEqual([[helper.pid, 'SIGTERM']]);
  expect(result).toMatchObject({ status: 'failed', failureCode: 'cancelled' });
  expect(JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')).status).toBe('failed');
  kill.mockClear();
  handlers.get('SIGINT')!();
  expect(kill).not.toHaveBeenCalled();
});
