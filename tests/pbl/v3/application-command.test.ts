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

it('compiles all declared Java sources before executing the current main class', () => {
  const root = mkdtempSync(join(tmpdir(), 'pbl-java-launch-'));
  try {
    mkdirSync(join(root, 'src/demo'), { recursive: true });
    writeFileSync(
      join(root, 'src/demo/Helper.java'),
      'package demo; class Helper { static String value() { return "current-source"; } }',
    );
    writeFileSync(
      join(root, 'src/demo/Main.java'),
      'package demo; public class Main { public static void main(String[] args) { System.out.print(Helper.value()+":"+args[0]); } }',
    );
    const command = applicationLaunchCommand(
      ['java', '-cp', '/tmp/pbl-project-build', 'demo.Main', 'hello'],
      ['src/demo/Main.java', 'src/demo/Helper.java'],
    );
    expect(execFileSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8' })).toBe(
      'current-source:hello',
    );
    writeFileSync(
      join(root, 'src/demo/Helper.java'),
      'package demo; class Helper { static String value() { return "updated"; } }',
    );
    expect(execFileSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8' })).toBe(
      'updated:hello',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
