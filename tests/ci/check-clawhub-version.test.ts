import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = resolve(repositoryRoot, '.github/scripts/check-clawhub-version.mjs');
const publishScriptPath = resolve(repositoryRoot, '.github/scripts/publish-openmaic-skill.sh');
const workflowPath = resolve(repositoryRoot, '.github/workflows/publish-openmaic-skill.yml');
const packageJsonPath = resolve(repositoryRoot, 'package.json');
const requireFromRoot = createRequire(packageJsonPath);
const semverPackageJsonPath = requireFromRoot.resolve('semver/package.json');
const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'clawhub-version-test-'));
let fixtureIndex = 0;

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

type ScriptEnvironment = 'SEMVER_PACKAGE_JSON' | 'PREFLIGHT_FILE' | 'PUBLISH_VERSION';

type FixtureInput =
  | { kind: 'json'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'raw'; content: string };

type RunOptions = {
  environmentOverrides?: Partial<Record<ScriptEnvironment, string>>;
  omittedEnvironment?: ScriptEnvironment;
};

const jsonFixture = (value: unknown): FixtureInput => ({ kind: 'json', value });
const missingFixture: FixtureInput = { kind: 'missing' };
const rawFixture = (content: string): FixtureInput => ({ kind: 'raw', content });

function runCheck(desired: string, fixture: FixtureInput, options: RunOptions = {}) {
  const fixturePath = resolve(fixtureRoot, `${fixtureIndex++}.json`);
  if (fixture.kind === 'json') {
    writeFileSync(fixturePath, `${JSON.stringify(fixture.value)}\n`, 'utf8');
  } else if (fixture.kind === 'raw') {
    writeFileSync(fixturePath, fixture.content, 'utf8');
  }
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    SEMVER_PACKAGE_JSON: semverPackageJsonPath,
    PREFLIGHT_FILE: fixturePath,
    PUBLISH_VERSION: desired,
  });
  Object.assign(env, options.environmentOverrides);
  if (options.omittedEnvironment) delete env[options.omittedEnvironment];
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
  });
}

function expectFailure(result: ReturnType<typeof runCheck>, message: string) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(`::error::${message}\n`);
}

function expectSuccess(result: ReturnType<typeof runCheck>, stdout: string) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(stdout);
  expect(result.stderr).toBe('');
}

const validPreflight = {
  status: 'would-publish',
  version: '0.3.2',
  latestVersion: '0.3.1',
  fingerprint: 'fixture-fingerprint',
};

describe('check-clawhub-version', () => {
  it('pins the ClawHub CLI and its independent SemVer runtime in both jobs', () => {
    const semverPackage = JSON.parse(readFileSync(semverPackageJsonPath, 'utf8')) as {
      version: string;
    };
    const workflow = readFileSync(workflowPath, 'utf8');
    const installPins = [
      ...workflow.matchAll(/npm install --global --ignore-scripts clawhub@(\S+) semver@(\S+)/g),
    ].map((match) => match.slice(1));

    expect(installPins).toEqual([
      ['0.23.3', '7.8.5'],
      ['0.23.3', '7.8.5'],
    ]);
    expect(workflow.match(/SEMVER_PACKAGE_JSON=/g)).toHaveLength(2);
    expect(workflow).not.toContain('CLAWHUB_PACKAGE_JSON');
    expect(semverPackage.version).toBe('7.8.5');
  });

  it('routes preview and publish through the same shared script', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const publishScript = readFileSync(publishScriptPath, 'utf8');

    expect(
      workflow.match(/bash \.github\/scripts\/publish-openmaic-skill\.sh --dry-run/g),
    ).toHaveLength(1);
    expect(
      workflow.match(/^\s+bash \.github\/scripts\/publish-openmaic-skill\.sh$/gm),
    ).toHaveLength(1);
    expect(workflow.match(/bash -n \.github\/scripts\/publish-openmaic-skill\.sh/g)).toHaveLength(
      2,
    );
    expect(workflow.match(/- "\.github\/scripts\/publish-openmaic-skill\.sh"/g)).toHaveLength(2);
    expect(publishScript).toContain('set -euo pipefail');
    expect(publishScript).toContain('source_commit="$(git rev-parse HEAD)"');
  });

  it('runs the automatic-version path in a no-secret macOS Bash 3.2 job', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const compatibilityJob = workflow.match(/  bash-3-compatibility:\n([\s\S]*?)\n  preview:/)?.[1];

    expect(compatibilityJob).toBeDefined();
    expect(compatibilityJob).toContain("if: github.event_name == 'pull_request'");
    expect(compatibilityJob).toContain('runs-on: macos-15');
    expect(compatibilityJob).toContain('permissions:\n      contents: read');
    expect(compatibilityJob).toContain('persist-credentials: false');
    expect(compatibilityJob).toContain('CLAWHUB: /usr/bin/true');
    expect(compatibilityJob).toContain('PUBLISH_VERSION: ""');
    expect(compatibilityJob).toContain('BASH_VERSINFO[0]');
    expect(compatibilityJob).toContain('if [[ "$bash_version" != "3.2" ]]');
    expect(compatibilityJob).toContain('/bin/bash .github/scripts/publish-openmaic-skill.sh');
    expect(compatibilityJob).not.toContain('secrets.');
    expect(compatibilityJob).not.toContain('environment:');
    expect(compatibilityJob).not.toContain('setup-node');
    expect(compatibilityJob).not.toContain('npm install');
  });

  it('lets Node drain output without immediate process exits', () => {
    const checker = readFileSync(scriptPath, 'utf8');

    expect(checker).not.toMatch(/process\.exit\s*\(/);
    expect(checker.match(/process\.stdout\.write/g)).toHaveLength(1);
    expect(checker).toContain('process.exitCode = 1');
  });

  it('does not inherit Node control variables from the test runner', () => {
    const previousOptions = process.env.NODE_OPTIONS;
    const previousDebug = process.env.NODE_DEBUG;
    process.env.NODE_OPTIONS = '--require=/definitely/missing/clawhub-test-module';
    process.env.NODE_DEBUG = 'module';
    try {
      expectSuccess(runCheck('0.4.0', jsonFixture(validPreflight)), 'continue\t0.4.0\n');
    } finally {
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
      if (previousDebug === undefined) delete process.env.NODE_DEBUG;
      else process.env.NODE_DEBUG = previousDebug;
    }
  });

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
    expectFailure(
      runCheck('0.4.0', jsonFixture(fixture)),
      'ClawHub returned incomplete version metadata.',
    );
  });

  it.each([
    ['status', { ...validPreflight, status: 42 }],
    ['version', { ...validPreflight, version: 42 }],
    ['fingerprint', { ...validPreflight, fingerprint: 123 }],
  ])('rejects a non-string %s as incomplete metadata', (_name, fixture) => {
    expectFailure(
      runCheck('0.4.0', jsonFixture(fixture)),
      'ClawHub returned incomplete version metadata.',
    );
  });

  it.each([
    ['malformed JSON', rawFixture('{not-json')],
    ['a nonexistent file', missingFixture],
  ])('rejects %s without a stack trace', (_name, fixture) => {
    expectFailure(runCheck('0.4.0', fixture), 'Unable to read ClawHub version preflight metadata.');
  });

  it('rejects an invalid preflight version', () => {
    expectFailure(
      runCheck('0.4.0', jsonFixture({ ...validPreflight, version: 'invalid' })),
      'ClawHub returned an invalid preflight version.',
    );
  });

  it('rejects an invalid non-null latest version', () => {
    expectFailure(
      runCheck('0.4.0', jsonFixture({ ...validPreflight, latestVersion: 'invalid' })),
      'ClawHub returned an invalid latest version.',
    );
  });

  it('rejects a numeric latest version', () => {
    expectFailure(
      runCheck('0.4.0', jsonFixture({ ...validPreflight, latestVersion: 42 })),
      'ClawHub returned an invalid latest version.',
    );
  });

  it('rejects an empty fingerprint', () => {
    expectFailure(
      runCheck('0.4.0', jsonFixture({ ...validPreflight, fingerprint: '' })),
      'ClawHub returned incomplete version metadata.',
    );
  });

  it('returns only a noop decision for unchanged identical content', () => {
    expectSuccess(
      runCheck(
        ' v0.3.1 ',
        jsonFixture({
          status: 'unchanged',
          version: '0.3.1',
          latestVersion: '0.3.1',
          fingerprint: 'fixture-fingerprint',
        }),
      ),
      'noop\t0.3.1\n',
    );
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
    expectSuccess(runCheck(desired, jsonFixture(fixture)), stdout);
  });

  it('continues for an unknown status instead of treating it as unchanged', () => {
    expectSuccess(
      runCheck(
        '0.4.0',
        jsonFixture({
          status: 'blocked',
          version: '0.4.0',
          latestVersion: '0.3.1',
          fingerprint: 'fixture-fingerprint',
        }),
      ),
      'continue\t0.4.0\n',
    );
  });

  it('rejects manual build metadata', () => {
    expectFailure(
      runCheck('0.4.0+ci.1', jsonFixture(validPreflight)),
      'Requested version must not include build metadata.',
    );
  });

  it('rejects a manual prerelease version', () => {
    expectFailure(
      runCheck('0.4.0-rc.1', jsonFixture(validPreflight)),
      'Requested version must be a stable SemVer release.',
    );
  });

  it('rejects unchanged registry content with conflicting build metadata', () => {
    expectFailure(
      runCheck(
        '1.2.3',
        jsonFixture({
          status: 'unchanged',
          version: '1.2.3+old',
          latestVersion: '1.2.3+old',
          fingerprint: 'fixture-fingerprint',
        }),
      ),
      'ClawHub has unchanged content at the same SemVer precedence with different build metadata.',
    );
  });

  it.each(['0.3.0', '0.3.1'])(
    'rejects non-increasing version %s for different content',
    (desired) => {
      expectFailure(
        runCheck(desired, jsonFixture(validPreflight)),
        'Requested version must be greater than 0.3.1.',
      );
    },
  );

  it('rejects invalid semver', () => {
    expectFailure(
      runCheck('invalid', jsonFixture(validPreflight)),
      'Requested version is not valid semver.',
    );
  });

  it.each(['SEMVER_PACKAGE_JSON', 'PREFLIGHT_FILE', 'PUBLISH_VERSION'] as const)(
    'rejects missing %s environment',
    (name) => {
      expectFailure(
        runCheck('0.4.0', jsonFixture(validPreflight), { omittedEnvironment: name }),
        'ClawHub version check environment is incomplete.',
      );
    },
  );

  it.each([
    ['SEMVER_PACKAGE_JSON', 'ClawHub version check environment is incomplete.'],
    ['PREFLIGHT_FILE', 'ClawHub version check environment is incomplete.'],
    ['PUBLISH_VERSION', 'Requested version is not valid semver.'],
  ] as const)('rejects empty %s environment', (name, message) => {
    expectFailure(
      runCheck('0.4.0', jsonFixture(validPreflight), {
        environmentOverrides: { [name]: '' },
      }),
      message,
    );
  });

  it('reports a missing SemVer runtime without a stack trace', () => {
    expectFailure(
      runCheck('0.4.0', jsonFixture(validPreflight), {
        environmentOverrides: { SEMVER_PACKAGE_JSON: '/definitely/missing/semver/package.json' },
      }),
      'Unable to load the pinned SemVer dependency.',
    );
  });
});
