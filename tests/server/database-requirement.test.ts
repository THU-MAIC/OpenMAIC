import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DATABASE_URL_REQUIRED_MESSAGE,
  requireDatabaseUrl,
} from '@/lib/server/database-requirement';

// register() is exercised for its database requirement only.
vi.mock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes: vi.fn() }));
vi.mock('@/lib/persistence/asset-pending-ttl', () => ({ resolveAssetPendingTtlMs: vi.fn() }));
const startAssetCollectorSchedule = vi.hoisted(() => vi.fn());
vi.mock('@/lib/persistence/asset-collector-schedule', () => ({ startAssetCollectorSchedule }));
vi.mock('@/lib/server/config-validation', () => ({ validateServerConfig: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => false }));

let exit: ReturnType<typeof vi.spyOn>;
let stderr: string[];

beforeEach(() => {
  stderr = [];
  startAssetCollectorSchedule.mockReset();
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    callback?: () => void,
  ) => {
    stderr.push(String(chunk));
    callback?.();
    return true;
  }) as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(process, 'once').mockReturnValue(process);
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the database requirement', () => {
  it.each([undefined, '', '   '])('refuses DATABASE_URL=%j', (value) => {
    expect(() => requireDatabaseUrl({ DATABASE_URL: value })).toThrow(
      DATABASE_URL_REQUIRED_MESSAGE,
    );
  });

  it('accepts a configured DATABASE_URL', () => {
    expect(() => requireDatabaseUrl({ DATABASE_URL: 'postgres://db/openmaic' })).not.toThrow();
  });

  it('names the fix for development and for a deployment', () => {
    expect(DATABASE_URL_REQUIRED_MESSAGE).toMatch(/DATABASE_URL is not set/);
    expect(DATABASE_URL_REQUIRED_MESSAGE).toMatch(/pnpm db:up/);
    expect(DATABASE_URL_REQUIRED_MESSAGE).toMatch(/docker compose up/);
  });

  it('exits the server at boot without DATABASE_URL, before anything starts', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/DATABASE_URL is not set/);

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(
      /^\[boot\] Invalid server configuration; the server will not start: DATABASE_URL is not set\./,
    );
    expect(stderr[0]).toContain('pnpm db:up');
    expect(startAssetCollectorSchedule).not.toHaveBeenCalled();
  });

  it('boots with DATABASE_URL set', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://boot/openmaic');
    const { register } = await import('@/instrumentation');

    await expect(register()).resolves.toBeUndefined();

    expect(exit).not.toHaveBeenCalled();
    expect(startAssetCollectorSchedule).toHaveBeenCalledOnce();
  });
});
