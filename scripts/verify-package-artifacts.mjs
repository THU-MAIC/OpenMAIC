import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENMAIC_PACKAGES, readManifest } from './openmaic-packages.mjs';

const DIGESTS_FILE = 'SHA256SUMS';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function expectedArtifacts() {
  return OPENMAIC_PACKAGES.map((shortName) => {
    const manifest = readManifest(shortName);
    return {
      shortName,
      name: `@openmaic/${shortName}`,
      version: manifest.version,
      filename: `openmaic-${shortName}-${manifest.version}.tgz`,
    };
  });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readPackedManifest(path) {
  return JSON.parse(
    execFileSync('tar', ['-xzOf', path, 'package/package.json'], { encoding: 'utf8' }),
  );
}

function assertArtifactSet(directory, expected, includeDigests) {
  const expectedNames = new Set(expected.map(({ filename }) => filename));
  if (includeDigests) expectedNames.add(DIGESTS_FILE);

  const entries = readdirSync(directory, { withFileTypes: true });
  assert.deepEqual(
    entries.map(({ name }) => name).sort(),
    [...expectedNames].sort(),
    `Release artifact directory must contain exactly ${[...expectedNames].sort().join(', ')}`,
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    assert(
      entry.isFile() && !lstatSync(path).isSymbolicLink(),
      `${entry.name} must be a regular file`,
    );
  }

  for (const artifact of expected) {
    const manifest = readPackedManifest(join(directory, artifact.filename));
    assert.equal(
      manifest.name,
      artifact.name,
      `${artifact.filename} contains package ${manifest.name}`,
    );
    assert.equal(
      manifest.version,
      artifact.version,
      `${artifact.filename} contains version ${manifest.version}`,
    );
  }
}

function writeDigests(directory, expected) {
  assertArtifactSet(directory, expected, false);
  const contents = expected
    .map(({ filename }) => `${sha256(join(directory, filename))}  ${filename}`)
    .join('\n');
  writeFileSync(join(directory, DIGESTS_FILE), `${contents}\n`);
  console.log(`Recorded SHA-256 digests for ${expected.length} package tarballs.`);
}

function verifyDigests(directory, expected) {
  assertArtifactSet(directory, expected, true);
  const lines = readFileSync(join(directory, DIGESTS_FILE), 'utf8').trimEnd().split('\n');
  const recorded = new Map();

  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([^/]+\.tgz)$/.exec(line);
    assert(match, `Invalid ${DIGESTS_FILE} entry: ${JSON.stringify(line)}`);
    assert(!recorded.has(match[2]), `${DIGESTS_FILE} lists ${match[2]} more than once`);
    recorded.set(match[2], match[1]);
  }

  assert.deepEqual(
    [...recorded.keys()].sort(),
    expected.map(({ filename }) => filename).sort(),
    `${DIGESTS_FILE} must list every allowed package tarball exactly once`,
  );

  for (const { filename } of expected) {
    assert.equal(
      sha256(join(directory, filename)),
      recorded.get(filename),
      `${filename} failed SHA-256 verification`,
    );
  }
  console.log(`Verified SHA-256 digests for ${expected.length} package tarballs.`);
}

const args = process.argv.slice(2);
const write = args[0] === '--write';
const directoryArgument = args[write ? 1 : 0];
assert(
  directoryArgument,
  `Usage: node ${basename(process.argv[1])} [--write] <artifact-directory>`,
);
assert.equal(args.length, write ? 2 : 1, 'Unexpected command-line arguments');

const directory = resolve(root, directoryArgument);
const expected = expectedArtifacts();
if (write) writeDigests(directory, expected);
else verifyDigests(directory, expected);
