import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  InvalidBootConfigurationError,
  isInvalidBootConfigurationError,
  runConfigurationCheck,
} from '@/lib/server/boot-configuration-error';
import { exitOnBootFailure, formatBootFailure } from '@/lib/server/boot-failure';

afterEach(() => {
  vi.restoreAllMocks();
});

function refused(message: string): InvalidBootConfigurationError {
  try {
    runConfigurationCheck(() => {
      throw new Error(message);
    });
  } catch (error) {
    return error as InvalidBootConfigurationError;
  }
  throw new Error('runConfigurationCheck did not throw');
}

describe('runConfigurationCheck', () => {
  it('marks what a check throws as a refused configuration, keeping its message', () => {
    const error = refused('ACCESS_CODE must be set');
    expect(isInvalidBootConfigurationError(error)).toBe(true);
    expect(error.message).toBe('ACCESS_CODE must be set');
    expect((error.cause as Error).message).toBe('ACCESS_CODE must be set');
  });

  it('does not mark other errors', () => {
    expect(isInvalidBootConfigurationError(new Error('ACCESS_CODE must be set'))).toBe(false);
    expect(isInvalidBootConfigurationError('bad value')).toBe(false);
    expect(() => runConfigurationCheck(() => 'fine')).not.toThrow();
  });
});

describe('formatBootFailure', () => {
  it('prints a refused configuration as one line with the original message', () => {
    expect(formatBootFailure(refused('bad value'))).toBe(
      '[boot] Invalid server configuration; the server will not start: bad value',
    );
  });

  it('labels any other failure distinctly, with its stack and cause', () => {
    const missing = Object.assign(new Error("Cannot find module './chunk-42.js'"), {
      code: 'MODULE_NOT_FOUND',
    });
    const failure = new TypeError('startup step failed', { cause: missing });
    const text = formatBootFailure(failure);

    expect(text).toMatch(/^\[boot\] Server startup failed; the server will not start:\n/);
    expect(text).not.toContain('Invalid server configuration');
    expect(text).toContain('TypeError: startup step failed');
    expect(text).toMatch(/\n\s+at /);
    expect(text).toContain("Caused by: Error: Cannot find module './chunk-42.js'");
  });

  it('prints a non-Error failure as a startup failure', () => {
    expect(formatBootFailure('boom')).toBe(
      '[boot] Server startup failed; the server will not start:\nboom',
    );
  });
});

describe('exitOnBootFailure', () => {
  function stubProcess() {
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
    return { order, exit, flush: () => flush?.() };
  }

  it('prints a refused configuration, then exits 1 after stderr flushes', async () => {
    const { order, exit, flush } = stubProcess();

    const done = exitOnBootFailure(refused('ACCESS_CODE must be set'));
    // Not before stderr has flushed: a pipe may be asynchronous.
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    flush();
    await done;

    expect(order).toEqual([
      'write:[boot] Invalid server configuration; the server will not start: ACCESS_CODE must be set\n',
      'exit:1',
    ]);
  });

  it('exits 1 on an unexpected failure too, printing it as a startup failure', async () => {
    const { order, flush } = stubProcess();

    const done = exitOnBootFailure(new Error("Cannot find module './chunk-42.js'"));
    await Promise.resolve();
    flush();
    await done;

    expect(order).toHaveLength(2);
    expect(order[0]).toMatch(/^write:\[boot\] Server startup failed; the server will not start:\n/);
    expect(order[0]).toContain("Error: Cannot find module './chunk-42.js'");
    expect(order[1]).toBe('exit:1');
  });
});
