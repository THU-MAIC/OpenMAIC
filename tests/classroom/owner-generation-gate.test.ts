import { describe, expect, it } from 'vitest';

import { mayStartOwnerGeneration } from '@/lib/classroom/stage-ownership-signal';

describe('classroom generation owner gate', () => {
  it('fails closed under server-backed persistence until ownership is resolved', () => {
    expect(mayStartOwnerGeneration(true, 'unresolved')).toBe(false);
  });

  it('refuses a resolved non-owner', () => {
    expect(mayStartOwnerGeneration(true, 'not-owner')).toBe(false);
  });

  it('allows only a resolved owner', () => {
    expect(mayStartOwnerGeneration(true, 'owner')).toBe(true);
  });

  it('is inert in browser-only mode, whatever the sidecar said', () => {
    for (const ownership of ['owner', 'not-owner', 'unresolved'] as const) {
      expect(mayStartOwnerGeneration(false, ownership)).toBe(true);
    }
  });
});
