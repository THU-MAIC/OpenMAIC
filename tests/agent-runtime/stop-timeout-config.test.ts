/**
 * OPENMAIC_AGENT_RUNTIME_STOP_TIMEOUT_MS: how long shutdown waits for running
 * agent sessions. The config is read at module load, so each case re-imports it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function stopTimeoutMs(value: string): Promise<number> {
  vi.stubEnv('OPENMAIC_AGENT_RUNTIME_STOP_TIMEOUT_MS', value);
  const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
  return agentRuntimeConfig.stopTimeoutMs;
}

describe('agent runtime stop timeout', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to 10 seconds when unset', async () => {
    expect(await stopTimeoutMs('')).toBe(10_000);
  });

  it.each([
    ['25000', 25_000],
    [' 25000 ', 25_000],
    ['0', 0],
  ])('takes %j milliseconds as given', async (value, expected) => {
    expect(await stopTimeoutMs(value)).toBe(expected);
  });

  // A value such as "25s" would otherwise skip the wait entirely and hand
  // every session off at once.
  it.each(['25s', '-1', 'Infinity', '  ', '0x10', '2e4', '2.5'])(
    'keeps the default for %j',
    async (value) => {
      expect(await stopTimeoutMs(value)).toBe(10_000);
    },
  );

  // next dev kills the server 100 ms after Ctrl+C: a drain window there would
  // only keep sessions from being handed off.
  it('hands sessions off at once by default under next dev', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(await stopTimeoutMs('')).toBe(5_000);
    vi.resetModules();
    expect(await stopTimeoutMs('25000')).toBe(25_000);
  });
});
