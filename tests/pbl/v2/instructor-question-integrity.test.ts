/**
 * Instructor question-integrity guard (false-binary fix).
 *
 * Beta-user finding: the Instructor asked a forced either/or ("会更关注 A 还是
 * B?") on an OPEN analysis task, the learner picked one, and the Instructor then
 * overturned the pick with "actually both matter." The learner felt their answer
 * was set up to be wrong.
 *
 * Root cause was a missing discipline: the prompt layer governed WHEN to ask
 * (questioning cadence) and HOW MUCH to reveal (disclosure ladder) but never the
 * LOGICAL CONSTRUCTION of the question. Worse, the beginner tier rule actively
 * pushed "binary checks" without distinguishing a single-correct comprehension
 * check from an open design/analysis choice.
 *
 * These are prompt-guard tests (the codebase's established pattern, see
 * instructor-base-rules.test.ts / planner-prompt.test.ts): they assert the new
 * discipline is PRESENT and correctly wired into the tier blocks, so it cannot
 * silently regress. True behavioral verification (the model actually stops
 * posing false binaries) is an LLM eval, tracked separately.
 */
import { describe, expect, it } from 'vitest';

import { loadPBLV2Prompt } from '@/lib/pbl/v2/prompts/loader';
import { tierGuidanceBlock } from '@/lib/pbl/v2/agents/tier-guidance';
import type { PBLProficiency } from '@/lib/pbl/v2/types';

describe('instructor base rules — question integrity (no false binary)', () => {
  const md = loadPBLV2Prompt('instructor-base-rules');

  it('has a dedicated question-integrity section', () => {
    expect(md).toContain('Question integrity');
  });

  it('explicitly forbids the false-binary anti-pattern', () => {
    expect(md.toLowerCase()).toContain('false binary');
  });

  it('requires honoring the answer it asked for (no ask-then-overturn)', () => {
    expect(md).toContain('Honor the answer you asked for');
  });

  it('distinguishes a single-correct comprehension check from an open design choice', () => {
    expect(md).toContain('A comprehension check is not a design choice');
  });
});

describe('tier guidance — open analysis must not be a forced either/or', () => {
  const tiers: PBLProficiency[] = ['beginner', 'intermediate', 'advanced'];

  it('applies the open-analysis no-forced-binary rule to EVERY tier (shared rule)', () => {
    // It lives in COMMON_RULES so every tier inherits it — guards against a tier
    // block being authored without it.
    for (const tier of tiers) {
      const block = tierGuidanceBlock(tier);
      expect(block).toContain('open analysis');
      expect(block).toContain('converge on ONE concrete direction');
    }
  });

  it('unset proficiency still carries the rule (falls back to a real tier block)', () => {
    expect(tierGuidanceBlock('')).toContain('converge on ONE concrete direction');
  });

  it("scopes the beginner 'binary check' to a single-correct comprehension check", () => {
    // The beginner rule used to say "ask a binary or fill-in-the-blank check"
    // with no qualifier — which the model over-applied to open content. It must
    // now be explicitly limited to questions that have ONE correct answer.
    const beginner = tierGuidanceBlock('beginner');
    expect(beginner).toContain('ONE correct answer');
  });
});
