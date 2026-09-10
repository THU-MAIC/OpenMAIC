/**
 * A skill is text, and the server reads the structure in it.
 *
 * Skills are written the same way everywhere — the `/` menu inserts
 * `/skill-name ` into the draft and there is no chip, no field and no cap
 * anywhere. Nothing needs to parse that for the AGENT (skills are listed in the
 * system prompt and opened with pi's native `read`), but the session's
 * `skillId` still feeds the outline-constraint pointer. So the server
 * recognises the leading handle and records it, which keeps that guardrail
 * pointed at something without putting a special case back into any composer.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/agent-runtime/config', () => ({
  agentRuntimeConfig: { skillsDir: '/nonexistent' },
}));

import { leadingSkillHandle, skillsNamedInText } from '@/lib/server/agent-runtime/skills';
import type { LoadedSkill } from '@/lib/server/agent-runtime/skills';

describe('the handle a message opens with', () => {
  it('is the leading `/token`', () => {
    expect(leadingSkillHandle('/k12-core-literacy-planning build a lesson')).toBe(
      'k12-core-literacy-planning',
    );
    // What the menu actually writes: handle, trailing space, then nothing yet.
    expect(leadingSkillHandle('/stage-design ')).toBe('stage-design');
    expect(leadingSkillHandle('/stage-design')).toBe('stage-design');
    expect(leadingSkillHandle('/stage-design\nbuild a lesson')).toBe('stage-design');
  });

  it('is only the FIRST one, however many the message mentions', () => {
    // A message may carry several hints — the model reads whichever it needs —
    // but a session has ONE identity, and it is what the user opened with.
    expect(leadingSkillHandle('/stage-design /slide-craft build a lesson')).toBe('stage-design');
  });

  it('is nothing when the message does not open with one', () => {
    expect(leadingSkillHandle('build a lesson /stage-design')).toBeNull();
    expect(leadingSkillHandle('build a lesson')).toBeNull();
    expect(leadingSkillHandle('')).toBeNull();
    // Not a handle: a path, a fraction, a bare slash.
    expect(leadingSkillHandle('/')).toBeNull();
    expect(leadingSkillHandle('/a/b build a lesson')).toBeNull();
  });

  it('tolerates leading whitespace', () => {
    expect(leadingSkillHandle('  /stage-design build a lesson')).toBe('stage-design');
  });
});

/**
 * The SESSION's identity is the leading handle (above). What the user asked to be
 * LOADED is every handle in the message — a different question, so a different
 * function, and `leadingSkillHandle` keeps its one-and-only-at-the-front meaning.
 */
describe('every handle a message names', () => {
  const skill = (id: string, name = id): LoadedSkill => ({
    id,
    name,
    description: `${id}`,
    content: `# ${id}`,
    filePath: `/skills/${id}/SKILL.md`,
    constraints: null,
    source: 'builtin',
  });
  const installed = [skill('stage-design'), skill('slide-craft'), skill('usk_1', 'my-style')];
  const named = (text: string) => skillsNamedInText(text, installed).map((s) => s.id);

  it('finds all of them, in first-appearance order, wherever they sit', () => {
    expect(named('/stage-design /slide-craft build a lesson')).toEqual([
      'stage-design',
      'slide-craft',
    ]);
    expect(named('build a lesson /slide-craft then /stage-design to finish')).toEqual([
      'slide-craft',
      'stage-design',
    ]);
    expect(named('/stage-design\n/slide-craft')).toEqual(['stage-design', 'slide-craft']);
  });

  it('resolves a repeated handle once', () => {
    expect(named('/stage-design again /stage-design')).toEqual(['stage-design']);
  });

  it('matches a user skill by the NAME the menu writes, and reports its id', () => {
    expect(named('/my-style change page three')).toEqual(['usk_1']);
  });

  it('ignores anything that is not an installed handle, and never errors', () => {
    expect(named('/nope build a lesson')).toEqual([]);
    expect(named('look at /a/b and / here')).toEqual([]);
    // A handle glued to punctuation is one token and resolves to nothing — the
    // composer paints no pill on it either.
    expect(named('use /stage-design, thanks')).toEqual([]);
    expect(named('')).toEqual([]);
    expect(skillsNamedInText('/stage-design', [])).toEqual([]);
  });
});
