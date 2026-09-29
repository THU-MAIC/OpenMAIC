import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import {
  resetDatabasePasswordWarningForTests,
  warnIfDefaultDatabasePasswordIsPublished,
} from '@/lib/server/database-password-warning';

const DEFAULT_URL = 'postgres://openmaic:openmaic-dev@postgres:5432/openmaic';

describe('warnIfDefaultDatabasePasswordIsPublished', () => {
  let warn: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    resetDatabasePasswordWarningForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) as MockInstance<
      (...args: unknown[]) => void
    >;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function run(publishAddress: string, databaseUrl: string): boolean {
    resetDatabasePasswordWarningForTests();
    warn.mockClear();
    vi.stubEnv('OPENMAIC_PUBLISH_ADDRESS', publishAddress);
    vi.stubEnv('DATABASE_URL', databaseUrl);
    warnIfDefaultDatabasePasswordIsPublished();
    return warn.mock.calls.some((args: unknown[]) =>
      args.join(' ').includes('development password'),
    );
  }

  it('warns when published beyond loopback with the Compose default password', () => {
    expect(run('0.0.0.0', DEFAULT_URL)).toBe(true);
    expect(run('192.168.1.20', DEFAULT_URL)).toBe(true);
  });

  it('stays quiet on loopback, with no declared address, or with another password', () => {
    expect(run('127.0.0.1', DEFAULT_URL)).toBe(false);
    expect(run('', DEFAULT_URL)).toBe(false);
    expect(run('0.0.0.0', 'postgres://openmaic:s3cret-long@postgres:5432/openmaic')).toBe(false);
    expect(run('0.0.0.0', '')).toBe(false);
    expect(run('0.0.0.0', 'not a url')).toBe(false);
  });

  it('warns once per process', () => {
    vi.stubEnv('OPENMAIC_PUBLISH_ADDRESS', '0.0.0.0');
    vi.stubEnv('DATABASE_URL', DEFAULT_URL);
    warnIfDefaultDatabasePasswordIsPublished();
    warnIfDefaultDatabasePasswordIsPublished();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
