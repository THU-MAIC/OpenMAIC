import { describe, it, expect } from 'vitest';
import { makeAllowlistGate } from '@/lib/agent/runtime/allowlist';

describe('allowlist gate', () => {
  const gate = makeAllowlistGate(new Set(['regenerate_scene_actions']));
  it('allows a listed tool', async () => {
    expect(await gate({ toolCall: { name: 'regenerate_scene_actions' } } as never)).toBeUndefined();
  });
  it('blocks an unlisted tool with a reason', async () => {
    const r = await gate({ toolCall: { name: 'rm_rf' } } as never);
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain('rm_rf');
  });
});
