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

function workflowJob(workflow: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const markedWorkflow = `${workflow}\n  __end__:\n`;
  const job = markedWorkflow.match(
    new RegExp(`^  ${escapedName}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n)`, 'm'),
  )?.[1];
  expect(job, `workflow job ${name}`).toBeDefined();
  return job ?? '';
}

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
    expect(workflow.match(/global_root="\$\(npm root --global\)"/g)).toHaveLength(2);
    expect(workflow.match(/if \[\[ -z "\$global_root" \]\]; then/g)).toHaveLength(2);
    expect(workflow.match(/set -euo pipefail\n\s+: > "\$NPM_CONFIG_USERCONFIG"/g)).toHaveLength(2);
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

  it('runs automatic and manual paths in a no-secret macOS Bash 3.2 job', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const compatibilityJob = workflowJob(workflow, 'bash-3-compatibility');

    expect(compatibilityJob).toContain("if: github.event_name == 'pull_request'");
    expect(compatibilityJob).toContain('runs-on: macos-15');
    expect(compatibilityJob).toContain('permissions:\n      contents: read');
    expect(compatibilityJob).toContain(
      'group: clawhub-bash3-${{ github.event.pull_request.number }}',
    );
    expect(compatibilityJob).toContain('cancel-in-progress: true');
    expect(compatibilityJob).toContain('persist-credentials: false');
    expect(compatibilityJob).toContain('CLAWHUB=/usr/bin/true');
    expect(compatibilityJob).toContain("PUBLISH_VERSION=''");
    expect(compatibilityJob).toContain('BASH_VERSINFO[0]');
    expect(compatibilityJob).toContain('if [[ "$bash_version" != "3.2" ]]');
    expect(
      compatibilityJob.match(/\/bin\/bash \.github\/scripts\/publish-openmaic-skill\.sh/g),
    ).toHaveLength(2);
    expect(compatibilityJob).toContain("PUBLISH_VERSION='0.4.0'");
    expect(compatibilityJob).toContain('"status":"would-publish"');
    expect(compatibilityJob).toContain("printf 'continue\\t0.4.0\\n'");
    expect(compatibilityJob).toContain("grep -q -- $'--version\\t0.4.0\\t'");
    expect(compatibilityJob).not.toContain('secrets.');
    expect(compatibilityJob).not.toContain('environment:');
    expect(compatibilityJob).not.toContain('setup-node');
    expect(compatibilityJob).not.toContain('npm install');
  });

  it('keeps the preview job isolated from secrets and pinned to the fork head', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const previewJob = workflowJob(workflow, 'preview');

    expect(previewJob).toContain("github.event_name == 'pull_request'");
    expect(previewJob).toContain('permissions:\n      contents: read');
    expect(previewJob).toContain(
      "repository: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name || github.repository }}",
    );
    expect(previewJob).toContain(
      "ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || 'main' }}",
    );
    expect(previewJob).toContain('persist-credentials: false');
    expect(previewJob).not.toMatch(/^\s+environment:/m);
    expect(previewJob).not.toContain('secrets.');
  });

  it('gates publish on main and preserves checkout and stale-tree safeguards', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const publishJob = workflowJob(workflow, 'publish');

    expect(workflow).toContain('push:\n    branches: [main]');
    expect(publishJob).toContain("github.event_name == 'push'");
    expect(publishJob).toContain("github.ref == 'refs/heads/main'");
    expect(publishJob).toContain('!inputs.dry_run');
    expect(publishJob).toContain('environment: clawhub-release');
    expect(publishJob).toContain('permissions:\n      contents: read');
    expect(publishJob).toContain('ref: ${{ github.sha }}');
    expect(publishJob).toContain('fetch-depth: 0');
    expect(publishJob).toContain('persist-credentials: false');
    expect(publishJob).not.toContain('git fetch');
    expect(publishJob).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(publishJob).toMatch(
      /handle_divergence\(\) \{[\s\S]*?workflow_dispatch\)[\s\S]*?::error::Refusing manual publish because \$reason\.[\s\S]*?exit 1[\s\S]*?push\)[\s\S]*?::notice::Skipping \$source_commit because \$reason\.[\s\S]*?exit 0[\s\S]*?Unexpected publish event:[\s\S]*?exit 1[\s\S]*?\n\s+\}/,
    );
    const publishSequence = [
      String.raw`if ! git rev-parse --verify --quiet "refs/remotes/origin/main\^\{commit\}" >/dev/null; then`,
      String.raw`echo "::error::Unable to resolve the checked-out origin/main commit\."`,
      String.raw`exit 1`,
      String.raw`fi`,
      String.raw`if ! git cat-file -e "HEAD\^\{tree\}:skills/openmaic" 2>/dev/null; then`,
      String.raw`handle_divergence "skills/openmaic was deleted"`,
      String.raw`fi`,
      String.raw`if ! git cat-file -e "origin/main\^\{tree\}:skills/openmaic" 2>/dev/null; then`,
      String.raw`handle_divergence "skills/openmaic was removed from main"`,
      String.raw`fi`,
      String.raw`source_tree="\$\(git rev-parse HEAD:skills/openmaic\)"`,
      String.raw`main_tree="\$\(git rev-parse origin/main:skills/openmaic\)"`,
      String.raw`if \[\[ "\$source_tree" != "\$main_tree" \]\]; then`,
      String.raw`handle_divergence "skills/openmaic changed on main"`,
      String.raw`fi`,
      String.raw`bash \.github/scripts/publish-openmaic-skill\.sh`,
    ].join(String.raw`\s+`);
    expect(publishJob).toMatch(new RegExp(publishSequence));
    expect(publishJob.match(/publish-openmaic-skill\.sh/g)).toHaveLength(2);
    expect(publishJob.match(/\bhandle_divergence\b/g)).toHaveLength(4);
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
