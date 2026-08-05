import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = resolve(repositoryRoot, '.github/scripts/check-clawhub-version.mjs');
const packageJsonPath = resolve(repositoryRoot, 'package.json');
const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'clawhub-version-test-'));
let fixtureIndex = 0;

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function runCheck(
  desired: string,
  fixture: unknown,
  omittedEnvironment: 'CLAWHUB_PACKAGE_JSON' | 'PREFLIGHT_FILE' | 'PUBLISH_VERSION' | null = null,
) {
  const fixturePath = resolve(fixtureRoot, `${fixtureIndex++}.json`);
  writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`, 'utf8');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAWHUB_PACKAGE_JSON: packageJsonPath,
    PREFLIGHT_FILE: fixturePath,
    PUBLISH_VERSION: desired,
  };
  if (omittedEnvironment) delete env[omittedEnvironment];
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
  });
}

function expectFailure(result: ReturnType<typeof runCheck>, message: string) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(`::error::${message}\n`);
}

const validPreflight = {
  status: 'would-publish',
  version: '0.3.2',
  latestVersion: '0.3.1',
  fingerprint: 'fixture-fingerprint',
};

describe('check-clawhub-version', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['primitive', 'value'],
    ['empty object', {}],
    [
      'missing latestVersion',
      { status: 'would-publish', version: '0.3.2', fingerprint: 'fixture-fingerprint' },
    ],
  ])('rejects incomplete %s metadata without a stack trace', (_name, fixture) => {
    expectFailure(runCheck('0.4.0', fixture), 'ClawHub returned incomplete version metadata.');
  });

  it('returns only a noop decision for unchanged identical content', () => {
    const result = runCheck(' v0.3.1 ', {
      status: 'unchanged',
      version: '0.3.1',
      latestVersion: '0.3.1',
      fingerprint: 'fixture-fingerprint',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('noop\t0.3.1\n');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['greater version', ' v0.4.0 ', validPreflight, 'continue\t0.4.0\n'],
    [
      'null latest version',
      '1.0.0',
      { ...validPreflight, version: '1.0.0', latestVersion: null },
      'continue\t1.0.0\n',
    ],
  ])('returns only a continue decision for a %s', (_name, desired, fixture, stdout) => {
    const result = runCheck(desired, fixture);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(stdout);
    expect(result.stderr).toBe('');
  });

  it('rejects manual build metadata', () => {
    expectFailure(
      runCheck('0.4.0+ci.1', validPreflight),
      'Requested version must not include build metadata.',
    );
  });

  it('rejects unchanged registry content with conflicting build metadata', () => {
    expectFailure(
      runCheck('1.2.3', {
        status: 'unchanged',
        version: '1.2.3+old',
        latestVersion: '1.2.3+old',
        fingerprint: 'fixture-fingerprint',
      }),
      'ClawHub has unchanged content at the same SemVer precedence with different build metadata.',
    );
  });

  it.each(['0.3.0', '0.3.1'])(
    'rejects non-increasing version %s for different content',
    (desired) => {
      expectFailure(
        runCheck(desired, validPreflight),
        'Requested version must be greater than 0.3.1.',
      );
    },
  );

  it('rejects invalid semver', () => {
    expectFailure(runCheck('invalid', validPreflight), 'Requested version is not valid semver.');
  });

  it.each(['CLAWHUB_PACKAGE_JSON', 'PREFLIGHT_FILE', 'PUBLISH_VERSION'] as const)(
    'rejects missing %s environment',
    (name) => {
      expectFailure(
        runCheck('0.4.0', validPreflight, name),
        'ClawHub version check environment is incomplete.',
      );
    },
  );
});
