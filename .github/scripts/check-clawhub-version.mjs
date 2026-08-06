import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

class UserFacingError extends Error {}

function fail(message) {
  throw new UserFacingError(message);
}

function loadSemver(packageJson) {
  try {
    return createRequire(packageJson)('semver');
  } catch {
    fail('Unable to load the pinned SemVer dependency.');
  }
}

function main() {
  const packageJson = process.env.SEMVER_PACKAGE_JSON;
  const preflightFile = process.env.PREFLIGHT_FILE;
  const desired = process.env.PUBLISH_VERSION;
  if (!packageJson || !preflightFile || desired === undefined) {
    fail('ClawHub version check environment is incomplete.');
  }

  const semver = loadSemver(packageJson);

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
    return {
      full: `${parsed.version}${build}`,
      hasBuild: parsed.build.length > 0,
      hasPrerelease: parsed.prerelease.length > 0,
    };
  }

  const desiredVersion = canonicalVersion(desired);
  if (!desiredVersion) {
    fail('Requested version is not valid semver.');
  }
  if (desiredVersion.hasPrerelease) {
    fail('Requested version must be a stable SemVer release.');
  }
  if (desiredVersion.hasBuild) {
    fail('Requested version must not include build metadata.');
  }
  const canonical = desiredVersion.full;

  const isPreflightObject =
    preflight !== null && typeof preflight === 'object' && !Array.isArray(preflight);
  if (
    !isPreflightObject ||
    typeof preflight.status !== 'string' ||
    typeof preflight.version !== 'string' ||
    typeof preflight.fingerprint !== 'string' ||
    preflight.fingerprint.length === 0 ||
    !Object.hasOwn(preflight, 'latestVersion')
  ) {
    fail('ClawHub returned incomplete version metadata.');
  }

  const preflightVersion = canonicalVersion(preflight.version);
  if (!preflightVersion) {
    fail('ClawHub returned an invalid preflight version.');
  }
  if (preflight.status === 'unchanged' && preflightVersion.full === canonical) {
    return `noop\t${canonical}`;
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

  return `continue\t${canonical}`;
}

try {
  process.stdout.write(`${main()}\n`);
} catch (error) {
  const message =
    error instanceof UserFacingError ? error.message : 'Unable to check ClawHub version.';
  process.stderr.write(`::error::${message}\n`);
  process.exitCode = 1;
}
