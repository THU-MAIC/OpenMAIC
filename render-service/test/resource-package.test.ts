import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { verifyResourcePackage, requireLinuxPlatformLock } from '../scripts/resource-package.mjs';
const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it.each(['arm64', 'x64'])('requires a matching frozen Linux %s dependency', (arch) => {
  const lock = JSON.parse(
    readFileSync(new URL('../producer-patch/consumer-lock.json', import.meta.url), 'utf8'),
  );
  const key = `node_modules/@esbuild/linux-${arch}`;
  expect(requireLinuxPlatformLock(lock, arch)).toBe(key);
  const row = lock.packages[key];
  delete lock.packages[key];
  expect(() => requireLinuxPlatformLock(lock, arch)).toThrow('platform lock');
  lock.packages[key] = { ...row, version: '0.0.0' };
  expect(() => requireLinuxPlatformLock(lock, arch)).toThrow('platform lock');
  lock.packages[key] = { ...row, cpu: ['other'] };
  expect(() => requireLinuxPlatformLock(lock, arch)).toThrow('platform lock');
});
it('rejects an unqualified architecture', () => {
  expect(() => requireLinuxPlatformLock({}, 'riscv64')).toThrow('Unsupported');
});
function installed() {
  const root = mkdtempSync(join(tmpdir(), 'resource-package-'));
  directories.push(root);
  const producer = join(root, 'node_modules/@hyperframes/producer');
  const files: Record<string, string> = {};
  for (const file of [
    'package.json',
    'dist/resources.js',
    'dist/resourceWorker.js',
    'dist/index.js',
    'dist/native/resource-launcher',
    'dist/native/resource-supervisor.node',
  ]) {
    mkdirSync(join(producer, file, '..'), { recursive: true });
    writeFileSync(join(producer, file), file);
    files[file] = hash(file);
  }
  writeFileSync(join(root, 'package-lock.json'), '{}');
  const receipt = {
    source: JSON.parse(
      readFileSync(new URL('../producer-patch/source.json', import.meta.url), 'utf8'),
    ),
    arch: process.arch,
    consumerLockSha256: hash('{}'),
    producerFiles: files,
  };
  const save = () => writeFileSync(join(root, 'resource-build.json'), JSON.stringify(receipt));
  save();
  return { root, producer, receipt, save };
}
it('verifies the built package before any code is imported', () => {
  const { producer } = installed();
  expect(verifyResourcePackage(producer)).toBe(realpathSync(producer));
});
it.each(['source', 'arch', 'lock', 'bundle', 'missing'])('rejects %s identity drift', (kind) => {
  const { root, producer, receipt, save } = installed();
  if (kind === 'source') receipt.source.patchSha256 = '0'.repeat(64);
  if (kind === 'arch') receipt.arch = 'other';
  if (kind === 'lock') writeFileSync(join(root, 'package-lock.json'), '{"changed":true}');
  if (kind === 'bundle') writeFileSync(join(producer, 'dist/resources.js'), 'changed');
  if (kind === 'missing') delete receipt.producerFiles['dist/native/resource-supervisor.node'];
  save();
  expect(() => verifyResourcePackage(producer)).toThrow();
});
