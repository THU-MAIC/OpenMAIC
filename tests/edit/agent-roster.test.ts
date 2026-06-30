import { describe, expect, it } from 'vitest';
import { materializeRoster } from '@/lib/edit/agent-roster';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

// ----- helpers ---------------------------------------------------------------

function makeConfig(id: string, role = 'teacher'): GeneratedAgentConfig {
  return {
    id,
    name: id,
    role,
    persona: '',
    avatar: '/avatars/teacher.png',
    color: '#000',
    priority: role === 'teacher' ? 10 : role === 'assistant' ? 7 : 5,
  };
}

/** Deterministic counter-based id factory. */
function makeCounter(): () => string {
  let n = 0;
  return () => `gen-${++n}`;
}

/** Stub resolvePreset backed by an id→config map; returns undefined for unknowns. */
function makeResolver(
  entries: GeneratedAgentConfig[],
): (id: string) => GeneratedAgentConfig | undefined {
  const map = new Map(entries.map((e) => [e.id, e]));
  return (id) => map.get(id);
}

// ----- test cases ------------------------------------------------------------

describe('materializeRoster – (a) generatedAgentConfigs present', () => {
  it('returns existing generatedAgentConfigs array unchanged', () => {
    const configs: GeneratedAgentConfig[] = [
      makeConfig('t1', 'teacher'),
      makeConfig('s1', 'student'),
    ];
    const stage = { generatedAgentConfigs: configs };
    const result = materializeRoster(stage, () => undefined, makeCounter());
    expect(result).toBe(configs); // same reference, not a copy
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('t1');
  });

  it('returns existing configs even when agentIds is also present', () => {
    const configs: GeneratedAgentConfig[] = [makeConfig('t1', 'teacher')];
    const stage = { generatedAgentConfigs: configs, agentIds: ['preset-1'] };
    const result = materializeRoster(
      stage,
      makeResolver([makeConfig('preset-1', 'student')]),
      makeCounter(),
    );
    expect(result).toBe(configs);
  });

  it('returns same reference even for an unusual student-only generatedAgentConfigs (no teacher)', () => {
    // Branch 1 deliberately skips the ≥1-teacher invariant for stored rosters —
    // the editor's last-teacher guard maintains that separately.
    const configs: GeneratedAgentConfig[] = [
      makeConfig('s1', 'student'),
      makeConfig('s2', 'student'),
    ];
    const stage = { generatedAgentConfigs: configs };
    const result = materializeRoster(stage, () => undefined, makeCounter());
    expect(result).toBe(configs); // same reference, no mutation or teacher injection
  });
});

describe('materializeRoster – (b) agentIds resolved via resolvePreset', () => {
  it('assigns fresh ids for global-default preset ids (isGlobalDefault → true)', () => {
    const presets = [makeConfig('a1', 'teacher'), makeConfig('a2', 'student')];
    const stage = { agentIds: ['a1', 'a2'] };
    const result = materializeRoster(stage, makeResolver(presets), makeCounter(), () => true);
    // Global defaults get fresh stage-scoped ids, never the global preset ids
    expect(result.map((r) => r.id)).toEqual(['gen-1', 'gen-2']);
    expect(result.map((r) => r.id)).not.toContain('a1');
    expect(result.map((r) => r.id)).not.toContain('a2');
    // Other fields must be preserved from the resolved preset
    expect(result[0].name).toBe('a1');
    expect(result[0].role).toBe('teacher');
    expect(result[1].name).toBe('a2');
    expect(result[1].role).toBe('student');
  });

  it('keeps original id for stage-generated ids (isGlobalDefault → false)', () => {
    const presets = [makeConfig('gen-abc', 'teacher'), makeConfig('gen-xyz', 'student')];
    const stage = { agentIds: ['gen-abc', 'gen-xyz'] };
    const result = materializeRoster(stage, makeResolver(presets), makeCounter(), () => false);
    // Stage-generated ids are preserved so scene references remain valid
    expect(result.map((r) => r.id)).toEqual(['gen-abc', 'gen-xyz']);
    expect(result[0].name).toBe('gen-abc');
    expect(result[0].role).toBe('teacher');
    expect(result[1].name).toBe('gen-xyz');
    expect(result[1].role).toBe('student');
  });

  it('drops ids that resolve to undefined', () => {
    const presets = [makeConfig('a1', 'teacher')];
    const stage = { agentIds: ['a1', 'unknown-x'] };
    const result = materializeRoster(stage, makeResolver(presets), makeCounter(), () => true);
    // Only the resolved entry survives, with a fresh id (a1 is a global default here)
    expect(result.map((r) => r.id)).toEqual(['gen-1']);
    expect(result[0].name).toBe('a1');
  });
});

describe('materializeRoster – (c) empty stage → single default teacher', () => {
  it('returns a single teacher config when stage has no configs', () => {
    const result = materializeRoster({}, () => undefined, makeCounter());
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('teacher');
    expect(result[0].id).toBe('gen-1');
  });

  it('returns a single teacher config when agentIds is empty array', () => {
    const result = materializeRoster({ agentIds: [] }, () => undefined, makeCounter());
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('teacher');
  });

  it('returns a single teacher config when generatedAgentConfigs is empty array', () => {
    const result = materializeRoster({ generatedAgentConfigs: [] }, () => undefined, makeCounter());
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('teacher');
  });
});

describe('materializeRoster – (d) result always has ≥1 teacher', () => {
  it('resolved presets that include a teacher satisfy the invariant', () => {
    const presets = [makeConfig('t1', 'teacher'), makeConfig('s1', 'student')];
    const stage = { agentIds: ['t1', 's1'] };
    const result = materializeRoster(stage, makeResolver(presets), makeCounter(), () => true);
    const teachers = result.filter((a) => a.role === 'teacher');
    expect(teachers.length).toBeGreaterThanOrEqual(1);
  });

  it('prepends a teacher when resolved presets contain no teacher', () => {
    const presets = [makeConfig('s1', 'student'), makeConfig('s2', 'student')];
    const stage = { agentIds: ['s1', 's2'] };
    const result = materializeRoster(stage, makeResolver(presets), makeCounter(), () => true);
    const teachers = result.filter((a) => a.role === 'teacher');
    expect(teachers.length).toBeGreaterThanOrEqual(1);
  });

  it('empty stage fallback roster always contains a teacher', () => {
    const result = materializeRoster({}, () => undefined, makeCounter());
    expect(result.some((a) => a.role === 'teacher')).toBe(true);
  });
});
