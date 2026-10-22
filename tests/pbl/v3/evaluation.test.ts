import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      JSON.stringify({ build: true, checks: spec.cases.map((c) => ({ id: c.id, passed: true })) });
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
        checks: spec.cases.map((c) => ({ id: c.id, passed: false, reason })),
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
