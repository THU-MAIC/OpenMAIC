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
import { evaluationFor, evaluationCommand, evaluationPassed } from '@/lib/server/pbl-v3/evaluation';

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
it.runIf(process.env.PBL_PACKAGE_TOOLCHAINS === '1')(
  'compiles a new Java dependency and rejects a broken helper',
  async () => {
    const project = sample(true),
      root = await mkdtemp(join(tmpdir(), 'pbl-build-new-java-'));
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
);
