import { describe, expect, it } from 'vitest';
import { UserSkillError, validateUserSkillInput } from '@/lib/server/agent-runtime/user-skills';

const valid = {
  name: 'my-course-review',
  title: 'Course review',
  description: 'A structured review to run after a course is complete',
  content: 'Check the goals first, then check the evidence.',
};

describe('user Skill validation', () => {
  it('normalizes handle and description without preserving prompt-breaking newlines', () => {
    expect(
      validateUserSkillInput({
        ...valid,
        name: ' MY-Course-Review ',
        description: 'First line\nSecond line',
      }),
    ).toMatchObject({ name: 'my-course-review', description: 'First line Second line' });
  });

  it.each(['review', 'my-double--dash', 'my-trailing-'])('rejects invalid handle %s', (name) => {
    expect(() => validateUserSkillInput({ ...valid, name })).toThrow(UserSkillError);
  });

  it('rejects oversized instructions', () => {
    expect(() => validateUserSkillInput({ ...valid, content: 'a'.repeat(65_537) })).toThrow(
      /64 KiB/,
    );
  });

  it('rejects a NUL in the instructions with the same storability error the patch path uses', () => {
    // Without this the NUL reaches PG, which refuses it as an opaque database
    // error (`invalid byte sequence for encoding "UTF8"`). The create path must
    // share the patch path's clear rejection instead.
    expect(() => validateUserSkillInput({ ...valid, content: 'a\u0000b' })).toThrowError(
      expect.objectContaining({ code: 'unstorable-character' }),
    );
  });

  it('rejects an unpaired surrogate in the instructions instead of storing U+FFFD', () => {
    // PG silently rewrites a lone surrogate to U+FFFD (measured), so without
    // this the user's text would be changed irreversibly at create time.
    expect(() => validateUserSkillInput({ ...valid, content: 'a\ud800b' })).toThrowError(
      expect.objectContaining({ code: 'unpaired-surrogate' }),
    );
  });
});
