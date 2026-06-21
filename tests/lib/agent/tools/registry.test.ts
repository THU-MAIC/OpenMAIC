import { describe, expect, it } from 'vitest';

import { buildToolset, V0_ALLOWLIST } from '@/lib/agent/tools/registry';

const deps = {
  aiCall: async () => '',
  getSceneContext: () => undefined,
};

describe('agent toolset registry', () => {
  it('builds the three v0 tools', () => {
    const names = buildToolset(deps)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['read_scene_content', 'regenerate_scene', 'regenerate_scene_actions']);
  });

  it('allowlists exactly the three v0 tools', () => {
    expect(V0_ALLOWLIST.has('read_scene_content')).toBe(true);
    expect(V0_ALLOWLIST.has('regenerate_scene')).toBe(true);
    expect(V0_ALLOWLIST.has('regenerate_scene_actions')).toBe(true);
    expect(V0_ALLOWLIST.has('definitely_not_a_tool')).toBe(false);
  });
});
