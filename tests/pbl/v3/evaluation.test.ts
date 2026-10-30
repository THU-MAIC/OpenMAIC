import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
vi.mock('server-only', () => ({}));
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import {
  evaluationCommand,
  evaluationPassed,
  evaluationOutcome,
} from '@/lib/server/pbl-v3/evaluation';
const spec = installedProject({ id: 'greeting-python', version: '1.0.0' }).evaluations.greeting!;

it.each(['\n', '\r\n', '\r'])(
  'normalizes expected and actual line endings equally without relaxing output checks (%j)',
  async (ending) => {
    const installed = {
      cases: [
        {
          id: 'line',
          argv: ['python3', '-c', `import sys; sys.stdout.write(${JSON.stringify('ok' + ending)})`],
          stdout: 'ok' + ending,
        },
      ],
    };
    const { stdout } = await promisify(execFile)('/bin/sh', [
      '-c',
      evaluationCommand(installed, 'line-endings'),
    ]);
    expect(evaluationPassed(installed, 'line-endings', stdout)).toBe(true);
    for (const wrong of ['ok', 'ok \n', 'ok\n\n', 'wrong\n'])
      expect(
        evaluationPassed(
          { cases: [{ ...installed.cases[0], stdout: wrong }] },
          'line-endings',
          stdout,
        ),
      ).toBe(false);
  },
);

it.each([false, true])(
  'locates Python syntax errors with prepare=%s and permits a passing rerun',
  async (prepare) => {
    const root = await mkdtemp(join(tmpdir(), 'pbl-syntax-'));
    const installed = {
      ...spec,
      ...(prepare ? { prepare: ['python3', '-m', 'py_compile', 'greeting.py'] } : {}),
    };
    const run = async () => {
      const observed = await promisify(execFile)(
        '/bin/sh',
        ['-c', evaluationCommand(installed, 'syntax')],
        { cwd: root, env: { ...process.env, PYTHONPYCACHEPREFIX: join(root, 'pycache') } },
      );
      return evaluationOutcome(installed, 'syntax', { state: 'exited', exitCode: 0, ...observed }, [
        'greeting.py',
      ]);
    };
    try {
      await writeFile(join(root, 'greeting.py'), 'def greet(name)\n    return "SECRET_BODY"\n');
      const failed = await run();
      expect(failed).toMatchObject({
        status: 'failed',
        failureKind: 'compile',
        publicDiagnostics: {
          reportGenerated: false,
          locations: [{ file: 'greeting.py', line: 1, code: 'compile_error' }],
        },
      });
      expect(JSON.stringify(failed)).not.toMatch(/SECRET_BODY|SyntaxError|Traceback|Hello, Ada/);
      await writeFile(join(root, 'greeting.py'), 'def greet(name): return f"Hello, {name}!"\n');
      expect((await run()).status).toBe('passed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it
  .runIf(process.env.PBL_PACKAGE_TOOLCHAINS === '1')
  .each([
    'String value = null; System.out.println(value.length());',
    'int[] values = {}; System.out.println(values[0]);',
  ])(
  'classifies Java runtime exceptions as execution failures and permits repair: %s',
  async (body) => {
    const root = await mkdtemp(join(tmpdir(), 'pbl-java-runtime-'));
    const installed = {
      prepare: ['javac', '-d', '{build}', 'Greeting.java'],
      cases: [{ id: 'runtime', argv: ['java', '-cp', '{build}', 'Greeting'], stdout: 'hello\n' }],
    };
    const run = async () => {
      const observed = await promisify(execFile)(
        '/bin/sh',
        ['-c', evaluationCommand(installed, 'runtime')],
        { cwd: root },
      );
      return evaluationOutcome(
        installed,
        'runtime',
        { state: 'exited', exitCode: 0, ...observed },
        ['Greeting.java'],
      );
    };
    try {
      await writeFile(
        join(root, 'Greeting.java'),
        `public class Greeting { public static void main(String[] args) { ${body} } }`,
      );
      expect(await run()).toMatchObject({
        status: 'failed',
        failureKind: 'assertion',
        publicDiagnostics: {
          reportGenerated: true,
          caseResults: [{ id: 'runtime', passed: false, reason: 'execution' }],
        },
      });
      expect(JSON.stringify(await run())).not.toMatch(
        /infrastructure|NullPointerException|IndexOutOfBoundsException|at Greeting|locations/,
      );
      await writeFile(
        join(root, 'Greeting.java'),
        'public class Greeting { public static void main(String[] args) { System.out.println("hello"); } }',
      );
      expect((await run()).status).toBe('passed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

it
  .runIf(process.env.PBL_PACKAGE_TOOLCHAINS === '1')
  .each(['Greeting.java', 'at school/Greeting.java', 'at school(foo/Greeting.java'])(
  'locates a real javac error in %s and passes after repair',
  async (file) => {
    const root = await mkdtemp(join(tmpdir(), 'pbl-javac-'));
    const installed = {
      resources: { 'tests/future-stage.java': 'INVALID FUTURE API AND SOURCE' },
      prepare: ['javac', '-d', '{build}', file],
      cases: [{ id: 'greeting', argv: ['java', '-cp', '{build}', 'Greeting'], stdout: 'hello\n' }],
    };
    const run = async () => {
      const observed = await promisify(execFile)(
        '/bin/sh',
        ['-c', evaluationCommand(installed, 'javac')],
        { cwd: root },
      );
      return evaluationOutcome(installed, 'javac', { state: 'exited', exitCode: 0, ...observed }, [
        file,
      ]);
    };
    try {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(
        join(root, file),
        'public class Greeting { public static void main(String[] args) { System.out.println(missing); } }',
      );
      expect(await run()).toMatchObject({
        status: 'failed',
        failureKind: 'compile',
        publicDiagnostics: {
          locations: [
            {
              file,
              line: 1,
              code: expect.stringMatching(/^(cannot_find_symbol|compile_error)$/),
            },
          ],
        },
      });
      await writeFile(
        join(root, file),
        'public class Greeting { public static void main(String[] args) { System.out.println("hello"); } }',
      );
      expect((await run()).status).toBe('passed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('normalizes colored compiler diagnostics without publishing messages, source, or private fixture paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pbl-colored-'));
  try {
    const installed = {
      prepare: [
        'python3',
        '-c',
        'import sys; print("\\x1b[31m[ERROR] Greeting.java:[7,2] incompatible types: SECRET_TYPE\\x1b[0m",file=sys.stderr); print("/tmp/private-fixture.java:2: error: SECRET_FIXTURE",file=sys.stderr); sys.exit(1)',
      ],
      cases: spec.cases,
    };
    const observed = await promisify(execFile)(
      '/bin/sh',
      ['-c', evaluationCommand(installed, 'colored')],
      { cwd: root },
    );
    const outcome = evaluationOutcome(
      installed,
      'colored',
      { state: 'exited', exitCode: 0, ...observed },
      ['Greeting.java'],
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      failureKind: 'compile',
      publicDiagnostics: { locations: [{ file: 'Greeting.java', line: 7, code: 'type_mismatch' }] },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/SECRET|private-fixture|\u001b/);
    const untrusted = evaluationOutcome(
      installed,
      'colored',
      { state: 'exited', exitCode: 0, ...observed },
      [],
    );
    expect(untrusted.status).toBe('error');
    expect(JSON.stringify(untrusted)).not.toContain('Greeting.java');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not blame learner code for a failed preparation without public-source diagnostics', async () => {
  const installed = { ...spec, prepare: ['python3', '-c', 'raise RuntimeError("SECRET_FIXTURE")'] };
  const observed = await promisify(execFile)('/bin/sh', [
    '-c',
    evaluationCommand(installed, 'fixture'),
  ]);
  const outcome = evaluationOutcome(
    installed,
    'fixture',
    { state: 'exited', exitCode: 0, ...observed },
    ['greeting.py'],
  );
  expect(outcome).toMatchObject({ status: 'error', failureKind: 'infrastructure' });
  expect(JSON.stringify(outcome)).not.toMatch(/SECRET_FIXTURE|Traceback|greeting.py/);
});

it('classifies a syntax error in the private assessment driver as an unreliable assessment', async () => {
  const installed = {
    resources: { 'tests/private.py': 'def hidden_check(\n SECRET_EXPECTED' },
    cases: [
      {
        id: 'public',
        argv: ['python3', '{resources}/tests/private.py'],
        stdout: 'PRIVATE_EXPECTED',
      },
    ],
  };
  const observed = await promisify(execFile)('/bin/sh', [
    '-c',
    evaluationCommand(installed, 'private-syntax'),
  ]);
  const outcome = evaluationOutcome(
    installed,
    'private-syntax',
    { state: 'exited', exitCode: 0, ...observed },
    ['greeting.py'],
  );
  expect(outcome).toMatchObject({ status: 'error', failureKind: 'infrastructure' });
  expect(JSON.stringify(outcome)).not.toMatch(/SECRET_EXPECTED|PRIVATE_EXPECTED|private.py/);
});
describe('trusted evaluation driver', () => {
  it.each([
    ['def greet(name): return f"Hello, {name}!"', true],
    ['import sys\nsys.exit(0)', false],
    ['def greet(name): return "wrong"', false],
    ['raise RuntimeError("broken import")', false],
  ])('checks actual output rather than child exit success: %s', async (code, passed) => {
    const root = await mkdtemp(join(tmpdir(), 'pbl-eval-'));
    try {
      await writeFile(join(root, 'greeting.py'), code);
      const result = await promisify(execFile)(
        '/bin/sh',
        ['-c', evaluationCommand(spec, 'run-1')],
        { cwd: root, timeout: 10000 },
      );
      expect(evaluationPassed(spec, 'run-1', result.stdout)).toBe(passed);
      expect(evaluationPassed(spec, 'other-run', result.stdout)).toBe(false);
      const outcome = evaluationOutcome(spec, 'run-1', {
        state: 'exited',
        exitCode: 0,
        stdout: result.stdout,
        stderr: '',
      });
      expect(outcome.status).toBe(passed ? 'passed' : 'failed');
      expect(outcome.publicDiagnostics?.caseResults).toHaveLength(spec.cases.length);
      expect(JSON.stringify(outcome)).not.toContain('PBL_RESULT:');
      expect(JSON.stringify(outcome)).not.toContain('from greeting import');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects missing, duplicated and partial completion records', () => {
    expect(evaluationPassed(spec, 'id', '')).toBe(false);
    expect(evaluationPassed(spec, 'id', 'PBL_RESULT:id:{"build":true,"checks":[]}')).toBe(false);
    const line =
      'PBL_RESULT:id:' +
      JSON.stringify({
        build: true,
        checks: spec.cases.map((c) => ({
          id: c.id,
          exitCode: 0,
          reason: null,
          stdoutDigest: createHash('sha256').update(c.stdout).digest('hex'),
        })),
      });
    expect(evaluationPassed(spec, 'id', line)).toBe(true);
    expect(evaluationPassed(spec, 'id', line + '\n' + line)).toBe(false);
  });
});

it('never exposes raw logs, expected answers or driver commands on an unreliable result', () => {
  const outcome = evaluationOutcome(spec, 'id', {
    state: 'exited',
    exitCode: 0,
    stdout: '3/3 passed\nprivate test source\nSECRET_EXPECTED',
    stderr: 'SECRET credential and traceback',
  });
  expect(outcome.status).toBe('error');
  expect(outcome.failureKind).toBe('infrastructure');
  expect(JSON.stringify(outcome)).not.toMatch(/SECRET|private test/);
});
it.each(['failed', 'timed_out', 'cancelled'] as const)(
  'does not turn %s command execution into a code failure',
  (state) => {
    expect(
      evaluationOutcome(spec, 'id', { state, exitCode: null, stdout: '', stderr: '' }).status,
    ).toBe('error');
  },
);
it('distinguishes a missing interpreter from a learner implementation error', async () => {
  const installed = {
    cases: [
      {
        id: 'public-check',
        label: 'Check the result',
        argv: ['/no-such-interpreter'],
        stdout: 'SECRET expected',
      },
    ],
  };
  const result = await promisify(execFile)('/bin/sh', [
    '-c',
    evaluationCommand(installed, 'missing'),
  ]);
  const outcome = evaluationOutcome(installed, 'missing', {
    state: 'exited',
    exitCode: 0,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  expect(outcome).toMatchObject({ status: 'error', failureKind: 'infrastructure' });
  expect(JSON.stringify(outcome)).not.toContain('SECRET');
});

it.each([
  ['output', 'failed', 'assertion'],
  ['execution', 'failed', 'assertion'],
  ['timeout', 'failed', 'timeout'],
  ['environment', 'error', 'infrastructure'],
] as const)(
  'classifies public case %s without exposing hidden input or expected output',
  (reason, status, failureKind) => {
    const stdout =
      'PBL_RESULT:id:' +
      JSON.stringify({
        build: true,
        checks: spec.cases.map((c) => ({
          id: c.id,
          exitCode: reason === 'execution' ? 1 : null,
          stdoutDigest: null,
          reason,
        })),
      });
    const result = evaluationOutcome(spec, 'id', {
      state: 'exited',
      exitCode: 0,
      stdout,
      stderr: 'SECRET',
    });
    expect(result).toMatchObject({ status, failureKind });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PBL_RESULT|from greeting|Hello, Ada/);
  },
);

it('never puts expected stdout or its digest in the sandbox command payload', () => {
  const expected = 'PRIVATE_EXPECTED_SENTINEL_1729\n';
  const command = evaluationCommand(
    { cases: [{ id: 'private', argv: ['python3', '-c', 'print(1)'], stdout: expected }] },
    'private-run',
  );
  // Decode the payload as a learner inspecting its parent command line could do.
  const encoded = command.match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)![1]!;
  const decoded = Buffer.from(encoded, 'base64').toString();
  expect(decoded).not.toContain('PRIVATE_EXPECTED');
  expect(decoded).not.toContain(createHash('sha256').update(expected).digest('hex'));
  expect(JSON.parse(decoded).spec.cases[0]).toEqual({
    id: 'private',
    argv: ['python3', '-c', 'print(1)'],
  });
  const forged =
    'PBL_RESULT:private-run:' +
    JSON.stringify({
      build: true,
      checks: [
        {
          id: 'private',
          passed: true,
          exitCode: 0,
          reason: null,
          stdoutDigest: createHash('sha256').update('wrong').digest('hex'),
        },
      ],
    });
  expect(
    evaluationPassed(
      { cases: [{ id: 'private', argv: [], stdout: expected }] },
      'private-run',
      forged,
    ),
  ).toBe(false);
});

it.each([
  {
    label: 'NPE frame',
    file: 'Greeting.java',
    stderr:
      'Exception in thread "main" java.lang.NullPointerException\n\tat Greeting.greet(Greeting.java:3)\n',
    expected: 'assertion',
  },
  {
    label: 'module frame',
    file: 'Greeting.java',
    stderr: '\tat app/pkg.Greeting.greet(Greeting.java:3)\n',
    expected: 'assertion',
  },
  {
    label: 'prefixed module frame',
    file: 'Greeting.java',
    stderr: '[ERROR] \tat app/pkg.Greeting.greet(Greeting.java:3)\n',
    expected: 'assertion',
  },
  {
    label: 'Java path resembling a stack-frame prefix',
    file: 'at school(foo/Greeting.java',
    stderr: 'at school(foo/Greeting.java:3: error: incompatible types\n',
    expected: 'compile',
  },
  {
    label: 'prefixed Java path resembling a stack-frame prefix',
    file: 'at school(foo/Greeting.java',
    stderr: '[ERROR] at school(foo/Greeting.java:[3,2] incompatible types\n',
    expected: 'compile',
  },
  {
    label: 'Java path with spaces',
    file: 'at school/Greeting.java',
    stderr: 'at school/Greeting.java:3: error: incompatible types\n',
    expected: 'compile',
  },
  {
    label: 'Python path with spaces',
    file: 'at school/greeting.py',
    stderr: '  File "at school/greeting.py", line 3\nSyntaxError: invalid syntax\n',
    expected: 'compile',
  },
])('parses $label without requiring a JDK', async ({ file, stderr, expected }) => {
  const root = await mkdtemp(join(tmpdir(), 'pbl-diagnostics-'));
  try {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), 'public learner source');
    const installed = {
      cases: [
        {
          id: 'error',
          argv: [
            'python3',
            '-c',
            `import sys; sys.stderr.write(${JSON.stringify(stderr)}); sys.exit(1)`,
          ],
          stdout: '',
        },
      ],
    };
    const observed = await promisify(execFile)(
      '/bin/sh',
      ['-c', evaluationCommand(installed, 'diagnostic')],
      { cwd: root },
    );
    const outcome = evaluationOutcome(
      installed,
      'diagnostic',
      { state: 'exited', exitCode: 0, ...observed },
      [file],
    );
    expect(outcome).toMatchObject({ status: 'failed', failureKind: expected });
    if (expected === 'compile')
      expect(outcome.publicDiagnostics?.locations?.[0]).toMatchObject({ file, line: 3 });
    else expect(outcome.publicDiagnostics?.locations).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
