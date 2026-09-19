import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A missing optional native dependency must not qualify the target platform. */
export function requireLinuxPlatformLock(lock, arch = process.arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported Linux architecture: ${arch}`);
  const key = `node_modules/@esbuild/linux-${arch}`;
  const row = lock.packages?.[key];
  const esbuild = lock.packages?.['node_modules/esbuild'];
  if (
    !row ||
    !esbuild ||
    row.version !== esbuild.version ||
    esbuild.optionalDependencies?.[`@esbuild/linux-${arch}`] !== row.version ||
    !row.cpu?.includes(arch) ||
    !row.os?.includes('linux') ||
    !row.integrity
  )
    throw new Error(`Missing or inconsistent Linux platform lock: ${key}`);
  return key;
}

/** Verify the isolated installed artifact before loading native or Producer code. */
export function verifyResourcePackage(input) {
  const root = realpathSync(input);
  const expected = JSON.parse(
    readFileSync(new URL('../producer-patch/source.json', import.meta.url), 'utf8'),
  );
  const receipt = JSON.parse(readFileSync(resolve(root, '../../../resource-build.json'), 'utf8'));
  if (
    receipt.source?.revision !== expected.revision ||
    receipt.source?.patchSha256 !== expected.patchSha256 ||
    receipt.arch !== process.arch
  )
    throw new Error('Resource build source/architecture mismatch');
  if (
    digest(readFileSync(resolve(root, '../../../package-lock.json'))) !== receipt.consumerLockSha256
  )
    throw new Error('Resource consumer lock mismatch');
  for (const required of [
    'package.json',
    'dist/resources.js',
    'dist/resourceWorker.js',
    'dist/index.js',
    'dist/native/resource-launcher',
    'dist/native/resource-supervisor.node',
  ]) {
    if (typeof receipt.producerFiles?.[required] !== 'string')
      throw new Error(`Missing resource build identity: ${required}`);
  }
  for (const [file, hash] of Object.entries(receipt.producerFiles)) {
    const path = resolve(root, file);
    if (
      !path.startsWith(root + sep) ||
      realpathSync(path) !== path ||
      digest(readFileSync(path)) !== hash
    )
      throw new Error(`Resource installed file mismatch: ${file}`);
  }
  return root;
}
