import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// No feature-flags mock: the probe reads the REAL environment, so each row
// below exercises the actual `isAgentRuntimeConfigured()` /
// `isAgentRuntimeEnabled()` predicates. The suite runs without `.env.local`
// (see tests/setup-env.ts), so "no DATABASE_URL in the environment at all"
// is the default state here.
import { GET } from '@/app/api/agent/runtime/route';

const ENV_KEYS = ['OPENMAIC_AGENT_RUNTIME_ENABLED', 'DATABASE_URL'] as const;

describe('agent runtime probe', () => {
  const originals = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originals.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originals.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    originals.clear();
  });

  it.each([
    ['the runtime flag is off (the no-DB default)', undefined, undefined, false, false],
    ['the runtime is on but DATABASE_URL is absent', 'true', undefined, false, true],
    ['the runtime is on and DATABASE_URL is set', 'true', 'postgres://runtime', true, true],
  ])(
    'reports %s as { enabled: %s, runtimeEnabled: %s }',
    async (_case, runtimeFlag, databaseUrl, enabled, runtimeEnabled) => {
      if (runtimeFlag !== undefined) process.env.OPENMAIC_AGENT_RUNTIME_ENABLED = runtimeFlag;
      if (databaseUrl !== undefined) process.env.DATABASE_URL = databaseUrl;

      // `enabled` is usability: it must be true only when the runtime can
      // actually serve a request. `runtimeEnabled` is the raw intent flag, so
      // "off by choice" (false/false) is distinguishable from "on but
      // unusable" (false/true).
      await expect((await GET()).json()).resolves.toEqual({ enabled, runtimeEnabled });
    },
  );
});
