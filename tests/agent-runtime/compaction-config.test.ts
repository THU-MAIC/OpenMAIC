/**
 * Agent runtime compaction config: OPENMAIC_AGENT_COMPACTION_* env knobs.
 * The config object is read at module load, so each case re-imports it after
 * scrubbing the env.
 *
 * Reserve/keep are OPTIONAL in the config — present only when the
 * operator explicitly set the env knob. When absent, the compaction runtime
 * scales them to the driver model's context window (see
 * tests/agent-runtime/compaction.test.ts), instead of the runner shoving the
 * fixed pi defaults (16384/20000) in as explicit overrides and defeating that
 * scaling (a small window then compacts on every round).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const COMPACTION_ENV_KEYS = [
  'OPENMAIC_AGENT_COMPACTION_ENABLED',
  'OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS',
  'OPENMAIC_AGENT_COMPACTION_KEEP_RECENT_TOKENS',
] as const;

describe('agent runtime compaction config', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of COMPACTION_ENV_KEYS) delete process.env[key];
  });

  it('defaults to enabled with NO explicit reserve/keep (the runtime window-scales them)', async () => {
    const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
    expect(agentRuntimeConfig.compaction).toEqual({ enabled: true });
    expect('reserveTokens' in agentRuntimeConfig.compaction).toBe(false);
    expect('keepRecentTokens' in agentRuntimeConfig.compaction).toBe(false);
  });

  it('can be disabled via OPENMAIC_AGENT_COMPACTION_ENABLED=false', async () => {
    process.env.OPENMAIC_AGENT_COMPACTION_ENABLED = 'false';
    const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
    expect(agentRuntimeConfig.compaction.enabled).toBe(false);
  });

  it('accepts env overrides for reserve/keep tokens', async () => {
    process.env.OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS = '4096';
    process.env.OPENMAIC_AGENT_COMPACTION_KEEP_RECENT_TOKENS = '5000';
    const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
    expect(agentRuntimeConfig.compaction).toEqual({
      enabled: true,
      reserveTokens: 4096,
      keepRecentTokens: 5000,
    });
  });

  it('honors a single override without inventing the other', async () => {
    process.env.OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS = '4096';
    const { agentRuntimeConfig } = await import('@/lib/server/agent-runtime/config');
    expect(agentRuntimeConfig.compaction).toEqual({ enabled: true, reserveTokens: 4096 });
  });
});
