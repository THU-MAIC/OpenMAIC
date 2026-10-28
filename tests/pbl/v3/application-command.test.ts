import { expect, it, vi } from 'vitest';
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
