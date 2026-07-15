import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from '@/lib/agent/runtime/build-agent';

describe('buildSystemPrompt capability boundary', () => {
  const prompt = buildSystemPrompt({ id: 's1', title: 'Photosynthesis' }).toLowerCase();

  it('grants reading and slide regeneration', () => {
    expect(prompt).toContain('read_scene_content');
    expect(prompt).toContain('regenerate_scene');
  });

  it('grants interactive-scene bug fixing', () => {
    expect(prompt).toContain('edit_interactive_html');
    expect(prompt).toContain('interactive');
  });

  it('grants per-element slide edits', () => {
    expect(prompt).toContain('edit_elements');
  });

  it('still forbids structural and non-slide edits', () => {
    expect(prompt).toContain('cannot');
    // Structural ops remain out of scope.
    expect(prompt).toMatch(/add|delete|reorder|duplicate/);
  });

  it('embeds the active scene id/title', () => {
    expect(prompt).toContain('s1');
    expect(prompt).toContain('photosynthesis');
  });
});
