import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { assertSettlement, processIdentity, cgroupDirectory } from './resource-installed-linux.mjs';

it('extracts starttime despite spaces and parentheses in the process name', () => {
  const stat = `42 (worker (media) owner) S ${Array(18).fill('0').join(' ')} 98765 1 2`;
  expect(processIdentity(stat)).toBe('98765');
  expect(() => processIdentity('42 (worker) S 0')).toThrow('Missing process starttime');
});
it('rejects absent, partial and contradictory HTTP settlement', () => {
  const expected = {
    published: false,
    cleanupVerified: true,
    reservationReturned: true,
    admissionClosed: false,
  };
  expect(() => assertSettlement(undefined, expected)).toThrow('Missing service settlement');
  expect(() => assertSettlement({ status: 'PASS' }, expected)).toThrow();
  expect(() => assertSettlement({ ...expected, reservationReturned: false }, expected)).toThrow(
    'reservationReturned',
  );
  expect(() => assertSettlement({ ...expected, published: true }, expected)).toThrow('published');
  expect(() => assertSettlement(expected, expected)).not.toThrow();
});
it('preserves unknown publication after S loss instead of treating it as false', () => {
  const expected = {
    published: 'unknown',
    cleanupVerified: false,
    reservationReturned: false,
    admissionClosed: true,
  };
  expect(() => assertSettlement({ ...expected, published: false }, expected)).toThrow('published');
  expect(() => assertSettlement(expected, expected)).not.toThrow();
});
it.skipIf(process.platform === 'linux')(
  'rejects the actual Linux entry on another OS before reading inputs or consuming evidence',
  () => {
    const scratch = mkdtempSync(join(tmpdir(), 'service-linux-guard-'));
    const evidence = join(scratch, 'unused-run');
    try {
      for (const mode of ['--check', '--execute']) {
        expect(() =>
          execFileSync(
            process.execPath,
            [
              '--import',
              'tsx',
              'test/resource-installed-linux.mjs',
              mode,
              '/nonexistent/settings.json',
              'normal',
              evidence,
            ],
            { cwd: resolve(import.meta.dirname, '..'), timeout: 10000, stdio: 'pipe' },
          ),
        ).toThrow();
        expect(existsSync(evidence)).toBe(false);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

it('rejects hidden cgroup ancestry instead of walking outside the mount or looping at root', () => {
  expect(cgroupDirectory('0::/')).toBe('/sys/fs/cgroup');
  expect(cgroupDirectory('0::/validation.service')).toBe('/sys/fs/cgroup/validation.service');
  expect(() => cgroupDirectory('0::/../../host')).toThrow('hidden');
  expect(() => cgroupDirectory('1:memory:/host')).toThrow('unified');
});
