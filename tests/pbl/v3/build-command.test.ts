import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
vi.mock('server-only', () => ({}));
import { currentBuildCommand } from '@/lib/server/pbl-v3/build-command';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import { packageBuiltin, validateProjectPackage } from '@/lib/server/pbl-v3/project-package';
import {
  evaluationFor,
  evaluationCommand,
  evaluationPassed,
  evaluationOutcome,
} from '@/lib/server/pbl-v3/evaluation';

const sample = (java: boolean) =>
  validateProjectPackage(
    packageBuiltin(
      installedProject({ id: java ? 'greeting-java' : 'greeting-python-lab', version: '1.1.0' }),
    ),
  ).project;
it('retains existing commands and excludes private or unrelated paths', () => {
  const project = sample(false);
  expect(currentBuildCommand(project, Object.keys(project.files))).toBe(project.buildCommand);
  const command = currentBuildCommand(project, [
    ...Object.keys(project.files),
    'src/helper.py',
    'tests/private.py',
    'outside.py',
    'src/example.java',
  ])!;
  expect(command).toContain('src/helper.py');
  expect(command).not.toMatch(/tests\/private|outside\.py|example\.java/);
  expect(
    currentBuildCommand({ ...project, buildCommand: undefined }, ['src/helper.py']),
  ).toBeUndefined();
});
it('checks newly created Python source without executing it', async () => {
  const project = sample(false),
    root = await mkdtemp(join(tmpdir(), 'pbl-build-new-python-'));
  try {
    for (const [path, text] of Object.entries(project.files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const command = currentBuildCommand(project, [...Object.keys(project.files), 'src/helper.py'])!;
    await writeFile(join(root, 'src/helper.py'), 'raise RuntimeError("must not execute")\n');
    await promisify(execFile)('/bin/sh', ['-c', command], { cwd: root });
    await writeFile(join(root, 'src/helper.py'), 'def broken(\n');
    await expect(promisify(execFile)('/bin/sh', ['-c', command], { cwd: root })).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each(['builtin', 'packaged', 'added'])(
  'accepts Python BOM source in %s builds',
  async (kind) => {
    const added = kind === 'added';
    const project =
        kind === 'builtin'
          ? installedProject({ id: 'greeting-python-lab', version: '1.1.0' })
          : sample(false),
      root = await mkdtemp(join(tmpdir(), 'pbl-build-bom-'));
    try {
      for (const [path, text] of Object.entries(project.files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
      }
      const path = added
        ? 'src/helper.py'
        : Object.keys(project.files).find((p) => p.endsWith('.py'))!;
      await mkdir(dirname(join(root, path)), { recursive: true });
      const command = currentBuildCommand(project, [
        ...Object.keys(project.files),
        ...(added ? [path] : []),
      ])!;
      await writeFile(
        join(root, path),
        '\uFEFF# coding: utf-8\nraise RuntimeError("must not execute")\n',
      );
      await promisify(execFile)('/bin/sh', ['-c', command], { cwd: root });
      await writeFile(join(root, path), '\uFEFFdef broken(\n');
      await expect(
        promisify(execFile)('/bin/sh', ['-c', command], { cwd: root }),
      ).rejects.toThrow();
      await writeFile(join(root, path), 'value = 1\uFEFF\n');
      await expect(
        promisify(execFile)('/bin/sh', ['-c', command], { cwd: root }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it.each(
  [
    'src/Greeting.java',
    '././src/Greeting.java',
    'src//Greeting.java',
    './src/./Greeting.java',
    'src/../src/Greeting.java',
  ].flatMap((path) => [false, true].map((inCase) => ({ path, inCase }))),
)(
  'includes helpers for $path (case compiler: $inCase) without duplicating authored sources',
  ({ path, inCase }) => {
    const project = sample(true);
    const argv = ['javac', '-d', '{build}', path, '././src/Helper.java'];
    project.evaluations.greeting = inCase
      ? { cases: [{ id: 'compile', argv, stdout: '' }] }
      : { ...project.evaluations.greeting!, prepare: argv };
    const spec = evaluationFor(project, 'greeting', [
      ...Object.keys(project.files),
      'src/Helper.java',
      'src/Extra.java',
      'tests/private.java',
    ]);
    const actual = inCase ? spec.cases[0]!.argv : spec.prepare!;
    expect(actual).toEqual([...argv, './src/Extra.java']);
    expect(actual).not.toContain('./tests/private.java');
    expect(inCase ? spec.cases[0]!.literalArgIndexes : spec.prepareLiteralArgIndexes).toEqual([
      argv.length,
    ]);
  },
);
it
  .runIf(process.env.PBL_PACKAGE_TOOLCHAINS === '1')
  .each(['src/Greeting.java', '././src/Greeting.java', 'src//Greeting.java'])(
  'compiles a new Java dependency with %s and rejects a broken helper',
  async (source) => {
    const project = sample(true),
      root = await mkdtemp(join(tmpdir(), 'pbl-build-new-java-'));
    project.evaluations.greeting = {
      ...project.evaluations.greeting!,
      prepare: project.evaluations.greeting!.prepare!.map((arg) =>
        arg === 'src/Greeting.java' ? source : arg,
      ),
    };
    try {
      await mkdir(join(root, 'src'));
      await writeFile(
        join(root, 'src/Greeting.java'),
        'public class Greeting { public static String greet(String name) { return Helper.message(name); } public static void main(String[] args) { System.out.println(greet(args[0])); } }',
      );
      await writeFile(
        join(root, 'src/Helper.java'),
        'public class Helper { public static String message(String name) { return "Hello, " + name + "!"; } }',
      );
      const command = currentBuildCommand(project, [
        ...Object.keys(project.files),
        'src/Helper.java',
      ])!;
      await promisify(execFile)('/bin/sh', ['-c', command], { cwd: root });
      const spec = evaluationFor(project, 'greeting', [
        ...Object.keys(project.files),
        'src/Helper.java',
        'tests/private.java',
      ]);
      expect(spec.prepare).toContain('./src/Helper.java');
      expect(spec.prepare).not.toContain('./tests/private.java');
      const formal = evaluationCommand(spec, 'new-java-source');
      const { stdout } = await promisify(execFile)('/bin/sh', ['-c', formal], { cwd: root });
      expect(evaluationPassed(spec, 'new-java-source', stdout)).toBe(true);
      await writeFile(join(root, 'src/Helper.java'), 'public class Helper { broken }');
      await expect(
        promisify(execFile)('/bin/sh', ['-c', command], { cwd: root }),
      ).rejects.toThrow();
      const failed = await promisify(execFile)('/bin/sh', ['-c', formal], { cwd: root });
      expect(evaluationPassed(spec, 'new-java-source', failed.stdout)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);

it.runIf(process.env.PBL_PACKAGE_TOOLCHAINS === '1').each([
  { path: 'src/{build}.java', inCase: false },
  { path: 'src/{resources}.java', inCase: false },
  { path: 'src/{build}/Spare.java', inCase: true },
  { path: 'src/{resources}/Spare.java', inCase: true },
])(
  'keeps appended $path literal while authored templates still expand (case compiler: $inCase)',
  async ({ path, inCase }) => {
    const project = sample(true),
      root = await mkdtemp(join(tmpdir(), 'pbl-literal-java-'));
    try {
      await mkdir(join(root, 'src'));
      await writeFile(
        join(root, 'src/Greeting.java'),
        'public class Greeting { public static String greet(String name) { return "Hello, " + name + "!"; } public static void main(String[] args) { System.out.println(greet(args[0])); } }',
      );
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), 'class Spare {}');
      const original = project.evaluations.greeting!;
      if (inCase)
        project.evaluations.greeting = {
          cases: [
            {
              id: 'compile',
              argv: ['javac', '-d', '{build}', '././src/Greeting.java'],
              stdout: '',
            },
            ...original.cases,
          ],
        };
      const command = currentBuildCommand(project, [...Object.keys(project.files), path])!;
      await promisify(execFile)('/bin/sh', ['-c', command], { cwd: root });
      const spec = evaluationFor(project, 'greeting', [...Object.keys(project.files), path]);
      spec.resources = { ...spec.resources, 'tests/probe.txt': 'private fixture' };
      spec.cases.push({
        id: 'resource-template',
        argv: [
          'python3',
          '-c',
          'from pathlib import Path; import sys; print(Path(sys.argv[1]).read_text())',
          '{resources}/tests/probe.txt',
        ],
        stdout: 'private fixture\n',
      });
      // Identical text in an authored argument must keep its template meaning;
      // only the appended source argument is literal, by position.
      spec.cases.push({
        id: 'authored-template-provenance',
        argv: [
          'python3',
          '-c',
          'import sys; print("expanded" if chr(123) not in sys.argv[1] else "literal")',
          `./${path}`,
        ],
        stdout: 'expanded\n',
      });
      const run = async () =>
        promisify(execFile)('/bin/sh', ['-c', evaluationCommand(spec, 'literal-source')], {
          cwd: root,
        });
      expect(evaluationPassed(spec, 'literal-source', (await run()).stdout)).toBe(true);
      await writeFile(join(root, path), 'class Spare { broken }');
      const failed = await run();
      expect(evaluationPassed(spec, 'literal-source', failed.stdout)).toBe(false);
      expect(
        evaluationOutcome(spec, 'literal-source', { state: 'exited', exitCode: 0, ...failed }, [
          ...Object.keys(project.files),
          path,
        ]),
      ).toMatchObject({
        status: 'failed',
        failureKind: 'compile',
        publicDiagnostics: { locations: [expect.objectContaining({ file: path })] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
