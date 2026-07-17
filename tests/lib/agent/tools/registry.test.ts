import { describe, expect, it } from 'vitest';

import { buildToolset, V0_ALLOWLIST } from '@/lib/agent/tools/registry';

const deps = {
  aiCall: async () => '',
  getSceneContext: () => undefined,
};

describe('agent toolset registry', () => {
  it('builds the v0 tools', () => {
    const names = buildToolset(deps)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      'edit_elements',
      'edit_interactive_html',
      'read_scene_content',
      'regenerate_scene',
      'regenerate_scene_actions',
    ]);
  });

  it('allowlists exactly the v0 tools', () => {
    expect(V0_ALLOWLIST.has('read_scene_content')).toBe(true);
    expect(V0_ALLOWLIST.has('regenerate_scene')).toBe(true);
    expect(V0_ALLOWLIST.has('regenerate_scene_actions')).toBe(true);
    expect(V0_ALLOWLIST.has('edit_interactive_html')).toBe(true);
    expect(V0_ALLOWLIST.has('edit_elements')).toBe(true);
    expect(V0_ALLOWLIST.has('definitely_not_a_tool')).toBe(false);
  });
});
