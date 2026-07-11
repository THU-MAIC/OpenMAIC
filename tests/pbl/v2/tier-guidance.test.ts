/**
 * Tests for tier-calibrated Instructor guidance selection.
 */
import { describe, it, expect } from 'vitest';
import { tierGuidanceBlock } from '@/lib/pbl/v2/agents/tier-guidance';

describe('PBL v2 — tier guidance', () => {
  it('returns a beginner-specific block for proficiency = beginner', () => {
    const block = tierGuidanceBlock('beginner');
    expect(block).toContain('BEGINNER');
    expect(block).toContain('Pre-explain, then ask');
  });

  it('returns an intermediate-specific block for proficiency = intermediate', () => {
    const block = tierGuidanceBlock('intermediate');
    expect(block).toContain('INTERMEDIATE');
  });

  it('returns an advanced-specific block for proficiency = advanced', () => {
    const block = tierGuidanceBlock('advanced');
    expect(block).toContain('ADVANCED');
    expect(block).toContain('Skip foundational background');
  });

  it('falls back to the no-evidence default (intermediate) for empty proficiency', () => {
    const block = tierGuidanceBlock('');
    expect(block).toContain('INTERMEDIATE');
    expect(block).toBe(tierGuidanceBlock('intermediate'));
  });

  it('always includes the common operational-plan rule', () => {
    for (const p of ['beginner', 'intermediate', 'advanced', ''] as const) {
      expect(tierGuidanceBlock(p)).toContain('concrete operational plan');
    }
  });
});
