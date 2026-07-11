import { describe, it, expect } from 'vitest';
import { makeQuotaHook } from '@/lib/agent/runtime/quota';

describe('quota hook (stub)', () => {
  it('does not terminate while budget remains', async () => {
    const hook = makeQuotaHook({ remaining: () => 100 });
    expect((await hook({} as never))?.terminate).toBeFalsy();
  });
  it('terminates when budget exhausted', async () => {
    const hook = makeQuotaHook({ remaining: () => 0 });
    expect((await hook({} as never))?.terminate).toBe(true);
  });
});
