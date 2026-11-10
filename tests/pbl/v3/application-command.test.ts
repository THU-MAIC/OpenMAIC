import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('server-only', () => ({}));
import { MAX_COMMAND_BYTES } from '@/lib/sandbox/types';
import {
  applicationLaunchCommand,
  applicationProbeCommand,
} from '@/lib/server/pbl-v3/application-command';

it('checks the final UTF-8 shell command, preserving accepted quoted arguments', () => {
  expect(applicationLaunchCommand(['python3', "a'b.py", '你好'])).toBe(
    "exec 'python3' 'a'\\''b.py' '你好'",
  );
  expect(() =>
    applicationLaunchCommand(['python3', 'app.py', '界'.repeat(MAX_COMMAND_BYTES / 3)]),
  ).toThrow('32 KiB');
  expect(() => applicationLaunchCommand(['python3', 'app.py', "'".repeat(9000)])).toThrow('32 KiB');
  expect(() =>
    applicationProbeCommand(
      Array.from({ length: 256 }, (_, i) => 'x'.repeat(230) + i + '.py'),
      8000,
      '/',
    ),
  ).toThrow('32 KiB');
  expect(Buffer.byteLength(applicationProbeCommand(['app.py'], 8000, '/'))).toBeLessThan(
    MAX_COMMAND_BYTES,
  );
});

it('recompiles edited Java sources and drops classes for removed sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'pbl-java-launch-'));
  try {
    mkdirSync(join(root, 'src/demo'), { recursive: true });
    writeFileSync(
      join(root, 'src/demo/Helper.java'),
      'package demo; class Helper { static String value() { return "current-source"; } }',
    );
    writeFileSync(join(root, 'src/demo/Added.java'), 'package demo; class Added {}');
    writeFileSync(
      join(root, 'src/demo/Main.java'),
      `package demo;
public class Main {
  public static void main(String[] args) {
    String additionalClass;
    try { Class.forName("demo.Added"); additionalClass = "present"; }
    catch (ClassNotFoundException expected) { additionalClass = "absent"; }
    System.out.print(Helper.value() + ":" + args[0] + ":" + additionalClass);
  }
}`,
    );
    const argv = ['java', '-cp', '/tmp/pbl-project-build', 'demo.Main', 'hello'];
    const sources = ['src/demo/Main.java', 'src/demo/Helper.java'];
    const run = (inputs: string[]) =>
      execFileSync('/bin/sh', ['-c', applicationLaunchCommand(argv, inputs)], {
        cwd: root,
        env: { ...process.env, TMPDIR: root },
        encoding: 'utf8',
        timeout: 5000,
      });
    expect(run([...sources, 'src/demo/Added.java'])).toBe('current-source:hello:present');
    writeFileSync(
      join(root, 'src/demo/Helper.java'),
      'package demo; class Helper { static String value() { return "updated"; } }',
    );
    rmSync(join(root, 'src/demo/Added.java'));
    expect(run(sources)).toBe('updated:hello:absent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

it('rejects Java launch flags, missing entry sources and escaped paths', () => {
  const good = ['java', '-cp', '/tmp/pbl-project-build', 'demo.Main'];
  expect(() => applicationLaunchCommand(good)).toThrow('declared sources');
  expect(() =>
    applicationLaunchCommand(['java', '-jar', 'other.jar'], ['src/demo/Main.java']),
  ).toThrow();
  expect(() => applicationLaunchCommand(good, ['../Main.java'])).toThrow();
  expect(() => applicationLaunchCommand(good, ['src/Other.java'])).toThrow();
  expect(() =>
    applicationLaunchCommand(['java', '-cp', '/tmp/other', 'demo.Main'], ['src/demo/Main.java']),
  ).toThrow();
});
