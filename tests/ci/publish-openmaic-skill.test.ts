import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const publishScript = resolve(repositoryRoot, '.github/scripts/publish-openmaic-skill.sh');
const packageJsonPath = resolve(repositoryRoot, 'package.json');
const semverPackageJsonPath = createRequire(packageJsonPath).resolve('semver/package.json');
const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'clawhub-publish-test-'));
const stubClawhub = resolve(fixtureRoot, 'clawhub-stub.sh');
let runIndex = 0;

writeFileSync(
  stubClawhub,
  `#!/bin/bash
set -euo pipefail
printf '%s\\t' "$@" >> "$STUB_CALLS"
printf '\\n' >> "$STUB_CALLS"
if [[ -n "\${STUB_PREFLIGHT_JSON:-}" && " $* " != *" --version "* ]]; then
  printf '%s\\n' "$STUB_PREFLIGHT_JSON"
else
  printf '%s\\n' '{"published":true}'
fi
`,
  'utf8',
);
chmodSync(stubClawhub, 0o755);

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

type RunOptions = {
  args?: string[];
  clawhub?: string;
  omittedEnvironment?: 'SOURCE_REPO' | 'PUBLISH_VERSION' | 'CLAWHUB' | 'RUNNER_TEMP';
  pathPrefix?: string;
  preflight?: unknown;
  publishVersion?: string;
  sourceRepo?: string;
};

function runPublish(options: RunOptions = {}) {
  const callsPath = resolve(fixtureRoot, `calls-${runIndex++}.txt`);
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    CLAWHUB: options.clawhub ?? stubClawhub,
    PUBLISH_VERSION: options.publishVersion ?? '',
    RUNNER_TEMP: fixtureRoot,
    SEMVER_PACKAGE_JSON: semverPackageJsonPath,
    SOURCE_REPO: options.sourceRepo ?? 'THU-MAIC/OpenMAIC',
    STUB_CALLS: callsPath,
  });
  if (options.preflight !== undefined) {
    env.STUB_PREFLIGHT_JSON = JSON.stringify(options.preflight);
  }
  if (options.pathPrefix) env.PATH = `${options.pathPrefix}:${env.PATH ?? ''}`;
  if (options.omittedEnvironment) delete env[options.omittedEnvironment];

  const result = spawnSync('/bin/bash', [publishScript, ...(options.args ?? [])], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
  });
  const calls = (() => {
    try {
      return readFileSync(callsPath, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => line.split('\t'));
    } catch {
      return [];
    }
  })();
  return { calls, result };
}

function expectSuccess(result: ReturnType<typeof runPublish>['result'], stdout: string) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(stdout);
  expect(result.stderr).toBe('');
}

function expectFailure(result: ReturnType<typeof runPublish>['result'], message: string) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(`::error::${message}\n`);
}

describe('publish-openmaic-skill shell contract', () => {
  it('performs a real publish with no positional argument under macOS Bash 3.2', () => {
    const { calls, result } = runPublish();

    expectSuccess(result, '{"published":true}\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('publish');
    expect(calls[0]).not.toContain('--dry-run');
  });

  it('adds dry-run only for a preview publish', () => {
    const { calls, result } = runPublish({ args: ['--dry-run'] });

    expectSuccess(result, '{"published":true}\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--dry-run');
  });

  it('preflights a manual version and publishes the canonical stable version', () => {
    const preflight = {
      status: 'would-publish',
      version: '0.4.0',
      latestVersion: '0.3.1',
      fingerprint: 'fixture-fingerprint',
    };
    const { calls, result } = runPublish({
      preflight,
      publishVersion: ' v0.4.0 ',
    });

    expectSuccess(result, `${JSON.stringify(preflight)}\n{"published":true}\n`);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--dry-run');
    expect(calls[0]).not.toContain('--version');
    expect(calls[1]).not.toContain('--dry-run');
    expect(calls[1]).toContain('--version');
    expect(calls[1][calls[1].indexOf('--version') + 1]).toBe('0.4.0');
  });

  it('keeps a manual version preview in dry-run mode after preflight', () => {
    const preflight = {
      status: 'would-publish',
      version: '0.4.0',
      latestVersion: '0.3.1',
      fingerprint: 'fixture-fingerprint',
    };
    const { calls, result } = runPublish({
      args: ['--dry-run'],
      preflight,
      publishVersion: ' v0.4.0 ',
    });

    expectSuccess(result, `${JSON.stringify(preflight)}\n{"published":true}\n`);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('--dry-run');
    expect(calls[1]).toContain('--version');
    expect(calls[1][calls[1].indexOf('--version') + 1]).toBe('0.4.0');
  });

  it('stops after a noop preflight', () => {
    const preflight = {
      status: 'unchanged',
      version: '0.3.1',
      latestVersion: '0.3.1',
      fingerprint: 'fixture-fingerprint',
    };
    const { calls, result } = runPublish({ preflight, publishVersion: '0.3.1' });

    expectSuccess(
      result,
      `${JSON.stringify(preflight)}\n::notice::The requested version already has identical content.\n`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--dry-run');
  });

  it('rejects unsupported arguments', () => {
    const usage = runPublish({ args: ['--publish'] });
    expectFailure(usage.result, 'Usage: publish-openmaic-skill.sh [--dry-run]');
    expect(usage.calls).toEqual([]);
  });

  it.each([
    ['an empty argument before dry-run', ['', '--dry-run']],
    ['a trailing argument after dry-run', ['--dry-run', '--anything']],
  ])('rejects %s without invoking ClawHub', (_name, args) => {
    const { calls, result } = runPublish({ args });

    expectFailure(result, 'Usage: publish-openmaic-skill.sh [--dry-run]');
    expect(calls).toEqual([]);
  });

  it.each([
    ['SOURCE_REPO', 'SOURCE_REPO is required.'],
    ['PUBLISH_VERSION', 'PUBLISH_VERSION is required.'],
    ['CLAWHUB', 'CLAWHUB is required.'],
  ] as const)('rejects an unset %s environment variable', (name, message) => {
    const { calls, result } = runPublish({ omittedEnvironment: name });

    expectFailure(result, message);
    expect(calls).toEqual([]);
  });

  it.each([
    ['SOURCE_REPO', { sourceRepo: '' }, 'SOURCE_REPO is required.'],
    ['CLAWHUB', { clawhub: '' }, 'CLAWHUB is required.'],
  ] as const)('rejects an empty %s environment variable', (_name, options, message) => {
    const { calls, result } = runPublish(options);

    expectFailure(result, message);
    expect(calls).toEqual([]);
  });

  it('requires RUNNER_TEMP when an explicit version reaches preflight', () => {
    const { calls, result } = runPublish({
      omittedEnvironment: 'RUNNER_TEMP',
      publishVersion: '0.4.0',
    });

    expectFailure(result, 'RUNNER_TEMP is required for version preflight.');
    expect(calls).toEqual([]);
  });

  it('accepts an explicitly empty PUBLISH_VERSION for automatic versioning', () => {
    const { calls, result } = runPublish({ publishVersion: '' });

    expectSuccess(result, '{"published":true}\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('--version');
  });

  it('rejects a malformed checker decision', () => {
    const fakeBin = resolve(fixtureRoot, `fake-bin-${runIndex++}`);
    const fakeNode = resolve(fakeBin, 'node');
    mkdirSync(fakeBin);
    writeFileSync(fakeNode, '#!/bin/bash\nprintf "malformed-decision\\n"\n', 'utf8');
    chmodSync(fakeNode, 0o755);
    const preflight = {
      status: 'would-publish',
      version: '0.4.0',
      latestVersion: '0.3.1',
      fingerprint: 'fixture-fingerprint',
    };
    const { calls, result } = runPublish({
      pathPrefix: fakeBin,
      preflight,
      publishVersion: '0.4.0',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('::error::Invalid version preflight decision.\n');
    expect(calls).toHaveLength(1);
  });
});
