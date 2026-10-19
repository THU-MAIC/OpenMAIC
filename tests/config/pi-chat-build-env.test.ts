import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants';

const FLAG = 'NEXT_PUBLIC_PI_CHAT_ENABLED';

async function loadConfig(phase: string, flagValue: string | undefined): Promise<NextConfig> {
  vi.stubEnv(FLAG, flagValue);
  vi.resetModules();
  const { default: config } = await import('@/next.config');
  return config(phase);
}

describe('Legacy Pi chat flag build check', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['false', '0', 'FALSE', 'no', ' true'])(
    'fails a production build when the flag is %j',
    async (flagValue) => {
      const build = loadConfig(PHASE_PRODUCTION_BUILD, flagValue);

      await expect(build).rejects.toThrow(`NEXT_PUBLIC_PI_CHAT_ENABLED is set to "${flagValue}"`);
      await expect(build).rejects.toThrow('legacy director-graph classroom chat has been removed');
      await expect(build).rejects.toThrow('Remove NEXT_PUBLIC_PI_CHAT_ENABLED');
      await expect(build).rejects.toThrow('Settings → Course Model Config');
      await expect(build).rejects.toThrow('`classroom` slot in openmaic.yml');
      await expect(build).rejects.toThrow('native `google` preset');
      await expect(build).rejects.toThrow('administrator');
    },
  );

  it.each([undefined, '', 'true', '1'])(
    'builds normally when the flag is %j',
    async (flagValue) => {
      const config = await loadConfig(PHASE_PRODUCTION_BUILD, flagValue);

      expect(config.output).toBe('standalone');
      expect(config.env).toBeUndefined();
    },
  );

  // Current policy: only the production build checks the flag.
  it('does not check the flag outside a production build', async () => {
    const config = await loadConfig(PHASE_DEVELOPMENT_SERVER, 'false');

    expect(config.output).toBe('standalone');
  });
});
