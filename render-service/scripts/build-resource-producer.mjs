/** Build the existing resource implementation as OpenMAIC's private dependency.
 * --check applies and verifies source in a temporary directory only.
 * --build additionally installs the frozen upstream build dependencies, builds
 * six packages, packs them, and installs the frozen private consumer. Run that
 * operation only inside the explicitly provisioned Linux build environment.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const inputs = resolve(here, '../producer-patch');
const specification = JSON.parse(readFileSync(join(inputs, 'source.json'), 'utf8'));
const patch = join(inputs, 'producer.patch');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const mode = args[0];
const source = args[1] && resolve(args[1]);
const output = args[2] && resolve(args[2]);
if (!['--check', '--build'].includes(mode) || !source || (mode === '--build' && !output)) {
  throw new Error(
    'Usage: node scripts/build-resource-producer.mjs --check SOURCE | --build SOURCE NEW_OUTPUT',
  );
}
if (hash(readFileSync(patch)) !== specification.patchSha256)
  throw new Error('Producer patch identity mismatch');
const env = {
  ...process.env,
  PUPPETEER_SKIP_DOWNLOAD: 'true',
  HYPERFRAMES_BUILD_NATIVE: '0',
  GIT_LFS_SKIP_SMUDGE: '1',
};
function run(command, values, cwd, capture = false) {
  return execFileSync(command, values, {
    cwd,
    env,
    timeout: 720_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}
const gitConfig = [
  '-c',
  'filter.lfs.process=',
  '-c',
  'filter.lfs.smudge=cat',
  '-c',
  'filter.lfs.required=false',
];
const base = run('git', ['rev-parse', 'HEAD'], source, true).toString().trim();
if (base !== specification.revision)
  throw new Error(`Expected source HEAD ${specification.revision}, got ${base}`);
const scratch = mkdtempSync(join(tmpdir(), 'openmaic-producer-build-'));
try {
  const checkout = join(scratch, 'source');
  mkdirSync(checkout);
  if (mode === '--check') {
    const tracked = new Set(
      run('git', ['ls-tree', '-r', '--name-only', base], source, true).toString().split('\n'),
    );
    for (const path of Object.keys(specification.files)) {
      if (!tracked.has(path)) continue;
      const destination = join(checkout, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, run('git', ['show', `${base}:${path}`], source, true));
    }
    run('git', ['init', '--quiet'], checkout);
  } else {
    if (
      process.platform !== 'linux' ||
      process.arch !== 'arm64' ||
      Number(process.versions.node.split('.')[0]) < 22
    )
      throw new Error('Build requires the isolated Linux ARM64 Node >=22 environment');
    if (existsSync(output))
      throw new Error('Output already exists; refusing to replace build evidence');
    run('git', [...gitConfig, 'clone', '--shared', '--no-checkout', source, checkout], scratch);
    run('git', [...gitConfig, 'checkout', '--detach', base], checkout);
  }
  run('git', ['apply', '--check', patch], checkout);
  run('git', ['apply', patch], checkout);
  for (const [path, digest] of Object.entries(specification.files)) {
    if (hash(readFileSync(join(checkout, path))) !== digest)
      throw new Error(`Patched source mismatch: ${path}`);
  }
  console.log('PATCH_SOURCE_IDENTITY_PASS');
  if (mode === '--build') {
    mkdirSync(output);
    run('bun', ['install', '--frozen-lockfile'], checkout);
    for (const name of ['parsers', 'lint', 'studio-server', 'core', 'engine', 'producer']) {
      run('bun', ['run', 'build'], join(checkout, 'packages', name));
    }
    const lock = JSON.parse(readFileSync(join(inputs, 'consumer-lock.json'), 'utf8'));
    lock.name = lock.packages[''].name = 'openmaic-budgeted-producer';
    const packages = {};
    for (const name of ['core', 'engine', 'parsers', 'lint', 'studio-server', 'producer']) {
      const packageSource = join(checkout, 'packages', name);
      const staging = join(scratch, name);
      mkdirSync(staging);
      const metadata = JSON.parse(readFileSync(join(packageSource, 'package.json'), 'utf8'));
      metadata.exports = metadata.publishConfig.exports;
      for (const section of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        for (const [dependency, range] of Object.entries(metadata[section] ?? {})) {
          if (!range.startsWith('workspace:')) continue;
          const dependencyName = dependency.replace('@hyperframes/', '');
          const version = JSON.parse(
            readFileSync(join(checkout, 'packages', dependencyName, 'package.json'), 'utf8'),
          ).version;
          metadata[section][dependency] =
            range === 'workspace:*' ? version : range.slice('workspace:'.length) + version;
        }
      }
      for (const path of ['dist', 'README.md', 'docs', 'schemas']) {
        if (existsSync(join(packageSource, path)))
          cpSync(join(packageSource, path), join(staging, path), { recursive: true });
      }
      cpSync(join(checkout, 'LICENSE'), join(staging, 'LICENSE'));
      writeFileSync(join(staging, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
      const [packed] = JSON.parse(
        run(
          'npm',
          ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', output],
          staging,
          true,
        ),
      );
      const key = `node_modules/@hyperframes/${name}`;
      // Only the six locally rebuilt tarballs may change; third-party lock
      // versions, URLs and integrity remain exactly those in consumer-lock.json.
      if (
        JSON.stringify(lock.packages[key].dependencies) !== JSON.stringify(metadata.dependencies)
      ) {
        const a = Object.entries(lock.packages[key].dependencies ?? {}).sort();
        const b = Object.entries(metadata.dependencies ?? {}).sort();
        if (JSON.stringify(a) !== JSON.stringify(b))
          throw new Error(`Consumer dependencies changed for ${name}`);
      }
      lock.packages[key].integrity = packed.integrity;
      packages[name] = {
        file: packed.filename,
        integrity: packed.integrity,
        sha256: hash(readFileSync(join(output, packed.filename))),
      };
    }
    writeFileSync(
      join(output, 'package.json'),
      JSON.stringify({ ...lock.packages[''], private: true }, null, 2) + '\n',
    );
    writeFileSync(join(output, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    const lockedBytes = readFileSync(join(output, 'package-lock.json'));
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], output);
    if (!lockedBytes.equals(readFileSync(join(output, 'package-lock.json'))))
      throw new Error('npm changed the frozen consumer lock');
    for (const [path, row] of Object.entries(lock.packages)) {
      if (!path) continue;
      const installed = join(output, path, 'package.json');
      if (row.optional && !existsSync(installed) && path !== 'node_modules/@esbuild/linux-arm64')
        continue;
      if (JSON.parse(readFileSync(installed, 'utf8')).version !== row.version)
        throw new Error(`Installed dependency version mismatch: ${path}`);
    }
    const producerRoot = join(output, 'node_modules/@hyperframes/producer');
    run(process.execPath, [join(producerRoot, 'dist/native/build.mjs')], output);
    const files = {};
    function inventory(directory) {
      for (const item of readdirSync(join(producerRoot, directory), { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) inventory(path);
        else if (item.isFile()) files[path] = hash(readFileSync(join(producerRoot, path)));
        else throw new Error(`Unexpected installed Producer file type: ${path}`);
      }
    }
    inventory('dist');
    files['package.json'] = hash(readFileSync(join(producerRoot, 'package.json')));
    writeFileSync(
      join(output, 'resource-build.json'),
      JSON.stringify(
        {
          source: specification,
          packages,
          producerFiles: files,
          consumerLockSha256: hash(readFileSync(join(output, 'package-lock.json'))),
          node: process.version,
          arch: process.arch,
        },
        null,
        2,
      ) + '\n',
    );
    console.log('PRIVATE_PRODUCER_BUILD_COMPLETE_NOT_RUNTIME_VALIDATION');
  }
} finally {
  // Only the directory allocated by this invocation is removed. Build output,
  // including failed installation evidence, is never overwritten or erased.
  rmSync(scratch, { recursive: true, force: true });
}
