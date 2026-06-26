/**
 * Tests for the learner-facing instructor intro selector (avatar hover title).
 *
 * Locks the "show curated description, fall back to nothing when blank/missing"
 * rule. The avatar then renders `agentIntro ?? agentName` as a native `title`,
 * so old projects (which may already carry a description) and new projects both
 * surface the intro, and the cursor never changes.
 */
import { describe, expect, it } from 'vitest';
import { instructorIntroText } from '@/components/scene-renderers/pbl/v2/instructor-intro';

describe('instructorIntroText', () => {
  it('returns the trimmed description when present', () => {
    expect(
      instructorIntroText({ description: '  我是你的向导 Aki，全程陪你做完这个项目。  ' }),
    ).toBe('我是你的向导 Aki，全程陪你做完这个项目。');
  });

  it('returns undefined for blank / whitespace / missing description', () => {
    expect(instructorIntroText({ description: '   ' })).toBeUndefined();
    expect(instructorIntroText({ description: '' })).toBeUndefined();
    expect(instructorIntroText({})).toBeUndefined();
    expect(instructorIntroText(undefined)).toBeUndefined();
    expect(instructorIntroText(null)).toBeUndefined();
  });
});
