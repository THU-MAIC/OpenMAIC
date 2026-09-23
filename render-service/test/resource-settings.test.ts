import { resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import {
  readResourceSettings,
  assertCanonicalProjectRoot,
  assertRootOwnedDirectory,
  assertRootOwnedWorkerTraversableDirectory,
  assertRootOwnedExecutable,
} from '../src/resource-settings.mjs';

vi.mock('node:fs', () => ({
  lstatSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
}));
const settings = '/etc/openmaic/settings.json';
const stats = new Map<string, { uid: number; mode: number; type: string }>();
beforeEach(() => {
  vi.clearAllMocks();
  stats.clear();
  for (const path of ['/', '/etc', '/etc/openmaic', settings])
    stats.set(path, { uid: 0, mode: 0o755, type: path === settings ? 'file' : 'directory' });
  vi.mocked(lstatSync).mockImplementation(((path: string) => {
    const row = stats.get(path) ?? { uid: 0, mode: 0o755, type: 'directory' };
    return {
      ...row,
      isFile: () => row.type === 'file',
      isDirectory: () => row.type === 'directory',
    };
  }) as typeof lstatSync);
  vi.mocked(readFileSync).mockReturnValue('{"owner":{"workerUid":65534}}');
  vi.mocked(realpathSync).mockImplementation((path) => resolve(String(path)));
});
it('reads only after checking the full root-controlled chain', () => {
  expect(readResourceSettings(settings)).toEqual({ owner: { workerUid: 65534 } });
  expect(vi.mocked(lstatSync).mock.calls.map(([path]) => path)).toEqual([
    '/',
    '/etc',
    '/etc/openmaic',
    settings,
  ]);
  expect(vi.mocked(readFileSync).mock.invocationCallOrder[0]).toBeGreaterThan(
    vi.mocked(lstatSync).mock.invocationCallOrder.at(-1)!,
  );
});
it.each([
  ['/etc', { mode: 0o777 }],
  ['/etc/openmaic', { mode: 0o775 }],
  ['/etc/openmaic', { uid: 65534 }],
  ['/etc/openmaic', { type: 'symlink' }],
  [settings, { mode: 0o666 }],
  [settings, { uid: 65534 }],
  [settings, { type: 'symlink' }],
  [settings, { type: 'directory' }],
] as const)('rejects unsafe component %s before reading configuration', (path, change) => {
  stats.set(path, { ...stats.get(path)!, ...change });
  expect(() => readResourceSettings(settings)).toThrow('root-owned');
  expect(readFileSync).not.toHaveBeenCalled();
});
it('rechecks trust on the second privileged read instead of inheriting a previous check', () => {
  readResourceSettings(settings);
  vi.mocked(readFileSync).mockClear();
  stats.get('/etc/openmaic')!.uid = 65534;
  expect(() => readResourceSettings(settings)).toThrow('root-owned');
  expect(readFileSync).not.toHaveBeenCalled();
});
it('rejects a symlink component in the configured project root', () => {
  vi.mocked(realpathSync).mockReturnValue('/run/openmaic/projects');
  expect(() => assertCanonicalProjectRoot('/var/run/openmaic/projects')).toThrow('canonical');
  expect(() => assertCanonicalProjectRoot('/run/openmaic/projects')).not.toThrow();
});
it('rejects relative paths', () => {
  expect(() => assertCanonicalProjectRoot('relative/projects')).toThrow('canonical');
});
it.each(['/opt/projects/', '/opt/other/../projects'])(
  'accepts equivalent normalized directory spelling %s',
  (path) => expect(() => assertCanonicalProjectRoot(path)).not.toThrow(),
);
it('rejects a regular file used as the project root', () => {
  stats.set('/opt/projects', { uid: 0, mode: 0o644, type: 'file' });
  expect(() => assertCanonicalProjectRoot('/opt/projects')).toThrow('directory');
});
it('requires a canonical root-owned non-writable state directory', () => {
  stats.set('/run/openmaic-resource', { uid: 0, mode: 0o755, type: 'directory' });
  expect(() => assertRootOwnedDirectory('/run/openmaic-resource')).not.toThrow();
  stats.get('/run/openmaic-resource')!.mode = 0o775;
  expect(() => assertRootOwnedDirectory('/run/openmaic-resource')).toThrow('root-owned');
});
it('requires execute-only traversal for the unprivileged task worker', () => {
  stats.set('/run/openmaic-resource', { uid: 0, mode: 0o711, type: 'directory' });
  expect(() => assertRootOwnedWorkerTraversableDirectory('/run/openmaic-resource')).not.toThrow();
  stats.get('/run/openmaic-resource')!.mode = 0o700;
  expect(() => assertRootOwnedWorkerTraversableDirectory('/run/openmaic-resource')).toThrow(
    'other-execute traversal',
  );
});
it('requires fixed root-owned executable tool paths', () => {
  stats.set('/usr/bin/ffmpeg', { uid: 0, mode: 0o755, type: 'file' });
  expect(() => assertRootOwnedExecutable('/usr/bin/ffmpeg')).not.toThrow();
  stats.get('/usr/bin/ffmpeg')!.mode = 0o644;
  expect(() => assertRootOwnedExecutable('/usr/bin/ffmpeg')).toThrow('executable');
});
