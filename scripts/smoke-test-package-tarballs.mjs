import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERNAL_DEPENDENTS, OPENMAIC_PACKAGES, readManifest } from './openmaic-packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const artifactDirectoryArgument = args[0];
assert(
  artifactDirectoryArgument,
  'Usage: node smoke-test-package-tarballs.mjs <artifact-directory>',
);
assert.equal(args.length, 1, 'Unexpected command-line arguments');
const artifactDirectory = resolve(root, artifactDirectoryArgument);
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'openmaic-package-smoke-'));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
  });
}

/** The manifest as the registry will see it, read out of the tarball itself. */
function packedManifest(tarball) {
  return JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
}

/**
 * The dependents declare `@openmaic/dsl` as `workspace:^`, which pnpm publishes
 * as `^<dsl version>`. That range is what lets a consumer installing several
 * @openmaic packages together resolve ONE copy of the dsl. An exact pin — which
 * is what the `workspace:*` form publishes — gives each dependent its own copy,
 * and since the dsl carries the schema, the validators and the version
 * constants, two copies mean a document produced against one instance can be
 * validated by the other's schema revision.
 *
 * The caret in `dependencies` is only half of it. `peerDependencies` and
 * `optionalDependencies` are published constraints too, so an exact entry in
 * either would reintroduce the duplicate while `dependencies` still read
 * correctly. An owned package must therefore appear exactly once, here.
 *
 * KNOWN LIMITATION: `^` deduplicates within one 0.x line only. A consumer that
 * mixes an older dependent requiring `^0.5.0` with a newer one requiring
 * `^0.6.0` still ends up with two dsl copies. Removing that possibility
 * entirely would mean making the dsl a peer dependency of all three dependents,
 * which changes their public installation contract and is a separate decision.
 */
function assertDeduplicableDslRange(name, manifest, dslVersion, ownedPackages) {
  const range = manifest.dependencies?.['@openmaic/dsl'];
  assert(
    range !== undefined,
    `@openmaic/${name} no longer declares @openmaic/dsl; update this check if that is intended`,
  );
  assert.equal(
    range,
    `^${dslVersion}`,
    `@openmaic/${name} publishes @openmaic/dsl as ${JSON.stringify(range)} rather than ` +
      `"^${dslVersion}". An exact pin (what "workspace:*" publishes) forces consumers to ` +
      'install a second copy of the dsl alongside its siblings.',
  );
  for (const field of ['peerDependencies', 'optionalDependencies']) {
    const declared = Object.keys(manifest[field] ?? {}).filter((dependency) =>
      ownedPackages.has(dependency),
    );
    assert.deepEqual(
      declared,
      [],
      `@openmaic/${name} publishes ${field} entries for owned packages ` +
        `(${declared.join(', ')}). Those are published constraints as much as ` +
        '`dependencies` is, so an exact one there pins the dsl regardless of the caret above.',
    );
  }
  console.log(`@openmaic/${name} publishes @openmaic/dsl as ${range}, and nowhere else.`);
}

try {
  const packageNames = OPENMAIC_PACKAGES;
  const localPackages = new Set(packageNames.map((name) => `@openmaic/${name}`));
  const tarballs = Object.fromEntries(
    packageNames.map((name) => {
      const { version } = readManifest(name);
      return [name, join(artifactDirectory, `openmaic-${name}-${version}.tgz`)];
    }),
  );
  const packedManifests = Object.fromEntries(
    packageNames.map((name) => [name, packedManifest(tarballs[name])]),
  );
  // The smoke program executes the renderer root, whose optional chart and
  // highlighting peers are imported by that entry. Other optional peers remain
  // optional unless the smoke program starts executing their owning entry.
  const installOptionalPeersFor = new Set(['renderer']);
  const peerDependencies = {};
  for (const name of packageNames) {
    const manifest = packedManifests[name];
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (localPackages.has(peer)) continue;
      const isOptional = manifest.peerDependenciesMeta?.[peer]?.optional === true;
      if (isOptional && !installOptionalPeersFor.has(name)) continue;
      const existing = peerDependencies[peer];
      // Keep peer declarations aligned across the package family. Attempting to
      // synthesize an intersection here is unsafe for ranges containing `||`.
      assert(
        existing === undefined || existing === range,
        `@openmaic packages declare different ${peer} peer ranges: ${existing} and ${range}`,
      );
      peerDependencies[peer] = range;
    }
  }
  const dslVersion = packedManifests.dsl.version;
  for (const name of Object.keys(INTERNAL_DEPENDENTS)) {
    assertDeduplicableDslRange(name, packedManifests[name], dslVersion, localPackages);
  }

  const consumerDirectory = join(temporaryDirectory, 'consumer');

  mkdirSync(consumerDirectory);
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          ...peerDependencies,
          ...Object.fromEntries(
            packageNames.map((name) => [`@openmaic/${name}`, `file:${tarballs[name]}`]),
          ),
        },
      },
      null,
      2,
    ),
  );

  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: consumerDirectory,
  });

  writeFileSync(
    join(consumerDirectory, 'smoke.mjs'),
    `import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RUNTIME_DSL_VERSION, validateRuntimeSession } from '@openmaic/dsl';
import { DOCUMENT_PG_SCHEMA } from '@openmaic/storage';
import { SlideCanvas } from '@openmaic/renderer';

assert.equal(typeof RUNTIME_DSL_VERSION, 'string');
assert.equal(typeof validateRuntimeSession, 'function');
assert.match(DOCUMENT_PG_SCHEMA, /CREATE TABLE IF NOT EXISTS document_stages/);
assert.equal(typeof SlideCanvas, 'function');

const importerEntry = fileURLToPath(import.meta.resolve('@openmaic/importer'));
assert((await stat(importerEntry)).isFile());
const importerRequireEntry = createRequire(import.meta.url).resolve('@openmaic/importer');
assert((await stat(importerRequireEntry)).isFile());

for (const subpath of [
  'runtime/http',
  'document/http',
  'document/pg',
  'runtime/pg',
  'server',
  'server/reference',
]) {
  await import(\`@openmaic/storage/\${subpath}\`);
}
`,
  );
  run('node', ['smoke.mjs'], { cwd: consumerDirectory });

  console.log('Validated @openmaic package tarball imports passed.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
