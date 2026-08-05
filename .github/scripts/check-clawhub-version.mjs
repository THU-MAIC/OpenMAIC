import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const packageJson = process.env.CLAWHUB_PACKAGE_JSON;
const preflightFile = process.env.PREFLIGHT_FILE;
const desired = process.env.PUBLISH_VERSION;
if (!packageJson || !preflightFile || desired === undefined) {
  fail('ClawHub version check environment is incomplete.');
}

const require = createRequire(packageJson);
const semver = require('semver');

let preflight;
try {
  preflight = JSON.parse(readFileSync(preflightFile, 'utf8'));
} catch {
  fail('Unable to read ClawHub version preflight metadata.');
}

function canonicalVersion(value) {
  if (typeof value !== 'string') return null;
  const parsed = semver.parse(value);
  if (!parsed) return null;
  const build = parsed.build.length > 0 ? `+${parsed.build.join('.')}` : '';
  return { full: `${parsed.version}${build}`, hasBuild: parsed.build.length > 0 };
}

const desiredVersion = canonicalVersion(desired);
if (!desiredVersion) {
  fail('Requested version is not valid semver.');
}
if (desiredVersion.hasBuild) {
  fail('Requested version must not include build metadata.');
}
const canonical = desiredVersion.full;

if (
  typeof preflight.status !== 'string' ||
  typeof preflight.version !== 'string' ||
  typeof preflight.fingerprint !== 'string' ||
  preflight.fingerprint.length === 0 ||
  !Object.hasOwn(preflight, 'latestVersion') ||
  preflight.latestVersion === undefined
) {
  fail('ClawHub returned incomplete version metadata.');
}

const preflightVersion = canonicalVersion(preflight.version);
if (!preflightVersion) {
  fail('ClawHub returned an invalid preflight version.');
}
if (preflight.status === 'unchanged' && preflightVersion.full === canonical) {
  console.log(`noop\t${canonical}`);
  process.exit(0);
}
if (
  preflight.status === 'unchanged' &&
  semver.eq(preflightVersion.full, canonical) &&
  preflightVersion.full !== canonical
) {
  fail(
    'ClawHub has unchanged content at the same SemVer precedence with different build metadata.',
  );
}

if (preflight.latestVersion !== null) {
  const latest = canonicalVersion(preflight.latestVersion);
  if (!latest) {
    fail('ClawHub returned an invalid latest version.');
  }
  if (!semver.gt(canonical, latest.full)) {
    fail(`Requested version must be greater than ${latest.full}.`);
  }
}

console.log(`continue\t${canonical}`);
