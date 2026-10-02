import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNextConfigEnv } from 'next/dist/lib/static-env';

const FLAG = 'NEXT_PUBLIC_PI_CHAT_ENABLED';

describe('Pi chat build-time client/server selection', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, '', 'true', '1', 'false', '0', 'unsupported'])(
    'pins build value %s in the Next.js inlining map despite a runtime override',
    async (buildValue) => {
      vi.stubEnv(FLAG, buildValue);
      vi.resetModules();
      const { default: config } = await import('@/next.config');

      // Both server and client compilation consume Next's static env map. In
      // particular, an unset public variable must become a defined constant.
      const defines = getNextConfigEnv(config as Parameters<typeof getNextConfigEnv>[0]);
      expect(defines[`process.env.${FLAG}`]).toBe(buildValue ?? '');

      vi.stubEnv(FLAG, buildValue === 'false' ? 'true' : 'false');
      expect(getNextConfigEnv(config as Parameters<typeof getNextConfigEnv>[0])).toEqual(defines);
    },
  );
});
