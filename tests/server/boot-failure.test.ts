import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  exitOnInvalidBootConfiguration,
  formatBootConfigurationFailure,
} from '@/lib/server/boot-failure';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exitOnInvalidBootConfiguration', () => {
  it('prints one line with the original message, then exits 1 after stderr flushes', async () => {
    const order: string[] = [];
    let flush: (() => void) | undefined;
    vi.spyOn(process.stderr, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: () => void,
    ) => {
      order.push(`write:${String(chunk)}`);
      flush = callback;
      return true;
    }) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      order.push(`exit:${code}`);
    }) as never);

    const done = exitOnInvalidBootConfiguration(new Error('ACCESS_CODE must be set'));
    // Not before stderr has flushed: a pipe may be asynchronous.
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    flush?.();
    await done;

    expect(order).toEqual([
      'write:[boot] Invalid server configuration; the server will not start: ACCESS_CODE must be set\n',
      'exit:1',
    ]);
  });

  it('formats a non-Error refusal too', () => {
    expect(formatBootConfigurationFailure('bad value')).toBe(
      '[boot] Invalid server configuration; the server will not start: bad value',
    );
  });
});
